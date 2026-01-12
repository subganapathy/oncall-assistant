/**
 * Backend interfaces.
 *
 * These define the contract for observability backends.
 * Real implementations call actual APIs.
 * Mock implementations return test data.
 *
 * SIMPLIFIED ARCHITECTURE:
 * - Prometheus + Grafana (metrics)
 * - OpenSearch (logs)
 * - Kubernetes (pod status)
 * - GitHub (deployments via GitOps)
 * - AWS (CloudWatch + Health API)
 *
 * REMOVED:
 * - ArgoCD (not universal)
 * - Istio/Kiali (too complex)
 */

// ─────────────────────────────────────────────────────────────
// METRICS BACKEND (Prometheus/Grafana)
// ─────────────────────────────────────────────────────────────

export interface MetricsResult {
    error_rate: number;
    p50_latency: number;
    p99_latency: number;
    availability: number;
    request_rate: number;
}

export interface MetricsBackend {
    /**
     * Query current metrics for a service.
     */
    getServiceMetrics(
        service: string,
        prometheusJob: string,
        region?: string
    ): Promise<MetricsResult>;

    /**
     * Check if runtime metrics exist for a service.
     * Used to verify services are publishing language-specific metrics.
     */
    hasRuntimeMetrics(
        service: string,
        language: AppLanguage
    ): Promise<RuntimeMetricsCheck>;
}

// ─────────────────────────────────────────────────────────────
// RUNTIME METRICS (Language-specific)
// ─────────────────────────────────────────────────────────────

export type AppLanguage = "java" | "go" | "python" | "node" | "rust" | "dotnet" | "unknown";

export interface RuntimeMetricsCheck {
    language: AppLanguage;
    has_metrics: boolean;
    expected_metrics: string[];      // What we expect to see
    found_metrics: string[];         // What we actually found
    missing_metrics: string[];       // What's missing
    recommendation?: string;         // How to fix
}

// Expected metrics by language
export const RUNTIME_METRICS_BY_LANGUAGE: Record<AppLanguage, string[]> = {
    java: [
        "jvm_memory_used_bytes",
        "jvm_gc_pause_seconds",
        "jvm_threads_current",
        "jvm_classes_loaded",
    ],
    go: [
        "go_goroutines",
        "go_memstats_alloc_bytes",
        "go_gc_duration_seconds",
        "go_threads",
    ],
    python: [
        "python_gc_objects_collected_total",
        "python_info",
        "process_resident_memory_bytes",
    ],
    node: [
        "nodejs_heap_size_used_bytes",
        "nodejs_eventloop_lag_seconds",
        "nodejs_active_handles_total",
        "nodejs_gc_duration_seconds",
    ],
    rust: [
        "process_resident_memory_bytes",
        "process_cpu_seconds_total",
        // Rust doesn't have a standard runtime metrics lib yet
    ],
    dotnet: [
        "dotnet_gc_heap_size_bytes",
        "dotnet_threadpool_num_threads",
        "dotnet_gc_collection_count_total",
    ],
    unknown: [],
};

// ─────────────────────────────────────────────────────────────
// LOGS BACKEND (OpenSearch/Elasticsearch)
// ─────────────────────────────────────────────────────────────

export interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    trace_id?: string;
    [key: string]: unknown;
}

export interface LogsResult {
    total_hits: number;
    logs: LogEntry[];
}

export interface LogsBackend {
    /**
     * Search logs for a service.
     */
    queryLogs(
        index: string,
        options: {
            query?: string;
            level?: string;
            since?: string;
            limit?: number;
        }
    ): Promise<LogsResult>;

    /**
     * Scan logs for known error patterns.
     * Returns matches grouped by pattern.
     */
    scanForPatterns(
        index: string,
        patterns: LogPattern[],
        since?: string
    ): Promise<PatternScanResult>;
}

/**
 * A log pattern to search for.
 */
export interface LogPattern {
    name: string;
    pattern: string;           // Regex pattern
    severity: "critical" | "warning" | "info";
    description: string;
    runbook_link?: string;
}

/**
 * Result of scanning logs for patterns.
 */
export interface PatternScanResult {
    scanned_logs: number;
    matches: PatternMatch[];
    summary: {
        critical_count: number;
        warning_count: number;
        info_count: number;
    };
}

