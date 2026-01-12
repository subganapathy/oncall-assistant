/**
 * Mock backends for testing.
 *
 * These return configurable test data.
 */

import type {
    MetricsBackend,
    MetricsResult,
    RuntimeMetricsCheck,
    AppLanguage,
    LogsBackend,
    LogsResult,
    LogEntry,
    LogPattern,
    PatternScanResult,
    PatternMatch,
    KubernetesBackend,
    PodsResult,
    PodLogsOptions,
    PodLogsResult,
    DeploymentBackend,
    DeployInfo,
    AwsBackend,
    AwsServiceType,
    AwsResourceMetrics,
    AwsHealthEvent,
    Backends,
} from "./types.js";

// ─────────────────────────────────────────────────────────────
// MOCK METRICS
// ─────────────────────────────────────────────────────────────

export class MockMetricsBackend implements MetricsBackend {
    private scenarios: Map<string, MetricsResult> = new Map();
    private runtimeMetrics: Map<string, RuntimeMetricsCheck> = new Map();
    private defaultMetrics: MetricsResult = {
        error_rate: 0.005,
        p50_latency: 45,
        p99_latency: 180,
        availability: 0.998,
        request_rate: 1250,
    };

    setServiceMetrics(service: string, metrics: Partial<MetricsResult>): void {
        this.scenarios.set(service, { ...this.defaultMetrics, ...metrics });
    }

    setRuntimeMetrics(service: string, check: RuntimeMetricsCheck): void {
        this.runtimeMetrics.set(service, check);
    }

    async getServiceMetrics(service: string): Promise<MetricsResult> {
        return this.scenarios.get(service) || this.defaultMetrics;
    }

    async hasRuntimeMetrics(service: string, language: AppLanguage): Promise<RuntimeMetricsCheck> {
        const existing = this.runtimeMetrics.get(service);
        if (existing) return existing;

        // Default: assume metrics exist
        return {
            language,
            has_metrics: true,
            expected_metrics: this.getExpectedMetrics(language),
            found_metrics: this.getExpectedMetrics(language),
            missing_metrics: [],
        };
    }

    private getExpectedMetrics(language: AppLanguage): string[] {
        const metricsByLanguage: Record<AppLanguage, string[]> = {
            java: ["jvm_memory_used_bytes", "jvm_gc_pause_seconds", "jvm_threads_current"],
            go: ["go_goroutines", "go_memstats_alloc_bytes", "go_gc_duration_seconds"],
            python: ["python_gc_objects_collected_total", "python_info"],
            node: ["nodejs_heap_size_used_bytes", "nodejs_eventloop_lag_seconds"],
            rust: ["process_resident_memory_bytes"],
            dotnet: ["dotnet_gc_heap_size_bytes", "dotnet_threadpool_num_threads"],
            unknown: [],
        };
        return metricsByLanguage[language] || [];
    }
}

// ─────────────────────────────────────────────────────────────
// MOCK LOGS
// ─────────────────────────────────────────────────────────────

export class MockLogsBackend implements LogsBackend {
    private logs: Map<string, LogsResult> = new Map();
    private patternResults: Map<string, PatternScanResult> = new Map();
    private defaultLogs: LogsResult = {
        total_hits: 3,
        logs: [
            {
                timestamp: new Date().toISOString(),
                level: "error",
                message: "Connection timeout to database after 30s",
                trace_id: "abc123",
            },
            {
                timestamp: new Date(Date.now() - 60000).toISOString(),
                level: "warn",
                message: "Retry attempt 2/3 for database connection",
                trace_id: "abc123",
            },
            {
                timestamp: new Date(Date.now() - 120000).toISOString(),
                level: "error",
                message: "Request failed: connection refused",
                trace_id: "def456",
            },
        ],
    };

    setLogsForIndex(index: string, logs: LogsResult): void {
        this.logs.set(index, logs);
    }

    setPatternResultsForIndex(index: string, result: PatternScanResult): void {
        this.patternResults.set(index, result);
    }

    simulatePatternMatch(index: string, match: PatternMatch): void {
        const existing = this.patternResults.get(index) || {
            scanned_logs: 1000,
            matches: [],
            summary: { critical_count: 0, warning_count: 0, info_count: 0 },
        };

        existing.matches.push(match);

        // Update summary
        if (match.severity === "critical") {
            existing.summary.critical_count += match.count;
        } else if (match.severity === "warning") {
            existing.summary.warning_count += match.count;
        } else {
            existing.summary.info_count += match.count;
        }

        this.patternResults.set(index, existing);
    }

    async queryLogs(index: string): Promise<LogsResult> {
        return this.logs.get(index) || this.defaultLogs;
    }

