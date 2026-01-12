/**
 * OpenSearch/Elasticsearch backend - REAL implementation.
 *
 * Queries OpenSearch for log entries.
 */

import type {
    LogsBackend,
    LogsResult,
    LogEntry,
    LogPattern,
    PatternScanResult,
    PatternMatch,
} from "./types.js";

export class OpenSearchBackend implements LogsBackend {
    private baseUrl: string;
    private headers: Record<string, string>;

    constructor(config: {
        url: string;
        username?: string;
        password?: string;
    }) {
        this.baseUrl = config.url.replace(/\/$/, "");
        this.headers = {
            "Content-Type": "application/json",
        };
        if (config.username && config.password) {
            const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
            this.headers["Authorization"] = `Basic ${auth}`;
        }
    }

    async queryLogs(
        index: string,
        options: {
            query?: string;
            level?: string;
            since?: string;
            limit?: number;
        }
    ): Promise<LogsResult> {
        const must: object[] = [];

        // Time range filter
        if (options.since) {
            must.push({
                range: {
                    "@timestamp": {
                        gte: `now-${options.since}`,
                        lte: "now",
                    },
                },
            });
        }

        // Log level filter
        if (options.level) {
            must.push({
                term: { level: options.level },
            });
        }

        // Text search
        if (options.query) {
            must.push({
                query_string: {
                    query: options.query,
                    default_field: "message",
                },
            });
        }

        const body = {
            query: {
                bool: {
                    must: must.length > 0 ? must : [{ match_all: {} }],
                },
            },
            sort: [{ "@timestamp": "desc" }],
            size: options.limit || 100,
        };

        const url = `${this.baseUrl}/${index}/_search`;
        const response = await fetch(url, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.error(`OpenSearch query failed: ${response.status}`);
            return { total_hits: 0, logs: [] };
        }

        const data = await response.json();

        const logs: LogEntry[] = data.hits.hits.map((hit: { _source: Record<string, unknown> }) => ({
            timestamp: hit._source["@timestamp"] as string,
            level: hit._source.level as string || "info",
            message: hit._source.message as string || "",
            trace_id: hit._source.trace_id as string | undefined,
            ...hit._source,
        }));

        return {
            total_hits: data.hits.total.value || data.hits.total,
            logs,
        };
    }

    async scanForPatterns(
        index: string,
        patterns: LogPattern[],
        since?: string
    ): Promise<PatternScanResult> {
        const matches: PatternMatch[] = [];
        let totalScanned = 0;

        // Process each pattern
        for (const pattern of patterns) {
            const result = await this.searchPattern(index, pattern, since);
            totalScanned = Math.max(totalScanned, result.scanned);

            if (result.count > 0) {
                matches.push({
                    pattern_name: pattern.name,
                    severity: pattern.severity,
                    description: pattern.description,
                    count: result.count,
                    first_seen: result.first_seen,
                    last_seen: result.last_seen,
                    sample_logs: result.samples,
                    runbook_link: pattern.runbook_link,
                });
            }
        }

        // Calculate summary
        const summary = {
            critical_count: matches.filter(m => m.severity === "critical").reduce((sum, m) => sum + m.count, 0),
            warning_count: matches.filter(m => m.severity === "warning").reduce((sum, m) => sum + m.count, 0),
            info_count: matches.filter(m => m.severity === "info").reduce((sum, m) => sum + m.count, 0),
        };

        return {
            scanned_logs: totalScanned,
            matches: matches.sort((a, b) => {
                // Sort by severity (critical first), then by count
                const severityOrder = { critical: 0, warning: 1, info: 2 };
                const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
                if (severityDiff !== 0) return severityDiff;
                return b.count - a.count;
            }),
            summary,
        };
    }

    private async searchPattern(
        index: string,
        pattern: LogPattern,
        since?: string
    ): Promise<{
        count: number;
        first_seen: string;
        last_seen: string;
        samples: LogEntry[];
        scanned: number;
    }> {
        const must: object[] = [
            {
                query_string: {
                    query: pattern.pattern,
                    default_field: "message",
                    analyze_wildcard: true,
                },
            },
        ];

        if (since) {
            must.push({
                range: {
                    "@timestamp": {
                        gte: `now-${since}`,
                        lte: "now",
                    },
                },
            });
        }

        // First, get count and time bounds
        const countBody = {
            query: { bool: { must } },
            size: 0,
            aggs: {
                first_seen: { min: { field: "@timestamp" } },
                last_seen: { max: { field: "@timestamp" } },
            },
            track_total_hits: true,
        };

        const countUrl = `${this.baseUrl}/${index}/_search`;
        const countResponse = await fetch(countUrl, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(countBody),
        });

        if (!countResponse.ok) {
            console.error(`OpenSearch pattern search failed for ${pattern.name}: ${countResponse.status}`);
            return { count: 0, first_seen: "", last_seen: "", samples: [], scanned: 0 };
        }

        const countData = await countResponse.json();
        const totalHits = countData.hits.total.value || countData.hits.total;

        if (totalHits === 0) {
            return { count: 0, first_seen: "", last_seen: "", samples: [], scanned: totalHits };
        }

        // Get sample logs (up to 3)
        const sampleBody = {
            query: { bool: { must } },
            sort: [{ "@timestamp": "desc" }],
            size: 3,
        };

        const sampleResponse = await fetch(countUrl, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(sampleBody),
        });

        let samples: LogEntry[] = [];
        if (sampleResponse.ok) {
            const sampleData = await sampleResponse.json();
            samples = sampleData.hits.hits.map((hit: { _source: Record<string, unknown> }) => ({
                timestamp: hit._source["@timestamp"] as string,
                level: hit._source.level as string || "error",
                message: hit._source.message as string || "",
                trace_id: hit._source.trace_id as string | undefined,
            }));
        }

        return {
            count: totalHits,
            first_seen: countData.aggregations?.first_seen?.value_as_string || "",
            last_seen: countData.aggregations?.last_seen?.value_as_string || "",
            samples,
            scanned: totalHits,
        };
    }
}
