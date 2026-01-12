/**
 * Database connection and utilities.
 *
 * This module provides a connection pool to PostgreSQL.
 * In mock mode, it uses in-memory mock data instead.
 */

import pg from "pg";
const { Pool } = pg;

// ─────────────────────────────────────────────────────────────
// MOCK DATA (used when BACKEND_MODE=mock)
// ─────────────────────────────────────────────────────────────

const MOCK_SERVICES = [
    {
        name: "user-service",
        description: "System of record for user accounts. Handles registration, authentication, and profile management.",
        team: "payments",
        slack_channel: "#payments-oncall",
        pager_alias: "payments-escalation",
        pagerduty_service: "user-service-prod",
        language: "java",
        observability: {
            grafana_dashboard: "https://grafana.internal/d/user-service",
            grafana_uid: "user-service-prod",
            logs_index: "prod-user-service-*",
            opensearch_index: "prod-user-service-*",
            prometheus_job: "user-service",
        },
        dependencies: [
            { name: "auth-service", type: "internal", critical: true },
            { name: "postgres-users", type: "database", critical: true },
        ],
        deployment: {
            repo: "github.com/acme/user-service",
            github_repo: "github.com/acme/user-service",
            gitops_path: "deploy/prod/deployment.yaml",
            deployment_file: "deploy/prod/deployment.yaml",
            argocd_app: "user-service-prod",
            environment: "production",
        },
        automation: {
            allowed_actions: ["restart_pod", "scale_up"],
            requires_approval: ["rollback"],
        },
        runbook_path: "/runbooks/user-service/",
        resources: [
            {
                pattern: "usr-*",
                type: "user-account",
                description: "User account resource. Contains profile, preferences, and auth tokens.",
            },
        ],
    },
    {
        name: "auth-service",
        description: "Authentication and authorization service. Handles login, tokens, and permissions.",
        team: "identity",
        slack_channel: "#identity-oncall",
        pager_alias: "identity-escalation",
        pagerduty_service: "auth-service-prod",
        language: "go",
        observability: {
            grafana_dashboard: "https://grafana.internal/d/auth-service",
            grafana_uid: "auth-service-prod",
            logs_index: "prod-auth-service-*",
            opensearch_index: "prod-auth-service-*",
            prometheus_job: "auth-service",
        },
        dependencies: [
            { name: "postgres-auth", type: "database", critical: true },
        ],
        deployment: {
            repo: "github.com/acme/auth-service",
            github_repo: "github.com/acme/auth-service",
            gitops_path: "deploy/prod/deployment.yaml",
            deployment_file: "deploy/prod/deployment.yaml",
            argocd_app: "auth-service-prod",
            environment: "production",
        },
        automation: {
            allowed_actions: ["restart_pod"],
            requires_approval: ["rollback", "scale_up"],
        },
        runbook_path: "/runbooks/auth-service/",
        resources: [
            {
                pattern: "tok-*",
                type: "auth-token",
                description: "Authentication token. Short-lived, tied to user session.",
            },
            {
                pattern: "sess-*",
                type: "session",
                description: "User session. Tracks login state and refresh tokens.",
            },
        ],
    },
    {
        name: "order-service",
        description: "System of record for customer orders. Handles order lifecycle from creation to fulfillment.",
        team: "commerce",
        slack_channel: "#commerce-oncall",
        pager_alias: "commerce-escalation",
        pagerduty_service: "order-service-prod",
        language: "java",
        observability: {
            grafana_dashboard: "https://grafana.internal/d/order-service",
            logs_index: "prod-order-service-*",
            opensearch_index: "prod-order-service-*",
            prometheus_job: "order-service",
        },
        dependencies: [
            { name: "user-service", type: "internal", critical: true },
            { name: "inventory-service", type: "internal", critical: true },
        ],
        deployment: {
            repo: "github.com/acme/order-service",
            github_repo: "github.com/acme/order-service",
            gitops_path: "deploy/prod/deployment.yaml",
            deployment_file: "deploy/prod/deployment.yaml",
            environment: "production",
        },
        resources: [
            {
                pattern: "ord-*",
                type: "order",
                description: "Customer order. May spawn fulfillment workloads on data plane. Common issues: stuck in PENDING when inventory service is slow.",
            },
        ],
    },
];