    async scanForPatterns(
        index: string,
        patterns: LogPattern[],
        since?: string
    ): Promise<PatternScanResult> {
        // If pre-configured results exist, return them
        if (this.patternResults.has(index)) {
            const result = this.patternResults.get(index)!;
            // Filter to only patterns that were requested
            const patternNames = new Set(patterns.map(p => p.name));
            return {
                ...result,
                matches: result.matches.filter(m => patternNames.has(m.pattern_name)),
            };
        }

        // Default: simulate some pattern matches based on the logs
        const logs = await this.queryLogs(index);
        const matches: PatternMatch[] = [];

        for (const pattern of patterns) {
            const matchingLogs = logs.logs.filter(log =>
                new RegExp(pattern.pattern, "i").test(log.message)
            );

            if (matchingLogs.length > 0) {
                matches.push({
                    pattern_name: pattern.name,
                    severity: pattern.severity,
                    description: pattern.description,
                    count: matchingLogs.length,
                    first_seen: matchingLogs[matchingLogs.length - 1]?.timestamp || new Date().toISOString(),
                    last_seen: matchingLogs[0]?.timestamp || new Date().toISOString(),
                    sample_logs: matchingLogs.slice(0, 3),
                    runbook_link: pattern.runbook_link,
                });
            }
        }

        return {
            scanned_logs: logs.total_hits,
            matches,
            summary: {
                critical_count: matches.filter(m => m.severity === "critical").reduce((sum, m) => sum + m.count, 0),
                warning_count: matches.filter(m => m.severity === "warning").reduce((sum, m) => sum + m.count, 0),
                info_count: matches.filter(m => m.severity === "info").reduce((sum, m) => sum + m.count, 0),
            },
        };
    }
}

// ─────────────────────────────────────────────────────────────
// MOCK KUBERNETES
// ─────────────────────────────────────────────────────────────

export class MockKubernetesBackend implements KubernetesBackend {
    private pods: Map<string, PodsResult> = new Map();
    private podLogs: Map<string, PodLogsResult> = new Map();

    setPodsForService(service: string, namespace: string, result: PodsResult): void {
        this.pods.set(`${namespace}/${service}`, result);
    }

    setPodLogs(pod: string, namespace: string, cluster: string, logs: string): void {
        this.podLogs.set(`${cluster}/${namespace}/${pod}`, {
            pod,
            logs,
            truncated: false,
            from_previous: false,
        });
    }

    simulateCrashedPod(pod: string, namespace: string, cluster: string, crashLogs: string): void {
        this.podLogs.set(`${cluster}/${namespace}/${pod}:previous`, {
            pod,
            logs: crashLogs,
            truncated: false,
            from_previous: true,
        });
    }

    async getPods(service: string, namespace: string): Promise<PodsResult> {
        const key = `${namespace}/${service}`;

        if (this.pods.has(key)) {
            return this.pods.get(key)!;
        }

        return {
            pods: [
                {
                    name: `${service}-5d8f4c9b6-abc12`,
                    status: "Running",
                    restarts: 0,
                    ready: "1/1",
                    age: "3d",
                    node: "node-1",
                },
                {
                    name: `${service}-5d8f4c9b6-def34`,
                    status: "Running",
                    restarts: 0,
                    ready: "1/1",
                    age: "3d",
                    node: "node-2",
                },
                {
                    name: `${service}-5d8f4c9b6-ghi56`,
                    status: "Running",
                    restarts: 2,
                    ready: "1/1",
                    age: "3d",
                    node: "node-3",
                },
            ],
        };
    }

    async getPodLogs(
        pod: string,
        namespace: string,
        cluster: string,
        options: PodLogsOptions = {}
    ): Promise<PodLogsResult> {
        const { previous = false, container, tail = 100 } = options;

        // Check for previous (crashed) logs first
        if (previous) {
            const previousKey = `${cluster}/${namespace}/${pod}:previous`;
            if (this.podLogs.has(previousKey)) {
                const result = this.podLogs.get(previousKey)!;
                return { ...result, container };
            }
        }

        // Check for current logs
        const key = `${cluster}/${namespace}/${pod}`;
        if (this.podLogs.has(key)) {
            const result = this.podLogs.get(key)!;
            return { ...result, container, from_previous: false };
        }

        // Return default mock logs
        const defaultLogs = this.generateDefaultLogs(pod, tail);
        return {
            pod,
            container,
            logs: defaultLogs,
            truncated: false,
            from_previous: false,
        };
    }

    private generateDefaultLogs(pod: string, lines: number): string {
        const logLines: string[] = [];
        const now = Date.now();

        for (let i = lines - 1; i >= 0; i--) {
            const timestamp = new Date(now - i * 1000).toISOString();
            const level = i % 10 === 0 ? "WARN" : "INFO";
            logLines.push(`${timestamp} ${level} [${pod}] Processing request ${lines - i}`);
        }

        return logLines.join("\n");
    }
}

// ─────────────────────────────────────────────────────────────
// MOCK DEPLOYMENTS (GitHub-based)
// ─────────────────────────────────────────────────────────────

export class MockDeploymentBackend implements DeploymentBackend {
    private deploys: Map<string, DeployInfo[]> = new Map();

    setDeploysForService(service: string, deploys: DeployInfo[]): void {
        this.deploys.set(service, deploys);
    }

