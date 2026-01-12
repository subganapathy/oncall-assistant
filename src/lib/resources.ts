/**
 * Resource Handler Registry
 *
 * This module provides the BYO (Bring Your Own) interface for resource lookup.
 * Teams register handlers for their resource patterns, and the registry
 * routes get_resource calls to the appropriate handler.
 *
 * Example usage:
 *
 *   import { resourceRegistry } from './lib/resources.js';
 *
 *   // Team registers their handler
 *   resourceRegistry.register('ord-*', async (id) => {
 *     const order = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
 *     return {
 *       id,
 *       status: order.status,
 *       spec: order,
 *       // AI will find these and understand workload location
 *       namespace: `orders-${order.region}`,
 *       cluster: `prod-${order.region}`,
 *     };
 *   });
 *
 *   // Later, get_resource tool calls:
 *   const info = await resourceRegistry.get('ord-1234');
 */

import { query } from "./db.js";
import type {
    ResourceHandler,
    ResourceHandlerRegistry,
    ResourceInfo,
    ServiceCatalog,
} from "./types.js";

/**
 * Matches a resource ID against a glob pattern.
 * Supports simple * wildcards.
 */
function matchPattern(pattern: string, id: string): boolean {
    // Convert glob pattern to regex
    const regexStr = "^" + pattern.replace(/\*/g, ".*") + "$";
    const regex = new RegExp(regexStr);
    return regex.test(id);
}

/**
 * Default implementation of ResourceHandlerRegistry.
 */
class DefaultResourceHandlerRegistry implements ResourceHandlerRegistry {
    private handlers: Map<string, ResourceHandler> = new Map();

    register(pattern: string, handler: ResourceHandler): void {
        this.handlers.set(pattern, handler);
    }

    async get(id: string): Promise<ResourceInfo | null> {
        // First, try registered handlers
        for (const [pattern, handler] of this.handlers) {
            if (matchPattern(pattern, id)) {
                return handler(id);
            }
        }

        // Fall back to service catalog lookup
        return this.lookupFromCatalog(id);
    }

    async findOwner(id: string): Promise<string | null> {
        // Check registered handlers first
        for (const [pattern] of this.handlers) {
            if (matchPattern(pattern, id)) {
                // Find which service owns this pattern
                const services = await query<ServiceCatalog>(
                    `SELECT name, resources FROM services WHERE resources IS NOT NULL`
                );

                for (const service of services) {
                    if (service.resources) {
                        for (const resource of service.resources) {
                            if (matchPattern(resource.pattern, id)) {
                                return service.name;
                            }
                        }
                    }
                }
            }
        }

        // Try catalog lookup
        const services = await query<ServiceCatalog>(
            `SELECT name, resources FROM services WHERE resources IS NOT NULL`
        );

        for (const service of services) {
            if (service.resources) {
                for (const resource of service.resources) {
                    if (matchPattern(resource.pattern, id)) {
                        return service.name;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Look up resource info from service catalog.
     * This is the fallback when no handler is registered.
     * It finds the owning service and returns basic info.
     */
    private async lookupFromCatalog(id: string): Promise<ResourceInfo | null> {
        const services = await query<ServiceCatalog>(
            `SELECT * FROM services WHERE resources IS NOT NULL`
        );

        for (const service of services) {
            if (service.resources) {
                for (const resource of service.resources) {
                    if (matchPattern(resource.pattern, id)) {
                        // Found the owning service
                        return {
                            id,
                            status: "unknown",
                            type: resource.type,
                            owner_service: service.name,
                            owner_team: service.team,
                            resource_description: resource.description,
                            service_description: service.description,
                            dependencies: service.dependencies,
                            observability: service.observability,
                            note: "No handler registered. This is catalog-only info. " +
                                  "For full resource status, the owning team should " +
                                  "register a get_resource handler.",
                        };
                    }
                }
            }
        }

        return null;
    }
}

/**
 * Global resource registry instance.
 * Teams register their handlers here.
 */
export const resourceRegistry: ResourceHandlerRegistry = new DefaultResourceHandlerRegistry();

/**
 * Find all services that might know about a resource.
 * Returns services ordered by relevance:
 * 1. Services that directly own the resource pattern
 * 2. Services that depend on the owning service
 */
export async function findServicesForResource(id: string): Promise<{
    owner: ServiceCatalog | null;
    relatedServices: ServiceCatalog[];
}> {
    const allServices = await query<ServiceCatalog>(`SELECT * FROM services`);

    let owner: ServiceCatalog | null = null;
    const relatedServices: ServiceCatalog[] = [];

    // Find owner
    for (const service of allServices) {
        if (service.resources) {
            for (const resource of service.resources) {
                if (matchPattern(resource.pattern, id)) {
                    owner = service;
                    break;
                }
            }
        }
        if (owner) break;
    }

    // If we found an owner, find services that depend on it
    if (owner) {
        for (const service of allServices) {
            if (service.name === owner.name) continue;

            // Check if this service depends on the owner
            const dependsOnOwner = service.dependencies?.some(
                (dep) => dep.type === "internal" && dep.name === owner!.name
            );

            // Check if owner depends on this service
            const ownerDependsOn = owner.dependencies?.some(
                (dep) => dep.type === "internal" && dep.name === service.name
            );

            if (dependsOnOwner || ownerDependsOn) {
                relatedServices.push(service);
            }
        }
    }

    return { owner, relatedServices };
}

/**
 * Get resource type info from the catalog.
 */
export async function getResourceTypeInfo(id: string): Promise<{
    type: string;
    pattern: string;
    description: string;
    ownerService: string;
} | null> {
    const services = await query<ServiceCatalog>(
        `SELECT name, resources FROM services WHERE resources IS NOT NULL`
    );

    for (const service of services) {
        if (service.resources) {
            for (const resource of service.resources) {
                if (matchPattern(resource.pattern, id)) {
                    return {
                        type: resource.type,
                        pattern: resource.pattern,
                        description: resource.description,
                        ownerService: service.name,
                    };
                }
            }
        }
    }

    return null;
}
