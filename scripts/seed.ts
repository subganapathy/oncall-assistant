/**
 * Seed script - populate database with test data.
 *
 * Run with: npm run db:seed
 *
 * Creates sample services that mirror a realistic production setup.
 */

import { pool, close } from "../src/lib/db.js";

async function seed() {
    console.log("🌱 Seeding database with test data...\n");

    // ─────────────────────────────────────────────────────────────
    // SAMPLE SERVICES
    // ─────────────────────────────────────────────────────────────

    const services = [
        {
            name: "user-service",
            team: "payments",
            slack_channel: "#payments-oncall",
            pager_alias: "payments-escalation",
            observability: {
                grafana_uid: "user-service-prod",
                opensearch_index: "prod-user-service-*",
                prometheus_job: "user-service",
                trace_service: "user-service",
            },
            dependencies: [
                { name: "auth-service", type: "internal", critical: true },
                { name: "postgres-users", type: "database", critical: true },
                { name: "redis-sessions", type: "cache", critical: false },
            ],
            deployment: {
                argocd_app: "user-service-prod",
            },
            automation: {
                allowed_actions: ["restart_pod", "scale_up"],
                requires_approval: ["rollback", "scale_down", "modify_config"],
            },
            runbook_path: "/runbooks/user-service/",
        },
        {
            name: "auth-service",
            team: "identity",
            slack_channel: "#identity-oncall",
            pager_alias: "identity-escalation",
            observability: {
                grafana_uid: "auth-service-prod",
                opensearch_index: "prod-auth-service-*",
                prometheus_job: "auth-service",
                trace_service: "auth-service",
            },
            dependencies: [
                { name: "postgres-auth", type: "database", critical: true },
                { name: "redis-tokens", type: "cache", critical: true },
                { name: "okta", type: "external", critical: true, health_endpoint: "https://status.okta.com" },
            ],
            deployment: {
                argocd_app: "auth-service-prod",
            },
            automation: {
                allowed_actions: ["restart_pod"],
                requires_approval: ["rollback", "scale_up", "scale_down"],
            },
            runbook_path: "/runbooks/auth-service/",
        },
        {
            name: "api-gateway",
            team: "platform",
            slack_channel: "#platform-oncall",
            pager_alias: "platform-escalation",
            observability: {
                grafana_uid: "api-gateway-prod",
                opensearch_index: "prod-api-gateway-*",
                prometheus_job: "api-gateway",
                trace_service: "api-gateway",
            },
            dependencies: [
                { name: "user-service", type: "internal", critical: false },
                { name: "auth-service", type: "internal", critical: true },
                { name: "redis-ratelimit", type: "cache", critical: false },
            ],
            deployment: {
                argocd_app: "api-gateway-prod",
            },
            automation: {
                allowed_actions: ["restart_pod", "scale_up", "scale_down"],
                requires_approval: ["rollback", "modify_config"],
            },
            runbook_path: "/runbooks/api-gateway/",
        },
        {
            name: "order-service",
            team: "commerce",
            slack_channel: "#commerce-oncall",
            pager_alias: "commerce-escalation",
            observability: {
                grafana_uid: "order-service-prod",
                opensearch_index: "prod-order-service-*",
                prometheus_job: "order-service",
                trace_service: "order-service",
            },
            dependencies: [
                { name: "user-service", type: "internal", critical: true },
                { name: "postgres-orders", type: "database", critical: true },
                { name: "stripe", type: "external", critical: true, health_endpoint: "https://status.stripe.com" },
                { name: "kafka-orders", type: "internal", critical: true },
            ],
            deployment: {
                argocd_app: "order-service-prod",
            },
            automation: {
                allowed_actions: ["restart_pod"],
                requires_approval: ["rollback", "scale_up", "scale_down", "modify_config"],
            },
            runbook_path: "/runbooks/order-service/",
        },
    ];

    // Insert services
    for (const svc of services) {
        console.log(`  Adding ${svc.name}...`);
        await pool.query(
            `
            INSERT INTO services (
                name, team, slack_channel, pager_alias,
                observability, dependencies, deployment, automation, runbook_path
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (name) DO UPDATE SET
                team = EXCLUDED.team,
                slack_channel = EXCLUDED.slack_channel,
                pager_alias = EXCLUDED.pager_alias,
                observability = EXCLUDED.observability,
                dependencies = EXCLUDED.dependencies,
                deployment = EXCLUDED.deployment,
                automation = EXCLUDED.automation,
                runbook_path = EXCLUDED.runbook_path,
                updated_at = NOW()
            `,
            [
                svc.name,
                svc.team,
                svc.slack_channel,
                svc.pager_alias,
                JSON.stringify(svc.observability),
                JSON.stringify(svc.dependencies),
                JSON.stringify(svc.deployment),
                JSON.stringify(svc.automation),
                svc.runbook_path,
            ]
        );
    }
    console.log(`\n✓ Added ${services.length} services\n`);

    // ─────────────────────────────────────────────────────────────
    // SAMPLE DEPLOYMENTS
    // ─────────────────────────────────────────────────────────────

    console.log("Adding sample deployments...");

    const now = new Date();
    const deployments = [
        {
            service: "user-service",
            version: "v2.3.4",
            previous_version: "v2.3.3",
            deployed_at: new Date(now.getTime() - 15 * 60 * 1000), // 15 min ago
            deployed_by: "alice@company.com",
            status: "success",
            argocd_app: "user-service-prod",
            commit_message: "Fix null pointer in auth handler",
        },
        {
            service: "auth-service",
            version: "v1.8.2",
            previous_version: "v1.8.1",
            deployed_at: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
            deployed_by: "bob@company.com",
            status: "success",
            argocd_app: "auth-service-prod",
            commit_message: "Update token expiry to 24h",
        },
    ];

    for (const deploy of deployments) {
        await pool.query(
            `
            INSERT INTO deployments (
                service, version, previous_version, deployed_at,
                deployed_by, status, argocd_app, commit_message
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
                deploy.service,
                deploy.version,
                deploy.previous_version,
                deploy.deployed_at,
                deploy.deployed_by,
                deploy.status,
                deploy.argocd_app,
                deploy.commit_message,
            ]
        );
    }
    console.log(`✓ Added ${deployments.length} deployments\n`);

    console.log("✅ Seeding complete!");
}

// Run seeding
seed()
    .catch((err) => {
        console.error("❌ Seeding failed:", err);
        process.exit(1);
    })
    .finally(() => {
        close();
    });
