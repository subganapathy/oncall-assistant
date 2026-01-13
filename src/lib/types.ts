/**
 * Core types for the On-Call Assistant
 *
 * These define the "shape" of data flowing through the system.
 * Think of them as contracts - any data matching these types
 * is guaranteed to have the required fields.
 */

// ─────────────────────────────────────────────────────────────
// APPLICATION LANGUAGE
// ─────────────────────────────────────────────────────────────

/**
 * Supported application languages.
 * Used to check if runtime metrics are being published.
 */
export type AppLanguage = "java" | "go" | "python" | "node" | "rust" | "dotnet" | "unknown";

/**
 * How to infer language from repo files.
 */
export const LANGUAGE_INDICATORS: Record<string, AppLanguage> = {
    "go.mod": "go",
    "go.sum": "go",
    "pom.xml": "java",
    "build.gradle": "java",
    "build.gradle.kts": "java",
    "package.json": "node",
    "requirements.txt": "python",
    "pyproject.toml": "python",
    "Cargo.toml": "rust",
    "*.csproj": "dotnet",
    "*.fsproj": "dotnet",
};

// ─────────────────────────────────────────────────────────────
// SERVICE CATALOG
// ─────────────────────────────────────────────────────────────

/**
 * Observability configuration for a service.
 * Tells the agent WHERE to find logs, metrics, dashboards.
 */
export interface Observability {
    grafana_dashboard?: string;    // Dashboard URL (AI can parse for RED metrics)
    grafana_uid?: string;          // Dashboard identifier (legacy)
    logs_index?: string;           // Log index pattern (e.g., "prod-user-*")
    opensearch_index?: string;     // Alias for logs_index (legacy)
    prometheus_job?: string;       // Prometheus job name if different from service
    trace_service?: string;        // Jaeger/Tempo service name if different
    log_patterns?: LogPatternConfig; // Known error patterns to look for
}

/**
 * Log patterns to search for during diagnosis.
 */
export interface LogPatternConfig {
    // Service-specific patterns (custom to this service)
    custom_errors?: LogPattern[];

    // Override default severity for certain patterns
    severity_overrides?: Record<string, "critical" | "warning" | "info">;
}

/**
 * A log pattern to search for.
 */
export interface LogPattern {
    name: string;                  // e.g., "PaymentDeclined"
    pattern: string;               // Regex or OpenSearch query
    severity: "critical" | "warning" | "info";
    description: string;           // What this error means
    runbook_link?: string;         // Link to runbook for this error
}

/**
 * Internal service dependency (another entry in your catalog).
 */
export interface InternalDependency {
    name: string;                  // Service name (must exist in catalog)
    type: "internal";
    critical: boolean;             // If down, does this service break?
}

/**
 * AWS managed service dependency.
 */
export interface AwsDependency {
    name: string;                  // Friendly name (e.g., "payments-db")
    type: "aws";
    aws_service: "rds" | "sqs" | "sns" | "elasticache" | "dynamodb" | "s3" | "lambda" | "elb";
    aws_resource_id: string;       // Resource identifier or ARN
    aws_region: string;            // e.g., "us-east-1"
    critical: boolean;
}

/**
 * External API dependency.
 */
export interface ExternalDependency {
    name: string;                  // e.g., "stripe"
    type: "external";
    health_endpoint?: string;      // Status page URL
    critical: boolean;
}

/**
 * Database dependency (internal managed database).
 */
export interface DatabaseDependency {
    name: string;                  // e.g., "postgres-users"
    type: "database";
    critical: boolean;
}

/**
 * Combined dependency type.
 */
export type Dependency = InternalDependency | AwsDependency | ExternalDependency | DatabaseDependency;

/**
 * Deployment tracking via GitOps.
 * Points to the repo where deployment.yaml lives.
 */
export interface DeploymentConfig {
    repo: string;                  // e.g., "github.com/company/user-service"
    github_repo?: string;          // Legacy alias for repo
    gitops_path?: string;          // e.g., "deploy/production/deployment.yaml"
    deployment_file?: string;      // Legacy alias for gitops_path
    argocd_app?: string;           // e.g., "user-service-prod"
    environment?: string;          // e.g., "production"
}

/**
 * Automation policy.
 * What can the agent do without human approval?
 */
