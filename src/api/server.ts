/**
 * Catalog REST API Server
 *
 * This provides HTTP endpoints for managing the service catalog.
 * Used by:
 * - GitHub Actions (to update catalog on PR merge)
 * - ArgoCD webhooks (to record deployments)
 * - Admin tools (to manually update entries)
 *
 * Run with: npm run dev:api
 */

import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { query, queryOne, execute, checkHealth, close } from "../lib/db.js";
import { backends } from "../lib/backends/index.js";
import type { ServiceCatalog } from "../lib/types.js";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────

/**
 * Simple API key authentication.
 * In production, use proper auth (JWT, OAuth, etc.)
 */
function authenticate(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers["x-api-key"];

    // Skip auth in development
    if (process.env.NODE_ENV === "development") {
        return next();
    }

    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    next();
}

/**
 * Error handling wrapper for async routes.
 */
function asyncHandler(
    fn: (req: Request, res: Response) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        fn(req, res).catch(next);
    };
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────

app.get("/health", asyncHandler(async (_req, res) => {
    const dbHealthy = await checkHealth();

    if (dbHealthy) {
        res.json({ status: "healthy", database: "connected" });
    } else {
        res.status(503).json({ status: "unhealthy", database: "disconnected" });
    }
}));

// ─────────────────────────────────────────────────────────────
// SERVICES CRUD
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/services
 * List all services (optionally filter by team)
 */
app.get("/api/services", asyncHandler(async (req, res) => {
    const { team } = req.query;

    let rows: ServiceCatalog[];
    if (team) {
        rows = await query<ServiceCatalog>(
            "SELECT * FROM services WHERE team = $1 ORDER BY name",
            [team]
        );
    } else {
        rows = await query<ServiceCatalog>(
            "SELECT * FROM services ORDER BY name"
        );
    }

    res.json({ count: rows.length, services: rows });
}));

/**
 * GET /api/services/:name
 * Get a single service by name
 */
app.get("/api/services/:name", asyncHandler(async (req, res) => {
    const { name } = req.params;

    const row = await queryOne<ServiceCatalog>(
        "SELECT * FROM services WHERE name = $1",
        [name]
    );

    if (!row) {
        res.status(404).json({ error: `Service '${name}' not found` });
        return;
    }

    res.json(row);
}));

/**
 * POST /api/services
 * Create a new service
 */
