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
    "Full incident diagnosis workflow",
    {
        service: z.string().describe("Service experiencing the incident"),
        alert_name: z.string().describe("Name of the alert that fired"),
        alert_message: z.string().describe("Alert message/details"),
        cluster: z.string().describe("Kubernetes cluster where the alert fired"),
    },
    async ({ service, alert_name, alert_message, cluster }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `You are an on-call assistant. An alert has fired:

SERVICE: ${service}
ALERT: ${alert_name}
MESSAGE: ${alert_message}
CLUSTER: ${cluster}

Please diagnose this incident by following these steps:

1. **Get Context**: Use get_service_catalog to understand the service (team, dependencies, language)
2. **Check Health**: Use get_service_health for current metrics (error rate, latency, availability)
3. **AWS Outage Check**: Use check_aws_health to see if AWS has an active outage affecting dependencies
4. **Recent Changes**: Use get_recent_deploys to check for recent deployments (correlation!)
5. **Dependencies**: Use check_dependency_health to see if upstream services/AWS resources are the cause
6. **Log Pattern Scan**: Use scan_log_patterns to find language-specific errors (OOM, panics, etc.)
7. **Pod Status**: Use get_pod_status to check Kubernetes state (restarts, crashes)
8. **Pod Logs**: If pods are crashing, use get_pod_logs with previous=true to get crash output
9. **Runtime Metrics**: Use check_runtime_metrics to verify observability is properly configured

Based on your findings, provide:
- **Severity**: P0/P1/P2/P3
- **Root Cause Hypothesis**: What you think caused this
- **Evidence**: What data supports your hypothesis
- **Recommended Actions**: What should be done
- **Escalation**: Should we page someone?

Be systematic and thorough.`,
            },
        }],
    })
);

server.prompt(
    "verify-deployment",
    "Post-deployment verification",
    {
        service: z.string().describe("Service that was deployed"),
        version: z.string().describe("Version deployed"),
        cluster: z.string().describe("Kubernetes cluster"),
    },
    async ({ service, version, cluster }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `I just deployed ${service} version ${version} to ${cluster}.

Please verify the deployment is healthy:

1. Use get_service_health to check error rate and latency
2. Use scan_log_patterns since="5m" to check for new error patterns
3. Use get_pod_status to verify pods are running (no restarts)
4. Use check_dependency_health to verify dependencies are ok
5. Use check_runtime_metrics to verify runtime metrics are being published

Report:
- Is the deployment healthy? (YES/NO)
- Any concerning metrics or logs?
- Any action needed?`,
            },
        }],
    })
);

server.prompt(
    "debug-stuck-resource",
    "Debug a stuck or failing resource (provisioning, order, etc.)",
    {
        resource_id: z.string().describe("Resource ID that's stuck (e.g., 'ord-1234', 'res-5678')"),
        symptom: z.string().optional().describe("What's the symptom? (e.g., 'stuck in PENDING', 'pods crashing')"),
    },
    async ({ resource_id, symptom }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Debug this stuck resource:

RESOURCE ID: ${resource_id}
SYMPTOM: ${symptom || "Unknown - please investigate"}

Follow these steps:

1. **Get Resource Status**: Use get_resource to get current status and owner service
   - AI will interpret the semi-structured response
   - Look for workload location (namespace, cluster) in the response

2. **Understand Context**: From the resource response, identify:
   - Which service is the system of record
   - What dependencies the owner service has
   - Where the workload should be running

3. **Check Owner Service**: Use get_service_catalog on the owner service
   - Understand its dependencies
   - Check its observability config

4. **Search for Evidence**:
   - Use query_logs to search for the resource_id across relevant services
   - Check which services have seen this resource and which haven't
   - The gap tells you where it's stuck

5. **Check Dependencies**: For each dependency of the owner service:
   - Use get_service_health to check if it's healthy
   - Look for the resource_id in dependency logs

6. **If Workload Exists**:
   - Use get_pod_status to check pod health
   - Use get_pod_logs if pods are crashing
   - Use scan_log_patterns for language-specific errors

Report:
- **Current State**: Where is the resource in its lifecycle?
- **Stuck At**: Which service/step is it blocked on?
- **Root Cause**: What's preventing progress?
- **Action**: What should be done to unblock?
- **Owner**: Who should be contacted?`,
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