    simulateDeployment(service: string, deploy: Partial<DeployInfo>): void {
        const existing = this.deploys.get(service) || [];

        const newDeploy: DeployInfo = {
            version: deploy.version || `v1.0.${existing.length}`,
            commit_sha: deploy.commit_sha || `abc${Date.now()}`,
            deployed_at: deploy.deployed_at || new Date().toISOString(),
            deployed_by: deploy.deployed_by || "ci@github.com",
            environment: deploy.environment || "production",
            status: deploy.status || "success",
            previous_version: existing[0]?.version,
            commit_message: deploy.commit_message,
        };

        this.deploys.set(service, [newDeploy, ...existing]);
    }

    async getRecentDeploys(service: string, limit: number = 5): Promise<DeployInfo[]> {
        if (this.deploys.has(service)) {
            return this.deploys.get(service)!.slice(0, limit);
        }

        // Default: one deploy 15 min ago
        return [
            {
                version: "v2.3.4",
                previous_version: "v2.3.3",
                commit_sha: "abc1234567890",
                deployed_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                deployed_by: "alice@company.com",
                environment: "production",
                status: "success",
                commit_message: "Fix null pointer exception",
            },
            {
                version: "v2.3.3",
                commit_sha: "def5678901234",
                deployed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                deployed_by: "bob@company.com",
                environment: "production",
                status: "success",
            },
        ];
    }

    async getCurrentDeployment(service: string): Promise<DeployInfo | null> {
        const deploys = await this.getRecentDeploys(service, 1);
        return deploys[0] || null;
    }
}

// ─────────────────────────────────────────────────────────────
// MOCK AWS (CloudWatch + Health)
// ─────────────────────────────────────────────────────────────

export class MockAwsBackend implements AwsBackend {
    private resourceMetrics: Map<string, AwsResourceMetrics> = new Map();
    private healthEvents: AwsHealthEvent[] = [];

    setResourceMetrics(resourceId: string, metrics: Partial<AwsResourceMetrics>): void {
        this.resourceMetrics.set(resourceId, {
            resource_id: resourceId,
            service: "rds",
            region: "us-east-1",
            status: "healthy",
            metrics: {},
            last_updated: new Date().toISOString(),
            ...metrics,
        });
    }

    simulateAwsOutage(service: AwsServiceType, region: string, description: string): void {
        this.healthEvents.push({
            event_arn: `arn:aws:health:${region}::event/${service}/${Date.now()}`,
            service,
            region,
            event_type: "issue",
            status: "open",
            start_time: new Date().toISOString(),
            description,
        });
    }

    clearOutages(): void {
        this.healthEvents = [];
    }

    async getResourceMetrics(
        service: AwsServiceType,
        resourceId: string,
        region: string
    ): Promise<AwsResourceMetrics> {
        if (this.resourceMetrics.has(resourceId)) {
            return this.resourceMetrics.get(resourceId)!;
        }

        return {
            resource_id: resourceId,
            service,
            region,
            status: "healthy",
            metrics: this.getDefaultMetrics(service),
            last_updated: new Date().toISOString(),
        };
    }

    async getHealthEvents(
        services?: AwsServiceType[],
        regions?: string[]
    ): Promise<{
        has_active_events: boolean;
        events: AwsHealthEvent[];
        services_affected: string[];
        regions_affected: string[];
    }> {
        let events = this.healthEvents;

        if (services) {
            events = events.filter(e =>
                services.some(s => e.service.toLowerCase().includes(s))
            );
        }

        if (regions) {
            events = events.filter(e => regions.includes(e.region));
        }

        const activeEvents = events.filter(e => e.status === "open" || e.status === "upcoming");

        return {
            has_active_events: activeEvents.length > 0,
            events: activeEvents,
            services_affected: [...new Set(activeEvents.map(e => e.service))],
            regions_affected: [...new Set(activeEvents.map(e => e.region))],
        };
    }

    private getDefaultMetrics(service: AwsServiceType): Record<string, number> {
        const defaults: Record<AwsServiceType, Record<string, number>> = {
            rds: { CPUUtilization: 25, DatabaseConnections: 50, FreeStorageSpace: 100000000000 },
            sqs: { ApproximateNumberOfMessages: 10, ApproximateAgeOfOldestMessage: 5 },
            sns: { NumberOfMessagesPublished: 500, NumberOfNotificationsFailed: 0 },
            elasticache: { CPUUtilization: 15, CacheHits: 9500, CacheMisses: 500 },
            dynamodb: { ConsumedReadCapacityUnits: 100, ConsumedWriteCapacityUnits: 50 },
            s3: { NumberOfObjects: 100000, BucketSizeBytes: 50000000000 },
            lambda: { Invocations: 10000, Errors: 5, Duration: 150 },
            elb: { RequestCount: 50000, TargetResponseTime: 0.05, HealthyHostCount: 3 },
            ecs: { CPUUtilization: 40, MemoryUtilization: 55, RunningTaskCount: 5 },
            eks: { cluster_failed_node_count: 0, pod_cpu_utilization: 35 },
        };
        return defaults[service] || {};
    }
}

// ─────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────

export function createMockBackends(): Backends {
    return {
        metrics: new MockMetricsBackend(),
        logs: new MockLogsBackend(),
        kubernetes: new MockKubernetesBackend(),
        deployments: new MockDeploymentBackend(),
        aws: new MockAwsBackend(),
    };
}
