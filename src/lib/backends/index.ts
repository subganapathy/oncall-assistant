/**
 * Backend configuration.
 *
 * Creates real or mock backends based on environment.
 *
 * SIMPLIFIED ARCHITECTURE:
 * - Prometheus (metrics + runtime metrics check)
 * - OpenSearch (logs)
 * - Kubernetes (pod status)
 * - GitHub (deployments via GitOps)
 * - AWS (CloudWatch + Health API)
 *
 * Usage:
 *   import { backends } from "./lib/backends/index.js";
 *   const metrics = await backends.metrics.getServiceMetrics("user-service", "user-service");
 *   const deploys = await backends.deployments.getRecentDeploys("user-service");
 *   const awsHealth = await backends.aws.getHealthEvents(["rds"], ["us-east-1"]);
 */

import type { Backends } from "./types.js";
import { PrometheusBackend } from "./prometheus.js";
import { OpenSearchBackend } from "./opensearch.js";
import { KubectlBackend, KubernetesApiBackend } from "./kubernetes.js";
import { GitHubDeploymentBackend } from "./github.js";
import { CloudWatchBackend } from "./aws.js";
import { createMockBackends } from "./mock.js";

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────

export type BackendMode = "real" | "mock";

function getMode(): BackendMode {
    if (process.env.BACKEND_MODE === "mock") return "mock";
    if (process.env.BACKEND_MODE === "real") return "real";
    if (process.env.NODE_ENV === "test") return "mock";
    if (process.env.VITEST) return "mock";
    return "real";
}

// ─────────────────────────────────────────────────────────────
// CREATE BACKENDS
// ─────────────────────────────────────────────────────────────

function createRealBackends(): Backends {
    // Metrics: Prometheus (with runtime metrics checking)
    const metrics = new PrometheusBackend({
        url: process.env.PROMETHEUS_URL || "http://localhost:9090",
        apiKey: process.env.PROMETHEUS_API_KEY,
    });

    // Logs: OpenSearch
    const logs = new OpenSearchBackend({
        url: process.env.OPENSEARCH_URL || "http://localhost:9200",
        username: process.env.OPENSEARCH_USERNAME,
        password: process.env.OPENSEARCH_PASSWORD,
    });

    // Kubernetes: prefer API if configured, else kubectl
    let kubernetes;
    if (process.env.KUBERNETES_API_URL && process.env.KUBERNETES_TOKEN) {
        kubernetes = new KubernetesApiBackend({
            url: process.env.KUBERNETES_API_URL,
            token: process.env.KUBERNETES_TOKEN,
        });
    } else {
        kubernetes = new KubectlBackend({
            context: process.env.KUBERNETES_CONTEXT,
            kubeconfig: process.env.KUBECONFIG,
        });
    }

    // Deployments: GitHub (GitOps-based)
    const deployments = new GitHubDeploymentBackend({
        token: process.env.GITHUB_TOKEN || "",
    });

    // AWS: CloudWatch + Health API
    const aws = new CloudWatchBackend({
        region: process.env.AWS_REGION,
    });

    return { metrics, logs, kubernetes, deployments, aws };
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

const mode = getMode();

export const backends: Backends = mode === "mock"
    ? createMockBackends()
    : createRealBackends();

export function getBackendMode(): BackendMode {
    return mode;
}

export * from "./types.js";
