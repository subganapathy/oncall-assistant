/**
 * Prometheus/Grafana backend - REAL implementation.
 *
 * Queries Prometheus API for service metrics.
 * Also checks for runtime-specific metrics (JVM, Go, Node, etc.)
 */

import type {
    MetricsBackend,
    MetricsResult,
    RuntimeMetricsCheck,
    AppLanguage,
    RUNTIME_METRICS_BY_LANGUAGE,
} from "./types.js";

export class PrometheusBackend implements MetricsBackend {
    private baseUrl: string;
    private headers: Record<string, string>;

    constructor(config: {
        url: string;
        apiKey?: string;
    }) {
        this.baseUrl = config.url.replace(/\/$/, "");
        this.headers = {
            "Content-Type": "application/json",
        };
        if (config.apiKey) {
            this.headers["Authorization"] = `Bearer ${config.apiKey}`;
        }
    }

    async getServiceMetrics(
        service: string,
        prometheusJob: string,
        region?: string
    ): Promise<MetricsResult> {
        const regionFilter = region ? `,region="${region}"` : "";
        const jobFilter = `job="${prometheusJob}"${regionFilter}`;

        // Query all metrics in parallel
        const [errorRate, p50, p99, availability, requestRate] = await Promise.all([
            this.queryScalar(`
                sum(rate(http_requests_total{${jobFilter},status=~"5.."}[5m]))
                / sum(rate(http_requests_total{${jobFilter}}[5m]))
            `),
            this.queryScalar(`
                histogram_quantile(0.50,
                    sum(rate(http_request_duration_seconds_bucket{${jobFilter}}[5m])) by (le)
                ) * 1000
            `),
            this.queryScalar(`
                histogram_quantile(0.99,
                    sum(rate(http_request_duration_seconds_bucket{${jobFilter}}[5m])) by (le)
                ) * 1000
            `),
            this.queryScalar(`
                avg_over_time(up{${jobFilter}}[5m])
            `),
            this.queryScalar(`
                sum(rate(http_requests_total{${jobFilter}}[5m]))
            `),
        ]);

        return {
            error_rate: errorRate ?? 0,
            p50_latency: p50 ?? 0,
            p99_latency: p99 ?? 0,
            availability: availability ?? 1,
            request_rate: requestRate ?? 0,
        };
    }

    /**
     * Check if runtime-specific metrics are being published.
     * This is critical for debugging language-specific issues (GC, memory, threads).
     */
    async hasRuntimeMetrics(
        service: string,
        language: AppLanguage
    ): Promise<RuntimeMetricsCheck> {
        const expectedMetrics = this.getExpectedMetrics(language);

        if (expectedMetrics.length === 0) {
            return {
                language,
                has_metrics: true,  // No expectations for unknown languages
                expected_metrics: [],
                found_metrics: [],
                missing_metrics: [],
            };
        }

        // Check which expected metrics exist
        const found: string[] = [];
        const missing: string[] = [];

        for (const metric of expectedMetrics) {
            const exists = await this.metricExists(metric, service);
            if (exists) {
                found.push(metric);
            } else {
                missing.push(metric);
            }
        }

        const has_metrics = missing.length === 0;

        return {
            language,
            has_metrics,
            expected_metrics: expectedMetrics,
            found_metrics: found,
            missing_metrics: missing,
            recommendation: has_metrics
                ? undefined
                : this.getRecommendation(language),
        };
    }

    /**
     * Check if a metric exists in Prometheus.
     */
    private async metricExists(metricName: string, service: string): Promise<boolean> {
        // Query to check if metric exists for this service
        const query = `count(${metricName}{job=~".*${service}.*"}) > 0`;
        const result = await this.queryScalar(query);
        return result !== null && result > 0;
    }

    /**
     * Get expected runtime metrics for a language.
     */
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

    /**
     * Get recommendation for adding runtime metrics.
     */
    private getRecommendation(language: AppLanguage): string {
        const recommendations: Record<AppLanguage, string> = {
            java: "Add micrometer-registry-prometheus to expose JVM metrics. See: https://micrometer.io/docs/registry/prometheus",
            go: "Import prometheus/client_golang and register default collectors. See: https://pkg.go.dev/github.com/prometheus/client_golang",
            python: "Add prometheus_client and expose process metrics. See: https://prometheus.github.io/client_python/",
            node: "Add prom-client with collectDefaultMetrics(). See: https://github.com/siimon/prom-client",
            rust: "Add prometheus crate with process collector. See: https://docs.rs/prometheus",
            dotnet: "Add prometheus-net NuGet package. See: https://github.com/prometheus-net/prometheus-net",
            unknown: "",
        };
        return recommendations[language] || "";
    }

    /**
     * Execute a PromQL query and return scalar result.
     */
    private async queryScalar(promql: string): Promise<number | null> {
        const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(promql.trim())}`;

        const response = await fetch(url, { headers: this.headers });

        if (!response.ok) {
            console.error(`Prometheus query failed: ${response.status}`);
            return null;
        }

        const data = await response.json() as {
            status: string;
            data?: {
                result?: Array<{ value: [number, string] }>;
            };
        };

        if (data.status !== "success" || !data.data?.result?.[0]?.value) {
            return null;
        }

        const value = parseFloat(data.data.result[0].value[1]);
        return isNaN(value) ? null : value;
    }
}
