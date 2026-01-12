/**
 * Diagnostic tools - check service health, deploys, logs.
 *
 * These are the "table stakes" tools the agent uses to
 * understand what's happening during an incident.
 */

import { z } from "zod";
import { queryOne } from "../lib/db.js";
import { backends } from "../lib/backends/index.js";
import type { ServiceHealth, ServiceCatalog, AppLanguage, Dependency } from "../lib/types.js";
import { DEFAULT_THRESHOLDS, LOG_PATTERNS_BY_LANGUAGE, COMMON_LOG_PATTERNS } from "../lib/types.js";

// ─────────────────────────────────────────────────────────────
// TOOL: get_service_health
// ─────────────────────────────────────────────────────────────

export const getServiceHealthSchema = {
    service: z.string().describe("Service name"),
    region: z.string().optional().describe("Specific region (e.g., us-east-1)"),
};

/**
 * Get current health metrics for a service.
 */
export async function getServiceHealth(
    input: { service: string; region?: string }
): Promise<string> {
    // Get service's observability config from catalog
    const row = await queryOne<{
        observability: { prometheus_job?: string };
    }>(
        `SELECT observability FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    const prometheusJob = row.observability.prometheus_job || input.service;

    // Query metrics from backend (real Prometheus or mock)
    const metrics = await backends.metrics.getServiceMetrics(
        input.service,
        prometheusJob,
        input.region
    );

    // Determine status based on thresholds
    let status: "healthy" | "degraded" | "critical" = "healthy";
    if (metrics.error_rate > 0.05 || metrics.availability < 0.95) {
        status = "critical";
    } else if (
        metrics.error_rate > DEFAULT_THRESHOLDS.error_rate ||
        metrics.availability < DEFAULT_THRESHOLDS.availability
    ) {
        status = "degraded";
    }

    const health: ServiceHealth = {
        service: input.service,
        timestamp: new Date(),
        error_rate: metrics.error_rate,
        p50_latency: metrics.p50_latency,
        p99_latency: metrics.p99_latency,
        availability: metrics.availability,
        request_rate: metrics.request_rate,
        status,
    };

    return JSON.stringify(health, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_recent_deploys
// ─────────────────────────────────────────────────────────────

export const getRecentDeploysSchema = {
    service: z.string().describe("Service name"),
    limit: z.number().default(5).describe("Number of deploys to return"),
    since_hours: z.number().optional().describe("Only deploys in last N hours"),
};

/**
 * Get recent deployments for a service via GitOps (GitHub).
 * Tracks deployments through deployment.yaml in the service repo.
 */
export async function getRecentDeploys(
    input: { service: string; limit?: number; since_hours?: number }
): Promise<string> {
    // Get service's deployment config from catalog
    const row = await queryOne<{
        deployment: { github_repo: string; deployment_file: string; environment: string };
    }>(
        `SELECT deployment FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    // Query deployment history from GitHub
    const deploys = await backends.deployments.getRecentDeploys(
        input.service,
        input.limit || 5
    );

    // Filter by time if since_hours is specified
    let filteredDeploys = deploys;
    if (input.since_hours) {
        const cutoff = Date.now() - (input.since_hours * 60 * 60 * 1000);
        filteredDeploys = deploys.filter(
            (d) => new Date(d.deployed_at).getTime() > cutoff
        );
    }

    if (filteredDeploys.length === 0) {
        return JSON.stringify({
            service: input.service,
            github_repo: row.deployment.github_repo,
            message: "No recent deployments found",
            deploys: [],
        });
    }

    // Calculate time since last deploy
    const lastDeploy = filteredDeploys[0];
    const minutesAgo = Math.floor(
        (Date.now() - new Date(lastDeploy.deployed_at).getTime()) / 60000
    );

    // Get current deployment status
    const currentDeploy = await backends.deployments.getCurrentDeployment(input.service);

    return JSON.stringify({
        service: input.service,
        github_repo: row.deployment.github_repo,
        environment: row.deployment.environment,
        last_deploy_minutes_ago: minutesAgo,
        recent_deploy_warning: minutesAgo < 60,
        current_version: currentDeploy?.version,
        current_status: currentDeploy?.status,
        deploys: filteredDeploys.map((d) => ({
            version: d.version,
            previous_version: d.previous_version,
            commit_sha: d.commit_sha,
            commit_message: d.commit_message,
            deployed_at: d.deployed_at,
            deployed_by: d.deployed_by,
            status: d.status,
        })),
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: query_logs
// ─────────────────────────────────────────────────────────────

export const queryLogsSchema = {
    service: z.string().describe("Service name"),
    query: z.string().optional().describe("Search query (e.g., 'NullPointerException')"),
    level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Log level filter"),
    since: z.string().default("15m").describe("Time range (e.g., '15m', '1h', '1d')"),
    limit: z.number().default(100).describe("Max log lines to return"),
};

/**
 * Search logs in OpenSearch.
 */
export async function queryLogs(
    input: {
        service: string;
        query?: string;
        level?: string;
        since?: string;
        limit?: number;
    }
): Promise<string> {
    // Get service's log index from catalog
    const row = await queryOne<{
        observability: { opensearch_index: string };
    }>(
        `SELECT observability FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    const index = row.observability.opensearch_index;

    // Query logs from backend (real OpenSearch or mock)
    const result = await backends.logs.queryLogs(index, {
        query: input.query,
        level: input.level,
        since: input.since,
        limit: input.limit,
    });

    return JSON.stringify({
        service: input.service,
        index: index,
        query: input.query || "*",
        level_filter: input.level || "all",
        time_range: input.since,
        total_hits: result.total_hits,
        logs: result.logs,
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_pod_status
// ─────────────────────────────────────────────────────────────

export const getPodStatusSchema = {
    service: z.string().describe("Service name"),
    namespace: z.string().default("production").describe("Kubernetes namespace"),
};

/**
 * Get current pod status from Kubernetes.
 */
export async function getPodStatus(
    input: { service: string; namespace?: string }
): Promise<string> {
    const namespace = input.namespace || "production";

    // Query pods from backend (real kubectl/K8s API or mock)
    const result = await backends.kubernetes.getPods(input.service, namespace);

    const unhealthyPods = result.pods.filter(
        (p) => p.status !== "Running" || p.restarts > 5
    );

    return JSON.stringify({
        service: input.service,
        namespace: namespace,
        total_pods: result.pods.length,
        healthy_pods: result.pods.length - unhealthyPods.length,
        unhealthy_pods: unhealthyPods.length,
        pods: result.pods,
        warning: unhealthyPods.length > 0 ? "Some pods are unhealthy" : null,
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: check_dependency_health
// ─────────────────────────────────────────────────────────────

export const checkDependencyHealthSchema = {
    service: z.string().describe("Service name to check dependencies for"),
};

/**
 * Check health of all dependencies for a service.
 * Handles internal services, AWS resources, and external APIs.
 */
export async function checkDependencyHealth(
    input: { service: string }
): Promise<string> {
    // Get service dependencies from catalog
    const row = await queryOne<{ dependencies: Dependency[] }>(
        `SELECT dependencies FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    // Check health of each dependency based on type
    const results = await Promise.all(
        row.dependencies.map(async (dep) => {
            if (dep.type === "internal") {
                // Internal service: query Prometheus metrics
                const metrics = await backends.metrics.getServiceMetrics(
                    dep.name,
                    dep.name
                );

                const status = metrics.error_rate > 0.01 || metrics.availability < 0.99
                    ? "unhealthy"
                    : "healthy";

                return {
                    name: dep.name,
                    type: dep.type,
                    critical: dep.critical,
                    status,
                    error_rate: metrics.error_rate,
                    p99_latency: metrics.p99_latency,
                    availability: metrics.availability,
                };
            } else if (dep.type === "aws") {
                // AWS resource: query CloudWatch metrics
                const awsDep = dep as {
                    name: string;
                    type: "aws";
                    aws_service: "rds" | "sqs" | "sns" | "elasticache" | "dynamodb" | "s3" | "lambda" | "elb";
                    aws_resource_id: string;
                    aws_region: string;
                    critical: boolean;
                };

                const resourceMetrics = await backends.aws.getResourceMetrics(
                    awsDep.aws_service,
                    awsDep.aws_resource_id,
                    awsDep.aws_region
                );

                return {
                    name: dep.name,
                    type: dep.type,
                    critical: dep.critical,
                    aws_service: awsDep.aws_service,
                    aws_resource_id: awsDep.aws_resource_id,
                    aws_region: awsDep.aws_region,
                    status: resourceMetrics.status,
                    metrics: resourceMetrics.metrics,
                    last_updated: resourceMetrics.last_updated,
                };
            } else if (dep.type === "external") {
                // External API: check health endpoint if available
                const extDep = dep as {
                    name: string;
                    type: "external";
                    health_endpoint?: string;
                    critical: boolean;
                };

                if (extDep.health_endpoint) {
                    try {
                        const response = await fetch(extDep.health_endpoint, {
                            signal: AbortSignal.timeout(5000), // 5s timeout
                        });
                        return {
                            name: dep.name,
                            type: dep.type,
                            critical: dep.critical,
                            status: response.ok ? "healthy" : "unhealthy",
                            status_page: extDep.health_endpoint,
                            http_status: response.status,
                        };
                    } catch (error) {
                        return {
                            name: dep.name,
                            type: dep.type,
                            critical: dep.critical,
                            status: "unknown",
                            status_page: extDep.health_endpoint,
                            error: error instanceof Error ? error.message : "Could not reach status page",
                        };
                    }
                }

                return {
                    name: dep.name,
                    type: dep.type,
                    critical: dep.critical,
                    status: "unknown",
                    note: "No health endpoint configured",
                };
            }

            return {
                name: dep.name,
                type: dep.type,
                critical: dep.critical,
                status: "unknown",
            };
        })
    );

    const unhealthy = results.filter((r) => r.status !== "healthy");
    const criticalUnhealthy = unhealthy.filter((r) => r.critical);

    return JSON.stringify({
        service: input.service,
        dependencies_checked: results.length,
        all_healthy: unhealthy.length === 0,
        critical_issues: criticalUnhealthy.length,
        results: results,
        summary: criticalUnhealthy.length > 0
            ? `CRITICAL: ${criticalUnhealthy.map((r) => r.name).join(", ")} unhealthy`
            : unhealthy.length > 0
                ? `WARNING: ${unhealthy.map((r) => r.name).join(", ")} unhealthy (non-critical)`
                : "All dependencies healthy",
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: scan_log_patterns
// ─────────────────────────────────────────────────────────────

export const scanLogPatternsSchema = {
    service: z.string().describe("Service name"),
    since: z.string().default("1h").describe("Time range (e.g., '15m', '1h', '1d')"),
    include_common: z.boolean().default(true).describe("Include common infra patterns (OOMKilled, etc.)"),
};

/**
 * Scan logs for known error patterns based on service language.
 * Automatically uses language-specific patterns (Java OOM, Go panics, etc.)
 * plus common infrastructure patterns.
 */
export async function scanLogPatterns(
    input: { service: string; since?: string; include_common?: boolean }
): Promise<string> {
    // Get service info from catalog
    const row = await queryOne<{
        language: AppLanguage;
        observability: { opensearch_index: string; log_patterns?: { custom_errors?: Array<{ name: string; pattern: string; severity: string; description: string }> } };
    }>(
        `SELECT language, observability FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    const index = row.observability.opensearch_index;
    const language = row.language || "unknown";

    // Build pattern list
    const patterns = [
        // Language-specific patterns
        ...(LOG_PATTERNS_BY_LANGUAGE[language] || []),
        // Common infra patterns (if requested)
        ...(input.include_common !== false ? COMMON_LOG_PATTERNS : []),
        // Custom service-specific patterns
        ...(row.observability.log_patterns?.custom_errors || []),
    ];

    if (patterns.length === 0) {
        return JSON.stringify({
            service: input.service,
            language,
            message: "No patterns configured for this language",
            matches: [],
        });
    }

    // Scan logs for patterns
    const result = await backends.logs.scanForPatterns(
        index,
        patterns,
        input.since || "1h"
    );

    return JSON.stringify({
        service: input.service,
        language,
        index,
        time_range: input.since || "1h",
        scanned_logs: result.scanned_logs,
        summary: result.summary,
        has_critical: result.summary.critical_count > 0,
        matches: result.matches,
        recommendation: result.summary.critical_count > 0
            ? "CRITICAL patterns found - immediate investigation required"
            : result.summary.warning_count > 0
                ? "Warning patterns found - review recommended"
                : "No concerning patterns found",
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_pod_logs
// ─────────────────────────────────────────────────────────────

export const getPodLogsSchema = {
    service: z.string().describe("Service name"),
    namespace: z.string().default("production").describe("Kubernetes namespace"),
    cluster: z.string().describe("Cluster name (kubectl context)"),
    pod: z.string().optional().describe("Specific pod name (if not provided, gets logs from first pod)"),
    tail: z.number().default(100).describe("Number of log lines to fetch"),
    since: z.string().optional().describe("Time range (e.g., '5m', '1h')"),
    previous: z.boolean().default(false).describe("Get logs from previous (crashed) container"),
    container: z.string().optional().describe("Container name (for multi-container pods)"),
};

/**
 * Get logs directly from a Kubernetes pod.
 * Useful for real-time logs when OpenSearch has indexing delay,
 * or for crash logs from terminated containers.
 */
export async function getPodLogs(
    input: {
        service: string;
        namespace?: string;
        cluster: string;
        pod?: string;
        tail?: number;
        since?: string;
        previous?: boolean;
        container?: string;
    }
): Promise<string> {
    const namespace = input.namespace || "production";

    // If no specific pod, get list and use first one
    let podName = input.pod;
    if (!podName) {
        const pods = await backends.kubernetes.getPods(input.service, namespace);
        if (pods.pods.length === 0) {
            return JSON.stringify({
                error: `No pods found for service '${input.service}' in namespace '${namespace}'`,
            });
        }
        // Prefer a pod with restarts if looking for crash logs
        if (input.previous) {
            const crashedPod = pods.pods.find(p => p.restarts > 0);
            podName = crashedPod?.name || pods.pods[0].name;
        } else {
            podName = pods.pods[0].name;
        }
    }

    // Get logs from pod
    const result = await backends.kubernetes.getPodLogs(
        podName,
        namespace,
        input.cluster,
        {
            tail: input.tail || 100,
            since: input.since,
            previous: input.previous || false,
            container: input.container,
        }
    );

    if (result.error) {
        return JSON.stringify({
            service: input.service,
            pod: podName,
            namespace,
            cluster: input.cluster,
            error: result.error,
        });
    }

    // Analyze logs for obvious errors
    const logLines = result.logs.split("\n");
    const errorLines = logLines.filter(line =>
        /error|exception|panic|fatal|failed|crash/i.test(line)
    );

    return JSON.stringify({
        service: input.service,
        pod: podName,
        namespace,
        cluster: input.cluster,
        container: result.container,
        from_previous_container: result.from_previous,
        truncated: result.truncated,
        total_lines: logLines.length,
        error_lines_found: errorLines.length,
        logs: result.logs,
        error_summary: errorLines.length > 0
            ? errorLines.slice(0, 5)  // First 5 error lines
            : null,
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: check_aws_health
// ─────────────────────────────────────────────────────────────

export const checkAwsHealthSchema = {
    service: z.string().optional().describe("Service name (to check its AWS dependencies)"),
    aws_services: z.array(z.enum([
        "rds", "sqs", "sns", "elasticache", "dynamodb", "s3", "lambda", "elb", "ecs", "eks"
    ])).optional().describe("Specific AWS services to check"),
    regions: z.array(z.string()).optional().describe("Specific regions to check (e.g., ['us-east-1'])"),
};

/**
 * Check AWS Health API for active outages.
 * Can check specific services/regions or all AWS dependencies of a service.
 */
export async function checkAwsHealth(
    input: {
        service?: string;
        aws_services?: Array<"rds" | "sqs" | "sns" | "elasticache" | "dynamodb" | "s3" | "lambda" | "elb" | "ecs" | "eks">;
        regions?: string[];
    }
): Promise<string> {
    let servicesToCheck = input.aws_services;
    let regionsToCheck = input.regions;

    // If service provided, get its AWS dependencies
    if (input.service) {
        const row = await queryOne<{ dependencies: Dependency[] }>(
            `SELECT dependencies FROM services WHERE name = $1`,
            [input.service]
        );

        if (!row) {
            return JSON.stringify({ error: `Service '${input.service}' not found` });
        }

        // Extract AWS dependencies
        const awsDeps = row.dependencies.filter(d => d.type === "aws") as Array<{
            aws_service: "rds" | "sqs" | "sns" | "elasticache" | "dynamodb" | "s3" | "lambda" | "elb";
            aws_region: string;
        }>;

        if (awsDeps.length === 0) {
            return JSON.stringify({
                service: input.service,
                message: "No AWS dependencies configured for this service",
                has_active_events: false,
                events: [],
            });
        }

        servicesToCheck = [...new Set(awsDeps.map(d => d.aws_service))];
        regionsToCheck = [...new Set(awsDeps.map(d => d.aws_region))];
    }

    // Query AWS Health API
    const healthResult = await backends.aws.getHealthEvents(
        servicesToCheck,
        regionsToCheck
    );

    return JSON.stringify({
        service: input.service,
        checked_services: servicesToCheck || "all",
        checked_regions: regionsToCheck || "all",
        has_active_events: healthResult.has_active_events,
        services_affected: healthResult.services_affected,
        regions_affected: healthResult.regions_affected,
        events: healthResult.events.map(e => ({
            service: e.service,
            region: e.region,
            event_type: e.event_type,
            status: e.status,
            start_time: e.start_time,
            description: e.description,
            affected_resources: e.affected_resources,
        })),
        recommendation: healthResult.has_active_events
            ? `AWS outage detected! ${healthResult.services_affected.join(", ")} affected in ${healthResult.regions_affected.join(", ")}`
            : "No active AWS events",
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: check_runtime_metrics
// ─────────────────────────────────────────────────────────────

export const checkRuntimeMetricsSchema = {
    service: z.string().describe("Service name"),
};

/**
 * Check if a service is publishing language-specific runtime metrics.
 * E.g., JVM metrics for Java, go_goroutines for Go.
 * If missing, provides recommendations for adding them.
 */
export async function checkRuntimeMetrics(
    input: { service: string }
): Promise<string> {
    // Get service language from catalog
    const row = await queryOne<{ language: AppLanguage }>(
        `SELECT language FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    const language = row.language || "unknown";

    if (language === "unknown") {
        return JSON.stringify({
            service: input.service,
            language,
            has_metrics: false,
            message: "Service language not configured - cannot check runtime metrics",
            recommendation: "Set 'language' field in service catalog",
        });
    }

    // Check Prometheus for runtime metrics
    const result = await backends.metrics.hasRuntimeMetrics(input.service, language);

    return JSON.stringify({
        service: input.service,
        language: result.language,
        has_runtime_metrics: result.has_metrics,
        expected_metrics: result.expected_metrics,
        found_metrics: result.found_metrics,
        missing_metrics: result.missing_metrics,
        recommendation: result.recommendation,
        action_needed: !result.has_metrics,
    }, null, 2);
}