// ─────────────────────────────────────────────────────────────
// MODE DETECTION
// ─────────────────────────────────────────────────────────────

function isMockMode(): boolean {
    return process.env.BACKEND_MODE === "mock" ||
           process.env.NODE_ENV === "test" ||
           !!process.env.VITEST;
}

// ─────────────────────────────────────────────────────────────
// CONNECTION POOL (only created in real mode)
// ─────────────────────────────────────────────────────────────

/**
 * Create the database pool.
 * Reads connection info from environment variables.
 *
 * In production, set DATABASE_URL.
 * In development, docker-compose sets individual vars.
 */
export const pool = isMockMode() ? null : new Pool({
    // If DATABASE_URL is set, use it (production pattern)
    connectionString: process.env.DATABASE_URL,

    // Otherwise, use individual vars (docker-compose pattern)
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "oncall",
    user: process.env.PGUSER || "oncall",
    password: process.env.PGPASSWORD || "oncall",

    // Pool settings
    max: 20,                       // Max connections in pool
    idleTimeoutMillis: 30000,      // Close idle connections after 30s
    connectionTimeoutMillis: 2000,  // Fail fast if can't connect
});

// Log connection errors (don't crash, just log)
if (pool) {
    pool.on("error", (err) => {
        console.error("Unexpected database error:", err);
    });
}

// ─────────────────────────────────────────────────────────────
// MOCK QUERY IMPLEMENTATION
// ─────────────────────────────────────────────────────────────

function mockQuery<T>(text: string, params?: unknown[]): T[] {
    // Handle services table queries
    if (text.includes("FROM services")) {
        // Handle resources IS NOT NULL filter
        if (text.includes("resources IS NOT NULL")) {
            return MOCK_SERVICES.filter((s) => s.resources && s.resources.length > 0) as T[];
        }
        // Handle team or name filter
        if (params?.[0]) {
            return MOCK_SERVICES.filter(
                (s) => s.name === params[0] || s.team === params[0]
            ) as T[];
        }
        return MOCK_SERVICES as T[];
    }
    return [];
}

// ─────────────────────────────────────────────────────────────
// QUERY HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Execute a query and return rows.
 *
 * Usage:
 *   const services = await query<ServiceCatalog>(
 *     "SELECT * FROM services WHERE team = $1",
 *     ["payments"]
 *   );
 */
export async function query<T>(
    text: string,
    params?: unknown[]
): Promise<T[]> {
    if (isMockMode()) {
        return mockQuery<T>(text, params);
    }
    const result = await pool!.query(text, params);
    return result.rows as T[];
}

/**
 * Execute a query and return first row (or null).
 *
 * Usage:
 *   const service = await queryOne<ServiceCatalog>(
 *     "SELECT * FROM services WHERE name = $1",
 *     ["user-service"]
 *   );
 */
export async function queryOne<T>(
    text: string,
    params?: unknown[]
): Promise<T | null> {
    const rows = await query<T>(text, params);
    return rows[0] || null;
}

/**
 * Execute a query that doesn't return data (INSERT, UPDATE, DELETE).
 *
 * Usage:
 *   await execute(
 *     "UPDATE services SET updated_at = NOW() WHERE name = $1",
 *     ["user-service"]
 *   );
 */
export async function execute(
    text: string,
    params?: unknown[]
): Promise<void> {
    if (isMockMode()) {
        return; // No-op in mock mode
    }
    await pool!.query(text, params);
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────

/**
 * Check if database is reachable.
 * Used by health check endpoints.
 */
export async function checkHealth(): Promise<boolean> {
    if (isMockMode()) {
        return true; // Always healthy in mock mode
    }
    try {
        await pool!.query("SELECT 1");
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

/**
 * Close all connections.
 * Call this when shutting down the server.
 */
export async function close(): Promise<void> {
    if (pool) {
        await pool.end();
    }
}