export interface AutomationPolicy {
    allowed_actions: string[];     // Actions agent can take freely
    requires_approval: string[];   // Actions needing human OK
}

/**
 * A resource that this service is the system of record for.
 * Used by AI to understand what resources a service manages
 * and how to query them.
 */
export interface ResourceEntry {
    pattern: string;               // ID pattern, e.g., "ord-*", "res-*"
    type: string;                  // Resource type, e.g., "order", "managed-resource"
    description: string;           // Rich description for AI to understand context
                                   // e.g., "Models a customer order. May spawn fulfillment
                                   // workloads on data plane. Common issues: stuck in PENDING
                                   // when inventory service is slow."
    handler_url?: string;          // Optional URL to fetch live resource status
                                   // e.g., "https://orders-api.internal/resources/${id}"
                                   // ${id} is replaced with the actual resource ID
}

/**
 * The main Service Catalog entry.
 * This is what gets stored in PostgreSQL.
 */
export interface ServiceCatalog {
    // Identity
    name: string;                  // Primary key, e.g., "user-service"

    // Description (richer = more helpful for AI)
    description: string;           // e.g., "System of record for user accounts. Handles
                                   // registration, authentication, profile management.
                                   // If users can't log in, check this service first."

    // Application info
    language?: AppLanguage;        // For runtime metrics checking
    github_repo?: string;          // Legacy: e.g., "company/user-service"

    // Ownership
    team: string;                  // e.g., "payments"
    slack_channel: string;         // e.g., "#payments-oncall"
    pagerduty_service?: string;    // e.g., "user-service-prod"
    pager_alias?: string;          // Legacy alias for pagerduty_service

    // Configuration
    observability: Observability;
    dependencies: Dependency[];
    deployment: DeploymentConfig;
    automation?: AutomationPolicy;
    runbook_path?: string;         // e.g., "/runbooks/user-service/"

    // Resources this service is system of record for
    resources?: ResourceEntry[];   // e.g., [{ pattern: "usr-*", type: "user", description: "..." }]

    // Metadata
    created_at?: Date;
    updated_at?: Date;
}

// ─────────────────────────────────────────────────────────────
// RESOURCE LOOKUP (BYO Interface)
// ─────────────────────────────────────────────────────────────

/**
 * Response from a get_resource call.
 * This is intentionally loose - AI interprets the semi-structured response.
 *
 * Teams implement get_resource to return their resource's current state.
 * The only hard requirements are id and status. Everything else is
 * semi-structured and AI will figure it out.
 */
export interface ResourceInfo {
    // Required: identify the resource
    id: string;

    // Required: current state
    status: string;

    // Optional: the full spec/object (AI interprets)
    spec?: Record<string, unknown>;

    // Optional: workload info (AI looks for namespace/cluster hints)
    // Can be anywhere in the object - AI will find it
    [key: string]: unknown;
}

/**
 * A resource handler function.
 * Teams implement this to provide resource lookup for their service.
 *
 * @param id - The resource ID (e.g., "ord-1234", "res-5678")
 * @returns The resource info, or null if not found
 */
export type ResourceHandler = (id: string) => Promise<ResourceInfo | null>;

/**
 * Registry of resource handlers.
 * Maps resource type patterns to their handler functions.
 */
export interface ResourceHandlerRegistry {
    /**
     * Register a handler for a resource pattern.
     * @param pattern - Glob pattern (e.g., "ord-*", "res-*")
     * @param handler - Function to fetch resource info
     */
    register(pattern: string, handler: ResourceHandler): void;

    /**
     * Get resource info by ID.
     * Matches ID against registered patterns and calls appropriate handler.
     * @param id - Resource ID
     * @returns Resource info or null if no handler matches
     */
    get(id: string): Promise<ResourceInfo | null>;

    /**
     * Find which service owns a resource pattern.
     * @param id - Resource ID
     * @returns Service name or null if not found
     */
    findOwner(id: string): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────

/**
 * Severity levels following standard incident classification.
 */
export type Severity = "P0" | "P1" | "P2" | "P3";

/**
 * An incoming alert from Slack/PagerDuty.
 * This is what triggers the agent.
 */
export interface Alert {
    id: string;                    // Unique alert ID
    service: string;               // Which service is alerting
    name: string;                  // Alert name, e.g., "HighErrorRate"
    severity: Severity;
    message: string;               // Alert description