app.post("/api/services", authenticate, asyncHandler(async (req, res) => {
    const {
        name,
        team,
        slack_channel,
        pager_alias,
        observability = {},
        dependencies = [],
        deployment = {},
        automation = { allowed_actions: [], requires_approval: [] },
        runbook_path,
    } = req.body;

    // Validate required fields
    if (!name || !team || !slack_channel || !pager_alias) {
        res.status(400).json({
            error: "Missing required fields",
            required: ["name", "team", "slack_channel", "pager_alias"],
        });
        return;
    }

    await execute(
        `INSERT INTO services (
            name, team, slack_channel, pager_alias,
            observability, dependencies, deployment, automation, runbook_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            name,
            team,
            slack_channel,
            pager_alias,
            JSON.stringify(observability),
            JSON.stringify(dependencies),
            JSON.stringify(deployment),
            JSON.stringify(automation),
            runbook_path,
        ]
    );

    res.status(201).json({ message: "Service created", name });
}));

/**
 * PATCH /api/services/:name
 * Update a service (partial update)
 *
 * This is what GitHub Actions calls to update specific fields.
 */
app.patch("/api/services/:name", authenticate, asyncHandler(async (req, res) => {
    const { name } = req.params;
    const updates = req.body;

    // Check service exists
    const existing = await queryOne<ServiceCatalog>(
        "SELECT * FROM services WHERE name = $1",
        [name]
    );

    if (!existing) {
        res.status(404).json({ error: `Service '${name}' not found` });
        return;
    }

    // Build dynamic update query
    const allowedFields = [
        "team",
        "slack_channel",
        "pager_alias",
        "observability",
        "dependencies",
        "deployment",
        "automation",
        "runbook_path",
    ];

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
        if (field in updates) {
            let value = updates[field];

            // JSON fields need stringification
            if (["observability", "dependencies", "deployment", "automation"].includes(field)) {
                value = JSON.stringify(value);
            }

            setClauses.push(`${field} = $${paramIndex}`);
            values.push(value);
            paramIndex++;
        }
    }

    if (setClauses.length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
    }

    values.push(name);  // For WHERE clause

    await execute(
        `UPDATE services SET ${setClauses.join(", ")} WHERE name = $${paramIndex}`,
        values
    );

    res.json({ message: "Service updated", name });
}));

/**
 * DELETE /api/services/:name
 * Delete a service
 */
app.delete("/api/services/:name", authenticate, asyncHandler(async (req, res) => {
    const { name } = req.params;

    await execute("DELETE FROM services WHERE name = $1", [name]);

    res.json({ message: "Service deleted", name });
}));

// ─────────────────────────────────────────────────────────────
// DEPLOYMENTS (Query GitHub-based GitOps)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/deployments/:service
 * Get recent deployments via GitOps (GitHub).
 * Tracks deployments through deployment.yaml in service repos.
 */
app.get("/api/deployments/:service", asyncHandler(async (req, res) => {
    const { service } = req.params;
    const limit = parseInt(req.query.limit as string) || 5;

    // Get deployment config from catalog
    const row = await queryOne<{
        deployment: { github_repo: string; deployment_file: string; environment: string };
    }>(
        "SELECT deployment FROM services WHERE name = $1",
        [service]
    );

    if (!row) {
        res.status(404).json({ error: `Service '${service}' not found` });
        return;
    }

    if (!row.deployment?.github_repo) {
        res.status(400).json({ error: `Service '${service}' has no deployment config` });
        return;
    }

    // Query deployment history from GitHub
    const deploys = await backends.deployments.getRecentDeploys(service, limit);
    const currentDeploy = await backends.deployments.getCurrentDeployment(service);

    res.json({
        service,
        github_repo: row.deployment.github_repo,
        environment: row.deployment.environment,
        current_version: currentDeploy?.version,
        current_status: currentDeploy?.status,
        deployments: deploys,
    });
}));

// ─────────────────────────────────────────────────────────────
// WEBHOOKS (for GitOps catalog updates)
// ─────────────────────────────────────────────────────────────

/**
 * POST /webhooks/github
 * Handle GitHub webhooks when service.yaml changes.
 *
 * This is how services get auto-registered/updated in the catalog.
 * When a team updates their service.yaml and merges to main,
 * GitHub sends this webhook, and we update our catalog.
 *
 * NOTE: ArgoCD webhook is NOT needed - we query ArgoCD API at runtime.
 */
app.post("/webhooks/github", asyncHandler(async (req, res) => {
    // Verify GitHub signature
    const signature = req.headers["x-hub-signature-256"] as string;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (secret && signature) {
        const expectedSignature = "sha256=" + crypto
            .createHmac("sha256", secret)
            .update(JSON.stringify(req.body))
            .digest("hex");

        if (!crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
        )) {
            res.status(401).json({ error: "Invalid signature" });
            return;
        }
    }

    const event = req.headers["x-github-event"];
    const payload = req.body;

    console.log(`[GitHub Webhook] Event: ${event}`);

    // Handle push events (when service.yaml changes on main)
    if (event === "push" && payload.ref === "refs/heads/main") {
        // Check if service.yaml was modified
        const commits = payload.commits || [];
        const serviceYamlChanged = commits.some((commit: { modified?: string[]; added?: string[] }) =>
            commit.modified?.includes("service.yaml") ||
            commit.added?.includes("service.yaml")
        );

        if (serviceYamlChanged) {
            console.log(`  service.yaml changed in ${payload.repository?.full_name}`);

            // In production: fetch service.yaml from GitHub API and upsert to catalog
            // const serviceConfig = await fetchServiceYaml(payload.repository.full_name);
            // await upsertService(serviceConfig);

            res.json({
                received: true,
                action: "catalog_update_triggered",
                repo: payload.repository?.full_name,
            });
            return;
        }
    }

    res.json({ received: true, action: "ignored" });
}));

// ─────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API Error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000");

const server = app.listen(PORT, () => {
    console.log(`Catalog API server running on http://localhost:${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  GET  /health                  - Health check`);
    console.log(`  GET  /api/services            - List all services`);
    console.log(`  GET  /api/services/:name      - Get service by name`);
    console.log(`  POST /api/services            - Create service`);
    console.log(`  PATCH /api/services/:name     - Update service`);
    console.log(`  GET  /api/deployments/:service - Get deploys (queries GitHub)`);
    console.log(`  POST /webhooks/github         - GitHub webhook for service.yaml changes`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("Shutting down...");
    server.close(() => {
        close().then(() => process.exit(0));
    });
});
