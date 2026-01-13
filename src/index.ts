/**
 * On-Call Assistant MCP Server
 *
 * This is the main entry point. It creates an MCP server that exposes
 * tools for querying the service catalog and diagnosing incidents.
 *
 * Run with: npm run dev (development) or npm start (production)
 *
 * Claude (or any MCP client) can then connect and use these tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Import our tools
import {
    getServiceCatalog,
    getServiceCatalogSchema,
    listServices,
    listServicesSchema,
    getDependencies,
    getDependenciesSchema,
    getDependents,
    getDependentsSchema,
    getEscalationPath,
    getEscalationPathSchema,
    getResource,
    getResourceSchema,
    findResourceOwner,
    findResourceOwnerSchema,
} from "./tools/catalog.js";

import {
    getServiceHealth,
    getServiceHealthSchema,
    getRecentDeploys,
    getRecentDeploysSchema,
    queryLogs,
    queryLogsSchema,
    getPodStatus,
    getPodStatusSchema,
    checkDependencyHealth,
    checkDependencyHealthSchema,
    scanLogPatterns,
    scanLogPatternsSchema,
    getPodLogs,
    getPodLogsSchema,
    checkAwsHealth,
    checkAwsHealthSchema,
    checkRuntimeMetrics,
    checkRuntimeMetricsSchema,
} from "./tools/diagnostics.js";

// ─────────────────────────────────────────────────────────────
// CREATE MCP SERVER
// ─────────────────────────────────────────────────────────────

const server = new McpServer({
    name: "oncall-assistant",
    version: "0.1.0",
});

// ─────────────────────────────────────────────────────────────
// CATALOG TOOLS
// ─────────────────────────────────────────────────────────────

server.tool(
    "get_service_catalog",
    "Get full catalog entry for a service including team, dependencies, observability config, and automation policy",
    getServiceCatalogSchema,
    async (input) => ({
        content: [{ type: "text", text: await getServiceCatalog(input) }],
    })
);

server.tool(
    "list_services",
    "List all services in the catalog, optionally filtered by team",
    listServicesSchema,
    async (input) => ({
        content: [{ type: "text", text: await listServices(input) }],
    })
);

server.tool(
    "get_dependencies",
    "Get dependencies for a service (what it depends on)",
    getDependenciesSchema,
    async (input) => ({
        content: [{ type: "text", text: await getDependencies(input) }],
    })
);

server.tool(
    "get_dependents",
    "Get services that depend on a given service (reverse dependency lookup)",
    getDependentsSchema,
    async (input) => ({
        content: [{ type: "text", text: await getDependents(input) }],
    })
);

server.tool(
    "get_escalation_path",
    "Get escalation info for a service (team, slack channel, pager alias)",
    getEscalationPathSchema,
    async (input) => ({
        content: [{ type: "text", text: await getEscalationPath(input) }],
    })
);

server.tool(
    "get_resource",
    "Get resource status and info by ID. This is the main tool for debugging stuck provisioning. Returns resource status, owner service context, and dependencies. AI interprets the semi-structured response.",
    getResourceSchema,
    async (input) => ({
        content: [{ type: "text", text: await getResource(input) }],
    })
);

server.tool(
    "find_resource_owner",
    "Find which service owns a resource by ID pattern matching. Quick lookup to understand where to investigate.",
    findResourceOwnerSchema,
    async (input) => ({
        content: [{ type: "text", text: await findResourceOwner(input) }],
    })
);

// ─────────────────────────────────────────────────────────────
// DIAGNOSTIC TOOLS
// ─────────────────────────────────────────────────────────────

server.tool(
    "get_service_health",
    "Get current health metrics (error rate, latency, availability) for a service",
    getServiceHealthSchema,
    async (input) => ({
        content: [{ type: "text", text: await getServiceHealth(input) }],
    })
);

server.tool(
    "get_recent_deploys",
    "Get recent deployments for a service from ArgoCD",
    getRecentDeploysSchema,
    async (input) => ({
        content: [{ type: "text", text: await getRecentDeploys(input) }],
    })
);

server.tool(
    "query_logs",
    "Search logs in OpenSearch for a service",
    queryLogsSchema,
    async (input) => ({
        content: [{ type: "text", text: await queryLogs(input) }],
    })
);

server.tool(
    "get_pod_status",
    "Get current pod status from Kubernetes",
    getPodStatusSchema,
    async (input) => ({
        content: [{ type: "text", text: await getPodStatus(input) }],
    })
);

server.tool(
    "check_dependency_health",
    "Check health of all dependencies for a service (internal services, AWS resources, external APIs)",
    checkDependencyHealthSchema,
    async (input) => ({
        content: [{ type: "text", text: await checkDependencyHealth(input) }],
    })
);

server.tool(
    "scan_log_patterns",
    "Scan logs for known error patterns based on service language (Java OOM, Go panics, etc.) and common infra patterns",
    scanLogPatternsSchema,
    async (input) => ({
        content: [{ type: "text", text: await scanLogPatterns(input) }],
    })
);

server.tool(
    "get_pod_logs",
    "Get logs directly from a Kubernetes pod (real-time, no indexing delay). Supports crash logs via --previous flag",
    getPodLogsSchema,
    async (input) => ({
        content: [{ type: "text", text: await getPodLogs(input) }],
    })
);

server.tool(
    "check_aws_health",
    "Check AWS Health API for active outages affecting a service's AWS dependencies (RDS, SQS, etc.)",
    checkAwsHealthSchema,
    async (input) => ({
        content: [{ type: "text", text: await checkAwsHealth(input) }],
    })
);

server.tool(
    "check_runtime_metrics",
    "Check if a service is publishing language-specific runtime metrics (JVM for Java, goroutines for Go, etc.)",
    checkRuntimeMetricsSchema,
    async (input) => ({
        content: [{ type: "text", text: await checkRuntimeMetrics(input) }],
    })
);

// ─────────────────────────────────────────────────────────────
// RESOURCES (for direct data access)
// ─────────────────────────────────────────────────────────────

server.resource(
    "catalog://services",
    "List of all services in the catalog",
    async () => {
        const result = await listServices({});
        return {
            contents: [{
                uri: "catalog://services",
                mimeType: "application/json",
                text: result,
            }],
        };
    }
);

// ─────────────────────────────────────────────────────────────
// PROMPTS (reusable prompt templates)
// ─────────────────────────────────────────────────────────────

server.prompt(
    "diagnose-incident",
    "Diagnose an incident from an alert",
    {
        service: z.string().describe("Service experiencing the incident"),
        alert_name: z.string().describe("Name of the alert that fired"),
        alert_message: z.string().optional().describe("Alert message/details"),
        cluster: z.string().optional().describe("Kubernetes cluster"),
    },
    async ({ service, alert_name, alert_message, cluster }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Alert fired on ${service}: ${alert_name}${alert_message ? `\nMessage: ${alert_message}` : ""}${cluster ? `\nCluster: ${cluster}` : ""}

Diagnose and recommend actions.`,
            },
        }],
    })
);

server.prompt(
    "verify-deployment",
    "Verify a deployment is healthy",
    {
        service: z.string().describe("Service that was deployed"),
        version: z.string().optional().describe("Version deployed"),
    },
    async ({ service, version }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Verify ${service}${version ? ` ${version}` : ""} deployment is healthy.`,
            },
        }],
    })
);

server.prompt(
    "debug-stuck-resource",
    "Debug a stuck resource",
    {
        resource_id: z.string().describe("Resource ID (e.g., 'ord-1234')"),
        symptom: z.string().optional().describe("Symptom if known"),
    },
    async ({ resource_id, symptom }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Debug ${resource_id}${symptom ? ` - ${symptom}` : ""}`,
            },
        }],
    })
);

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

async function main() {
    // Use stdio transport (standard for MCP)
    const transport = new StdioServerTransport();

    // Connect and start serving
    await server.connect(transport);

    console.error("🚀 On-Call Assistant MCP Server running");
    console.error("   Tools: 16 available");
    console.error("     Catalog: get_service_catalog, list_services, get_dependencies, get_dependents, get_escalation_path");
    console.error("     Resources: get_resource, find_resource_owner");
    console.error("     Diagnostics: get_service_health, get_recent_deploys, query_logs, get_pod_status, check_dependency_health");
    console.error("     Advanced: scan_log_patterns, get_pod_logs, check_aws_health, check_runtime_metrics");
    console.error("   Resources: 1 available");
    console.error("   Prompts: 3 available (diagnose-incident, verify-deployment, debug-stuck-resource)");
}

main().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
});
