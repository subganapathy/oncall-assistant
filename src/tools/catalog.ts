/**
 * Catalog tools - query the service catalog.
 *
 * These tools let the agent look up service information:
 * - Who owns this service?
 * - What are its dependencies?
 * - Where are its logs/metrics?
 * - What's the status of a resource? (BYO get_resource)
 */

import { z } from "zod";
import { queryOne, query } from "../lib/db.js";
import type { ServiceCatalog, Dependency } from "../lib/types.js";
import {
    resourceRegistry,
    findServicesForResource,
    getResourceTypeInfo,
} from "../lib/resources.js";

// ─────────────────────────────────────────────────────────────
// TOOL: get_service_catalog
// ─────────────────────────────────────────────────────────────

/**
 * Schema for get_service_catalog input.
 * Zod validates the input before the function runs.
 */
export const getServiceCatalogSchema = {
    service: z.string().describe("Service name to look up"),
};

/**
 * Get the full catalog entry for a service.
 *
 * This is the agent's primary way to get context about a service.
 */
export async function getServiceCatalog(
    input: { service: string }
): Promise<string> {
    const row = await queryOne<ServiceCatalog>(
        `SELECT * FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({
            error: `Service '${input.service}' not found in catalog`,
            suggestion: "Check the service name or list all services",
        });
    }

    // Return formatted catalog entry
    return JSON.stringify(row, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: list_services
// ─────────────────────────────────────────────────────────────

export const listServicesSchema = {
    team: z.string().optional().describe("Filter by team name"),
};

/**
 * List all services (optionally filtered by team).
 */
export async function listServices(
    input: { team?: string }
): Promise<string> {
    let rows: ServiceCatalog[];

    if (input.team) {
        rows = await query<ServiceCatalog>(
            `SELECT name, team, slack_channel FROM services WHERE team = $1 ORDER BY name`,
            [input.team]
        );
    } else {
        rows = await query<ServiceCatalog>(
            `SELECT name, team, slack_channel FROM services ORDER BY name`
        );
    }

    return JSON.stringify({
        count: rows.length,
        services: rows.map((r) => ({
            name: r.name,
            team: r.team,
            slack_channel: r.slack_channel,
        })),
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_dependencies
// ─────────────────────────────────────────────────────────────

export const getDependenciesSchema = {
    service: z.string().describe("Service name"),
    include_transitive: z.boolean().default(false).describe(
        "Include dependencies of dependencies (one level deep)"
    ),
};

/**
 * Get dependencies for a service.
 *
 * Critical for understanding blast radius during incidents.
 */
export async function getDependencies(
    input: { service: string; include_transitive?: boolean }
): Promise<string> {
    // Get the service's direct dependencies
    const row = await queryOne<{ dependencies: Dependency[] }>(
        `SELECT dependencies FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    const result: {
        service: string;
        dependencies: Dependency[];
        transitive?: Record<string, Dependency[]>;
    } = {
        service: input.service,
        dependencies: row.dependencies,
    };

    // Optionally get transitive dependencies (one level)
    if (input.include_transitive) {
        result.transitive = {};

        for (const dep of row.dependencies) {
            if (dep.type === "internal") {
                const depRow = await queryOne<{ dependencies: Dependency[] }>(
                    `SELECT dependencies FROM services WHERE name = $1`,
                    [dep.name]
                );
                if (depRow) {
                    result.transitive[dep.name] = depRow.dependencies;
                }
            }
        }
    }

    return JSON.stringify(result, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_dependents (reverse lookup)
// ─────────────────────────────────────────────────────────────

export const getDependentsSchema = {
    service: z.string().describe("Service name to find dependents of"),
};

/**
 * Find all services that depend on a given service.
 *
 * Critical for understanding impact: "If auth-service is down,
 * what else breaks?"
 */
export async function getDependents(
    input: { service: string }
): Promise<string> {
    // Query services whose dependencies array contains this service
    const rows = await query<{ name: string; team: string }>(
        `SELECT name, team FROM services
         WHERE dependencies @> $1::jsonb`,
        [JSON.stringify([{ name: input.service }])]
    );

    return JSON.stringify({
        service: input.service,
        dependent_count: rows.length,
        dependents: rows,
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_escalation_path
// ─────────────────────────────────────────────────────────────

export const getEscalationPathSchema = {
    service: z.string().describe("Service name"),
};

/**
 * Get escalation info for a service.
 *
 * Who to page at 3am when things are on fire.
 */
export async function getEscalationPath(
    input: { service: string }
): Promise<string> {
    const row = await queryOne<ServiceCatalog>(
        `SELECT team, slack_channel, pager_alias FROM services WHERE name = $1`,
        [input.service]
    );

    if (!row) {
        return JSON.stringify({ error: `Service '${input.service}' not found` });
    }

    return JSON.stringify({
        service: input.service,
        team: row.team,
        slack_channel: row.slack_channel,
        pager_alias: row.pager_alias,
        escalation_command: `pd trigger -s ${row.pager_alias}`,
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: get_resource (BYO Interface)
// ─────────────────────────────────────────────────────────────

export const getResourceSchema = {
    resource_id: z.string().describe("Resource ID to look up (e.g., 'ord-1234', 'res-5678')"),
    include_context: z.boolean().default(true).describe(
        "Include service catalog context (owner, dependencies, observability)"
    ),
};

/**
 * Get resource status and information.
 *
 * This is the main entry point for debugging stuck resources.
 * It combines:
 * 1. BYO handler response (if registered) - actual resource status
 * 2. Service catalog context - who owns it, dependencies, observability
 *
 * AI interprets the semi-structured response to understand:
 * - Current status of the resource
 * - Where the workload is running (namespace, cluster)
 * - What might be blocking it (based on dependencies)
 */
export async function getResource(
    input: { resource_id: string; include_context?: boolean }
): Promise<string> {
    const { resource_id, include_context = true } = input;

    // Get type info from catalog (includes handler_url if configured)
    const typeInfo = await getResourceTypeInfo(resource_id);

    // Try to get live resource status
    let resourceInfo = null;
    let handlerError = null;

    // 1. First, try handler_url if configured in catalog
    if (typeInfo?.handler_url) {
        const url = typeInfo.handler_url.replace("${id}", resource_id);
        try {
            const response = await fetch(url, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(5000), // 5s timeout
            });
            if (response.ok) {
                const data = await response.json() as Record<string, unknown>;
                resourceInfo = {
                    id: resource_id,
                    status: (data.status as string) || "unknown",
                    ...data,
                };
            } else {
                handlerError = `Handler returned ${response.status}`;
            }
        } catch (error) {
            handlerError = error instanceof Error ? error.message : "Handler call failed";
        }
    }

    // 2. Fall back to registered handler or catalog lookup
    if (!resourceInfo) {
        resourceInfo = await resourceRegistry.get(resource_id);
    }

    // Build response
    const response: Record<string, unknown> = {
        resource_id,
    };

    if (typeInfo) {
        response.resource_type = typeInfo.type;
        response.resource_pattern = typeInfo.pattern;
        response.resource_description = typeInfo.description;
        response.owner_service = typeInfo.ownerService;
        if (typeInfo.handler_url) {
            response.handler_url = typeInfo.handler_url.replace("${id}", resource_id);
        }
    }

    if (resourceInfo) {
        response.status = resourceInfo.status;
        response.resource_data = resourceInfo;
    } else {
        response.status = "not_found";
        if (handlerError) {
            response.handler_error = handlerError;
        }
        response.note = "No handler registered and resource ID doesn't match any catalog patterns. " +
                       "Either the resource doesn't exist or the owning service hasn't registered a handler.";
    }

    // Include service catalog context
    if (include_context && typeInfo) {
        const { owner, relatedServices } = await findServicesForResource(resource_id);

        if (owner) {
            response.owner_context = {
                service: owner.name,
                team: owner.team,
                description: owner.description,
                slack_channel: owner.slack_channel,
                pagerduty_service: owner.pagerduty_service || owner.pager_alias,
                dependencies: owner.dependencies,
                observability: owner.observability,
            };
        }

        if (relatedServices.length > 0) {
            response.related_services = relatedServices.map((s) => ({
                name: s.name,
                team: s.team,
                description: s.description,
                purpose: s.description?.split(".")[0], // First sentence as quick purpose
            }));
        }
    }

    return JSON.stringify(response, null, 2);
}

// ─────────────────────────────────────────────────────────────
// TOOL: find_resource_owner
// ─────────────────────────────────────────────────────────────

export const findResourceOwnerSchema = {
    resource_id: z.string().describe("Resource ID to find owner for"),
};

/**
 * Find which service owns a resource.
 *
 * Quick lookup without fetching full resource data.
 * Useful for AI to understand where to look next.
 */
export async function findResourceOwner(
    input: { resource_id: string }
): Promise<string> {
    const ownerName = await resourceRegistry.findOwner(input.resource_id);

    if (!ownerName) {
        return JSON.stringify({
            resource_id: input.resource_id,
            owner: null,
            error: "No service found that owns this resource pattern",
        });
    }

    // Get full service info
    const service = await queryOne<ServiceCatalog>(
        `SELECT * FROM services WHERE name = $1`,
        [ownerName]
    );

    if (!service) {
        return JSON.stringify({
            resource_id: input.resource_id,
            owner: ownerName,
            error: "Service found in pattern match but not in catalog",
        });
    }

    return JSON.stringify({
        resource_id: input.resource_id,
        owner: {
            service: service.name,
            team: service.team,
            description: service.description,
            slack_channel: service.slack_channel,
            dependencies: service.dependencies?.map((d) => d.name),
        },
    }, null, 2);
}

// ─────────────────────────────────────────────────────────────
// EXPORT: Resource registry for BYO registration
// ─────────────────────────────────────────────────────────────

export { resourceRegistry } from "../lib/resources.js";