    // Instance context (WHERE is the problem)
    instance: {
        cluster: string;           // e.g., "prod-us-east-1"
        namespace: string;         // e.g., "production"
        csp: string;               // Cloud provider: aws, gcp, azure
        region: string;
        pod?: string;              // Specific pod if applicable
    };

    // Slack context
    slack: {
        channel: string;
        thread_ts?: string;        // For threading replies
        user?: string;             // Who's on-call
    };

    fired_at: Date;
}

// ─────────────────────────────────────────────────────────────
// METRICS & HEALTH
// ─────────────────────────────────────────────────────────────

/**
 * Table stakes metrics - the basics you check for any service.
 */
export interface ServiceHealth {
    service: string;
    timestamp: Date;

    error_rate: number;            // 0.0 to 1.0 (0% to 100%)
    p50_latency: number;           // milliseconds
    p99_latency: number;           // milliseconds
    availability: number;          // 0.0 to 1.0
    request_rate: number;          // requests per second

    // Is this healthy? (based on thresholds)
    status: "healthy" | "degraded" | "critical";
}

/**
 * Default thresholds for health determination.
 * Can be overridden per-service in catalog.
 */
export const DEFAULT_THRESHOLDS = {
    error_rate: 0.01,              // > 1% is bad
    p99_latency: 2000,             // > 2s is bad
    availability: 0.99,            // < 99% is bad
};

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT INFO (GitOps-based)
// ─────────────────────────────────────────────────────────────

/**
 * A deployment event from GitHub Actions.
 * Tracked via deployment.yaml in the service repo.
 */
export interface DeployEvent {
    service: string;
    version: string;               // Git tag or version
    commit_sha: string;            // Full commit SHA
    deployed_at: Date;
    deployed_by: string;
    status: "success" | "failed" | "in_progress" | "rolling_back";
    environment: string;           // e.g., "production"

    // For rollback decisions
    previous_version?: string;
    commit_message?: string;
}

// ─────────────────────────────────────────────────────────────
// DIAGNOSIS OUTPUT
// ─────────────────────────────────────────────────────────────

/**
 * The agent's diagnosis of an incident.
 * This is what gets posted back to Slack.
 */
export interface Diagnosis {
    alert_id: string;
    service: string;

    severity: Severity;
    summary: string;               // One-line summary

    root_cause: {
        hypothesis: string;        // What the agent thinks caused it
        confidence: "high" | "medium" | "low";
        evidence: string[];        // Supporting observations
    };

    impact: {
        customer_facing: boolean;
        affected_services: string[];
        estimated_users_affected?: number;
    };

    recommended_actions: {
        action: string;
        reason: string;
        requires_approval: boolean;
        runbook_link?: string;
    }[];

    // Should we page someone?
    escalation: {
        needed: boolean;
        who?: string;              // pager alias
        reason?: string;
    };

    // Links for the on-call engineer
    links: {
        grafana?: string;
        logs?: string;
        traces?: string;
        runbook?: string;
    };

