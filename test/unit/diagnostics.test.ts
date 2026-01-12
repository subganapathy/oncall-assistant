/**
 * Unit tests for diagnostic tools.
 *
 * These test the diagnostic functions with mocked backends.
 */

import { describe, it, expect } from "vitest";
import {
    getServiceHealth,
    getRecentDeploys,
    queryLogs,
    getPodStatus,
    checkDependencyHealth,
} from "../../src/tools/diagnostics.js";

describe("Diagnostic Tools", () => {
    // ─────────────────────────────────────────────────────────
    // get_service_health
    // ─────────────────────────────────────────────────────────

    describe("getServiceHealth", () => {
        it("returns health metrics for service", async () => {
            const result = await getServiceHealth({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.error_rate).toBeDefined();
            expect(parsed.p99_latency).toBeDefined();
            expect(parsed.availability).toBeDefined();
            expect(parsed.status).toBeDefined();
        });

        it("includes status determination", async () => {
            const result = await getServiceHealth({ service: "user-service" });
            const parsed = JSON.parse(result);

            // Mock returns healthy data
            expect(["healthy", "degraded", "critical"]).toContain(parsed.status);
        });

        it("returns error for non-existent service", async () => {
            const result = await getServiceHealth({ service: "nonexistent" });
            const parsed = JSON.parse(result);

            expect(parsed.error).toContain("not found");
        });
    });

    // ─────────────────────────────────────────────────────────
    // get_recent_deploys (GitHub-based GitOps)
    // ─────────────────────────────────────────────────────────

    describe("getRecentDeploys", () => {
        it("returns recent deployments from GitHub", async () => {
            const result = await getRecentDeploys({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.github_repo).toBeDefined();
            expect(parsed.deploys).toBeDefined();
            expect(parsed.last_deploy_minutes_ago).toBeDefined();
        });

        it("includes current version and status", async () => {
            const result = await getRecentDeploys({ service: "user-service" });
            const parsed = JSON.parse(result);

            // Mock returns current deployment info
            expect(parsed.current_version).toBeDefined();
            expect(parsed.current_status).toBeDefined();
        });

        it("flags recent deploys with warning", async () => {
            const result = await getRecentDeploys({ service: "user-service" });
            const parsed = JSON.parse(result);

            // Mock has deploy from 15 min ago
            expect(parsed.recent_deploy_warning).toBe(true);
        });

        it("returns error for non-existent service", async () => {
            const result = await getRecentDeploys({ service: "nonexistent" });
            const parsed = JSON.parse(result);

            expect(parsed.error).toContain("not found");
        });
    });

    // ─────────────────────────────────────────────────────────
    // query_logs
    // ─────────────────────────────────────────────────────────

    describe("queryLogs", () => {
        it("returns logs for service", async () => {
            const result = await queryLogs({
                service: "user-service",
                level: "error",
                since: "15m",
            });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.logs).toBeDefined();
            expect(Array.isArray(parsed.logs)).toBe(true);
        });

        it("includes query parameters in response", async () => {
            const result = await queryLogs({
                service: "user-service",
                query: "NullPointerException",
                level: "error",
            });
            const parsed = JSON.parse(result);

            expect(parsed.query).toBe("NullPointerException");
            expect(parsed.level_filter).toBe("error");
        });
    });

    // ─────────────────────────────────────────────────────────
    // get_pod_status
    // ─────────────────────────────────────────────────────────

    describe("getPodStatus", () => {
        it("returns pod status for service", async () => {
            const result = await getPodStatus({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.total_pods).toBeDefined();
            expect(parsed.healthy_pods).toBeDefined();
            expect(parsed.pods).toBeDefined();
        });

        it("respects namespace parameter", async () => {
            const result = await getPodStatus({
                service: "user-service",
                namespace: "staging",
            });
            const parsed = JSON.parse(result);

            expect(parsed.namespace).toBe("staging");
        });
    });

    // ─────────────────────────────────────────────────────────
    // check_dependency_health
    // ─────────────────────────────────────────────────────────

    describe("checkDependencyHealth", () => {
        it("checks all dependencies for service", async () => {
            const result = await checkDependencyHealth({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.dependencies_checked).toBe(2);  // auth-service, postgres-users
            expect(parsed.results).toHaveLength(2);
        });

        it("includes summary of health status", async () => {
            const result = await checkDependencyHealth({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.all_healthy).toBeDefined();
            expect(parsed.summary).toBeDefined();
        });
    });
});