/**
 * A pattern that was found in logs.
 */
export interface PatternMatch {
    pattern_name: string;
    severity: "critical" | "warning" | "info";
    description: string;
    count: number;
    first_seen: string;
    last_seen: string;
    sample_logs: LogEntry[];   // Up to 3 sample log lines
    runbook_link?: string;
}

// ─────────────────────────────────────────────────────────────
// KUBERNETES BACKEND
// ─────────────────────────────────────────────────────────────

export interface PodInfo {
    name: string;
    status: string;
    restarts: number;
    ready: string;
    age: string;
    node: string;
}

export interface PodsResult {
    pods: PodInfo[];
}

export interface PodLogsOptions {
    container?: string;          // Specific container (for multi-container pods)
    tail?: number;               // Number of lines (default: 100)
    since?: string;              // Time duration (e.g., "5m", "1h")
    previous?: boolean;          // Get logs from previous (crashed) container
}

export interface PodLogsResult {
    pod: string;
    container?: string;
    logs: string;
    truncated: boolean;          // True if we hit the tail limit
    from_previous: boolean;      // True if these are from crashed container
    error?: string;              // Error message if logs couldn't be fetched
}

export interface KubernetesBackend {
    /**
     * Get pod status for a service.
     */
    getPods(
        service: string,
        namespace: string
    ): Promise<PodsResult>;

    /**
     * Get logs from a specific pod.
     * Uses kubectl context matching the cluster name from alert.
     *
     * @param pod - Pod name
     * @param namespace - Kubernetes namespace
     * @param cluster - Cluster name (used as kubectl context)
     * @param options - Log options (tail, since, previous, container)
     */
    getPodLogs(
        pod: string,
        namespace: string,
        cluster: string,
        options?: PodLogsOptions
    ): Promise<PodLogsResult>;
}

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT BACKEND (GitHub-based GitOps)
// ─────────────────────────────────────────────────────────────

export interface DeployInfo {
    version: string;
    previous_version?: string;
    commit_sha: string;
    deployed_at: string;
    deployed_by: string;
    environment: string;
    status: "success" | "failed" | "in_progress" | "rolling_back";
    commit_message?: string;
}

export interface DeploymentBackend {
    /**
     * Get recent deployments from deployment.yaml in git.
     */
    getRecentDeploys(service: string, limit?: number): Promise<DeployInfo[]>;

    /**
     * Get current deployment status.
     */
    getCurrentDeployment(service: string): Promise<DeployInfo | null>;
}

// ─────────────────────────────────────────────────────────────
// AWS BACKEND (CloudWatch + Health API)
// ─────────────────────────────────────────────────────────────

export type AwsServiceType =
    | "rds"
    | "sqs"
    | "sns"
    | "elasticache"
    | "dynamodb"
    | "s3"
    | "lambda"
    | "elb"
    | "ecs"
    | "eks";

export interface AwsResourceMetrics {
    resource_id: string;
    service: AwsServiceType;
    region: string;
    status: "healthy" | "degraded" | "unhealthy" | "unknown";
    metrics: Record<string, number>;
    last_updated: string;
}

export interface AwsHealthEvent {
    event_arn: string;
    service: string;
    region: string;
    event_type: "issue" | "scheduledChange" | "accountNotification";
    status: "open" | "upcoming" | "closed";
    start_time: string;
    end_time?: string;
    description: string;
    affected_resources?: string[];
}

export interface AwsBackend {
    /**
     * Get metrics for a specific AWS resource.
     */
    getResourceMetrics(
        service: AwsServiceType,
        resourceId: string,
        region: string
    ): Promise<AwsResourceMetrics>;

    /**
     * Check AWS Health API for active events.
     * Catches large-scale AWS outages.
     */
    getHealthEvents(
        services?: AwsServiceType[],
        regions?: string[]
    ): Promise<{
        has_active_events: boolean;
        events: AwsHealthEvent[];
        services_affected: string[];
        regions_affected: string[];
    }>;
}

// ─────────────────────────────────────────────────────────────
// COMBINED BACKENDS
// ─────────────────────────────────────────────────────────────

export interface Backends {
    metrics: MetricsBackend;
    logs: LogsBackend;
    kubernetes: KubernetesBackend;
    deployments: DeploymentBackend;
    aws: AwsBackend;
}
