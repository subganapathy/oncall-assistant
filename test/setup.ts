/**
 * Test setup - runs before all tests.
 *
 * Sets up mocks for database and ensures mock backends are used.
 */

import { vi, beforeEach } from "vitest";

// Force mock backend mode
process.env.BACKEND_MODE = "mock";
process.env.NODE_ENV = "test";

// ─────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────

export const mockData = {
    services: [
        {
            name: "user-service",
            description: "System of record for user accounts. Handles registration, authentication, and profile management.",
            team: "payments",
            slack_channel: "#payments-oncall",
            pager_alias: "payments-escalation",
            pagerduty_service: "user-service-prod",
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
            observability: {
                grafana_dashboard: "https://grafana.internal/d/order-service",
                logs_index: "prod-order-service-*",
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
    ],
    deployments: [
        {
            service: "user-service",
            version: "v2.3.4",
            previous_version: "v2.3.3",
            deployed_at: new Date(Date.now() - 15 * 60 * 1000),
            deployed_by: "alice@company.com",
            status: "success",
            argocd_app: "user-service-prod",
            commit_message: "Fix null pointer",
        },
    ],
};

// ─────────────────────────────────────────────────────────────
// MOCK DATABASE
// ─────────────────────────────────────────────────────────────

vi.mock("../src/lib/db.js", () => ({
    query: vi.fn(async (text: string, params?: unknown[]) => {
        if (text.includes("FROM services")) {
            // Handle resources IS NOT NULL filter
            if (text.includes("resources IS NOT NULL")) {
                return mockData.services.filter((s) => s.resources && s.resources.length > 0);
            }
            // Handle team or name filter
            if (params?.[0]) {
                return mockData.services.filter(
                    (s) => s.name === params[0] || s.team === params[0]
                );
            }
            return mockData.services;
        }
        if (text.includes("FROM deployments")) {
            if (params?.[0]) {
                return mockData.deployments.filter((d) => d.service === params[0]);
            }
            return mockData.deployments;
        }
        return [];
    }),

    queryOne: vi.fn(async (text: string, params?: unknown[]) => {
        if (text.includes("FROM services") && params?.[0]) {
            return mockData.services.find((s) => s.name === params[0]) || null;
        }
        if (text.includes("FROM deployments") && params?.[0]) {
            return mockData.deployments.find((d) => d.service === params[0]) || null;
        }
        return null;
    }),

    execute: vi.fn(async () => {}),

    checkHealth: vi.fn(async () => true),

    close: vi.fn(async () => {}),

    pool: {
        query: vi.fn(),
        end: vi.fn(),
    },
}));

// ─────────────────────────────────────────────────────────────
// RESET MOCKS BETWEEN TESTS
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
});
