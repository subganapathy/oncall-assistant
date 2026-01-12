/**
 * Unit tests for catalog tools.
 *
 * These test the tool functions in isolation with mocked database.
 */

import { describe, it, expect } from "vitest";
import {
    getServiceCatalog,
    listServices,
    getDependencies,
    getDependents,
    getEscalationPath,
    getResource,
    findResourceOwner,
} from "../../src/tools/catalog.js";

describe("Catalog Tools", () => {
    // ─────────────────────────────────────────────────────────
    // get_service_catalog
    // ─────────────────────────────────────────────────────────

    describe("getServiceCatalog", () => {
        it("returns catalog entry for existing service", async () => {
            const result = await getServiceCatalog({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.name).toBe("user-service");
            expect(parsed.team).toBe("payments");
            expect(parsed.slack_channel).toBe("#payments-oncall");
            expect(parsed.observability.grafana_uid).toBe("user-service-prod");
        });

        it("returns error for non-existent service", async () => {
            const result = await getServiceCatalog({ service: "nonexistent" });
            const parsed = JSON.parse(result);

            expect(parsed.error).toContain("not found");
        });
    });

    // ─────────────────────────────────────────────────────────
    // list_services
    // ─────────────────────────────────────────────────────────

    describe("listServices", () => {
        it("lists all services when no filter", async () => {
            const result = await listServices({});
            const parsed = JSON.parse(result);

            expect(parsed.count).toBe(3);
            expect(parsed.services).toHaveLength(3);
        });

        it("filters by team", async () => {
            const result = await listServices({ team: "payments" });
            const parsed = JSON.parse(result);

            expect(parsed.count).toBe(1);
            expect(parsed.services[0].name).toBe("user-service");
        });
    });

    // ─────────────────────────────────────────────────────────
    // get_dependencies
    // ─────────────────────────────────────────────────────────

    describe("getDependencies", () => {
        it("returns dependencies for service", async () => {
            const result = await getDependencies({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.service).toBe("user-service");
            expect(parsed.dependencies).toHaveLength(2);
            expect(parsed.dependencies[0].name).toBe("auth-service");
            expect(parsed.dependencies[0].critical).toBe(true);
        });

        it("returns error for non-existent service", async () => {
            const result = await getDependencies({ service: "nonexistent" });
            const parsed = JSON.parse(result);

            expect(parsed.error).toContain("not found");
        });
    });

    // ─────────────────────────────────────────────────────────
    // get_escalation_path
    // ─────────────────────────────────────────────────────────

    describe("getEscalationPath", () => {
        it("returns escalation info for service", async () => {
            const result = await getEscalationPath({ service: "user-service" });
            const parsed = JSON.parse(result);

            expect(parsed.team).toBe("payments");
            expect(parsed.slack_channel).toBe("#payments-oncall");
            expect(parsed.pager_alias).toBe("payments-escalation");
            expect(parsed.escalation_command).toContain("payments-escalation");
        });
    });

    // ─────────────────────────────────────────────────────────
    // get_resource (BYO Interface)
    // ─────────────────────────────────────────────────────────

    describe("getResource", () => {
        it("returns resource info with owner context for matching pattern", async () => {
            const result = await getResource({ resource_id: "ord-1234" });
            const parsed = JSON.parse(result);

            expect(parsed.resource_id).toBe("ord-1234");
            expect(parsed.resource_type).toBe("order");
            expect(parsed.owner_service).toBe("order-service");
            expect(parsed.resource_description).toContain("Customer order");
        });

        it("returns owner context with dependencies", async () => {
            const result = await getResource({ resource_id: "ord-1234", include_context: true });
            const parsed = JSON.parse(result);

            expect(parsed.owner_context).toBeDefined();
            expect(parsed.owner_context.service).toBe("order-service");
            expect(parsed.owner_context.team).toBe("commerce");
            expect(parsed.owner_context.dependencies).toBeDefined();
        });

        it("returns not_found for unmatched resource pattern", async () => {
            const result = await getResource({ resource_id: "unknown-1234" });
            const parsed = JSON.parse(result);

            expect(parsed.status).toBe("not_found");
            expect(parsed.note).toContain("No handler registered");
        });

        it("returns resource info without context when include_context is false", async () => {
            const result = await getResource({ resource_id: "usr-5678", include_context: false });
            const parsed = JSON.parse(result);

            expect(parsed.resource_id).toBe("usr-5678");
            expect(parsed.resource_type).toBe("user-account");
            expect(parsed.owner_context).toBeUndefined();
        });

        it("matches different resource patterns to correct services", async () => {
            // Test user pattern
            const userResult = await getResource({ resource_id: "usr-1234" });
            const userParsed = JSON.parse(userResult);
            expect(userParsed.owner_service).toBe("user-service");

            // Test token pattern
            const tokenResult = await getResource({ resource_id: "tok-5678" });
            const tokenParsed = JSON.parse(tokenResult);
            expect(tokenParsed.owner_service).toBe("auth-service");

            // Test session pattern
            const sessResult = await getResource({ resource_id: "sess-9012" });
            const sessParsed = JSON.parse(sessResult);
            expect(sessParsed.owner_service).toBe("auth-service");
        });
    });

    // ─────────────────────────────────────────────────────────
    // find_resource_owner
    // ─────────────────────────────────────────────────────────

    describe("findResourceOwner", () => {
        it("finds owner for resource matching pattern", async () => {
            const result = await findResourceOwner({ resource_id: "ord-1234" });
            const parsed = JSON.parse(result);

            expect(parsed.resource_id).toBe("ord-1234");
            expect(parsed.owner).toBeDefined();
            expect(parsed.owner.service).toBe("order-service");
            expect(parsed.owner.team).toBe("commerce");
        });

        it("returns null owner for unmatched pattern", async () => {
            const result = await findResourceOwner({ resource_id: "xyz-1234" });
            const parsed = JSON.parse(result);

            expect(parsed.owner).toBeNull();
            expect(parsed.error).toContain("No service found");
        });

        it("includes service description in owner info", async () => {
            const result = await findResourceOwner({ resource_id: "usr-1234" });
            const parsed = JSON.parse(result);

            expect(parsed.owner.description).toContain("System of record for user accounts");
        });
    });
});