    diagnosed_at: Date;
}

// ─────────────────────────────────────────────────────────────
// RUNTIME METRICS CHECK
// ─────────────────────────────────────────────────────────────

/**
 * Result of checking if a service publishes runtime metrics.
 */
export interface RuntimeMetricsCheck {
    service: string;
    language: AppLanguage;
    has_metrics: boolean;
    expected_metrics: string[];
    found_metrics: string[];
    missing_metrics: string[];
    recommendation?: string;
}

/**
 * Expected runtime metrics by language.
 */
export const RUNTIME_METRICS_BY_LANGUAGE: Record<AppLanguage, {
    metrics: string[];
    library: string;
    docs: string;
}> = {
    java: {
        metrics: ["jvm_memory_used_bytes", "jvm_gc_pause_seconds", "jvm_threads_current"],
        library: "micrometer-registry-prometheus",
        docs: "https://micrometer.io/docs/registry/prometheus",
    },
    go: {
        metrics: ["go_goroutines", "go_memstats_alloc_bytes", "go_gc_duration_seconds"],
        library: "prometheus/client_golang",
        docs: "https://pkg.go.dev/github.com/prometheus/client_golang/prometheus",
    },
    python: {
        metrics: ["python_gc_objects_collected_total", "python_info", "process_resident_memory_bytes"],
        library: "prometheus_client",
        docs: "https://prometheus.github.io/client_python/",
    },
    node: {
        metrics: ["nodejs_heap_size_used_bytes", "nodejs_eventloop_lag_seconds", "nodejs_gc_duration_seconds"],
        library: "prom-client",
        docs: "https://github.com/siimon/prom-client",
    },
    rust: {
        metrics: ["process_resident_memory_bytes", "process_cpu_seconds_total"],
        library: "prometheus (crate)",
        docs: "https://docs.rs/prometheus/latest/prometheus/",
    },
    dotnet: {
        metrics: ["dotnet_gc_heap_size_bytes", "dotnet_threadpool_num_threads"],
        library: "prometheus-net",
        docs: "https://github.com/prometheus-net/prometheus-net",
    },
    unknown: {
        metrics: [],
        library: "",
        docs: "",
    },
};

// ─────────────────────────────────────────────────────────────
// LOG PATTERNS BY LANGUAGE
// ─────────────────────────────────────────────────────────────

/**
 * Language-specific log patterns that indicate problems.
 * The agent automatically searches for these based on service language.
 */
export const LOG_PATTERNS_BY_LANGUAGE: Record<AppLanguage, LogPattern[]> = {
    java: [
        {
            name: "OutOfMemoryError",
            pattern: "java.lang.OutOfMemoryError",
            severity: "critical",
            description: "JVM ran out of heap memory",
        },
        {
            name: "StackOverflowError",
            pattern: "java.lang.StackOverflowError",
            severity: "critical",
            description: "Infinite recursion or too deep call stack",
        },
        {
            name: "NullPointerException",
            pattern: "java.lang.NullPointerException",
            severity: "warning",
            description: "Null reference access",
        },
        {
            name: "ConnectionTimeout",
            pattern: "java.net.SocketTimeoutException|java.sql.SQLException.*timeout",
            severity: "warning",
            description: "Network or database connection timeout",
        },
        {
            name: "GCOverhead",
            pattern: "GC overhead limit exceeded",
            severity: "critical",
            description: "Too much time spent in garbage collection",
        },
        {
            name: "ThreadStarvation",
            pattern: "RejectedExecutionException|thread pool exhausted",
            severity: "critical",
            description: "Thread pool is full, requests being rejected",
        },
    ],
    go: [
        {
            name: "Panic",
            pattern: "panic:|runtime error:",
            severity: "critical",
            description: "Go runtime panic",
        },
        {
            name: "GoroutineLeak",
            pattern: "goroutine leak|too many goroutines",
            severity: "warning",
            description: "Goroutines not being cleaned up",
        },
        {
            name: "DeadLock",
            pattern: "fatal error: all goroutines are asleep - deadlock",
            severity: "critical",
            description: "Deadlock detected",
        },
        {
            name: "OutOfMemory",
            pattern: "runtime: out of memory|cannot allocate memory",
            severity: "critical",
            description: "Process ran out of memory",
        },
        {
            name: "ContextCanceled",
            pattern: "context canceled|context deadline exceeded",
            severity: "warning",
            description: "Request timeout or cancellation",
        },
    ],
    python: [
        {
            name: "MemoryError",
            pattern: "MemoryError",
            severity: "critical",
            description: "Python ran out of memory",
        },
        {
            name: "RecursionError",
            pattern: "RecursionError: maximum recursion depth exceeded",
            severity: "critical",
            description: "Too deep recursion",
        },
        {
            name: "ConnectionError",
            pattern: "ConnectionError|ConnectionRefusedError|TimeoutError",
            severity: "warning",
            description: "Network connection failed",
        },
        {
            name: "ImportError",
            pattern: "ImportError|ModuleNotFoundError",
            severity: "critical",
            description: "Missing dependency or module",
        },
        {
            name: "TypeError",
            pattern: "TypeError:",
            severity: "warning",
            description: "Type mismatch error",
        },
    ],
    node: [
        {
            name: "HeapOutOfMemory",
            pattern: "FATAL ERROR: .* JavaScript heap out of memory|allocation failed",
            severity: "critical",
            description: "Node.js ran out of heap memory",
        },
        {
            name: "UnhandledRejection",
            pattern: "UnhandledPromiseRejection|unhandledRejection",
            severity: "critical",
            description: "Unhandled promise rejection",
        },
        {
            name: "UncaughtException",
            pattern: "uncaughtException|Uncaught Exception",
            severity: "critical",
            description: "Unhandled exception crashed the process",
        },
        {
            name: "EventLoopBlocked",
            pattern: "event loop blocked|event loop lag",
            severity: "warning",
            description: "Event loop is blocked by synchronous code",
        },
        {
            name: "ECONNREFUSED",
            pattern: "ECONNREFUSED|ETIMEDOUT|ENOTFOUND",
            severity: "warning",
            description: "Network connection failed",
        },
    ],
    rust: [
        {
            name: "Panic",
            pattern: "thread .* panicked at|panic!",
            severity: "critical",
            description: "Rust panic",
        },
        {
            name: "StackOverflow",
            pattern: "stack overflow|thread.*overflowed its stack",
            severity: "critical",
            description: "Stack overflow",
        },
        {
            name: "OutOfMemory",
            pattern: "memory allocation.*failed|out of memory",
            severity: "critical",
            description: "Memory allocation failed",
        },
    ],
    dotnet: [
        {
            name: "OutOfMemoryException",
            pattern: "System.OutOfMemoryException",
            severity: "critical",
            description: ".NET ran out of memory",
        },
        {
            name: "StackOverflowException",
            pattern: "System.StackOverflowException",
            severity: "critical",
            description: "Stack overflow",
        },
        {
            name: "NullReferenceException",
            pattern: "System.NullReferenceException",
            severity: "warning",
            description: "Null reference access",
        },
        {
            name: "TaskCanceledException",
            pattern: "System.Threading.Tasks.TaskCanceledException|System.OperationCanceledException",
            severity: "warning",
            description: "Request timeout or cancellation",
        },
        {
            name: "SqlException",
            pattern: "System.Data.SqlClient.SqlException|Microsoft.Data.SqlClient.SqlException",
            severity: "warning",
            description: "Database error",
        },
    ],
    unknown: [],
};

// ─────────────────────────────────────────────────────────────
// COMMON LOG PATTERNS (Language-agnostic)
// ─────────────────────────────────────────────────────────────

/**
 * Common error patterns that apply to all services.
 */
export const COMMON_LOG_PATTERNS: LogPattern[] = [
    {
        name: "OOMKilled",
        pattern: "OOMKilled|Out of memory: Kill process|oom-killer",
        severity: "critical",
        description: "Container killed by Kubernetes due to memory limit",
    },
    {
        name: "CrashLoopBackOff",
        pattern: "CrashLoopBackOff|Back-off restarting failed container",
        severity: "critical",
        description: "Container repeatedly crashing",
    },
    {
        name: "ConnectionRefused",
        pattern: "connection refused|ECONNREFUSED|Connection reset by peer",
        severity: "warning",
        description: "Upstream service not accepting connections",
    },
    {
        name: "DNSLookupFailed",
        pattern: "no such host|NXDOMAIN|could not resolve|DNS lookup failed",
        severity: "critical",
        description: "DNS resolution failed",
    },
    {
        name: "TLSHandshakeFailed",
        pattern: "TLS handshake|certificate verify failed|x509: certificate",
        severity: "warning",
        description: "TLS/SSL certificate error",
    },
    {
        name: "RateLimited",
        pattern: "rate limit|too many requests|429|throttl",
        severity: "warning",
        description: "Rate limit exceeded",
    },
    {
        name: "CircuitBreakerOpen",
        pattern: "circuit breaker open|circuit open|fallback",
        severity: "warning",
        description: "Circuit breaker tripped due to failures",
    },
    {
        name: "DeadlineExceeded",
        pattern: "deadline exceeded|timeout|timed out|context deadline",
        severity: "warning",
        description: "Operation timed out",
    },
    {
        name: "DiskFull",
        pattern: "no space left on device|disk full|ENOSPC",
        severity: "critical",
        description: "Disk is full",
    },
    {
        name: "PermissionDenied",
        pattern: "permission denied|EACCES|access denied|forbidden",
        severity: "warning",
        description: "Permission or access denied",
    },
];
