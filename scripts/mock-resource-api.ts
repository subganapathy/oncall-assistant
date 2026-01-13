/**
 * Mock Resource API Server
 *
 * Simulates a team's resource API that returns live status for resources.
 * Used for testing the handler_url feature.
 *
 * Run with: npx tsx scripts/mock-resource-api.ts
 */

import express from "express";

const app = express();
const PORT = 4000;

// Simulated resource data
const resources: Record<string, Record<string, unknown>> = {
    // Orders
    "ord-1234": {
        status: "PENDING",
        created_at: "2024-01-10T10:00:00Z",
        updated_at: "2024-01-10T10:30:00Z",
        customer_id: "cust-789",
        items: [
            { sku: "WIDGET-001", qty: 2 },
            { sku: "GADGET-002", qty: 1 },
        ],
        total: 149.99,
        region: "us-east",
        namespace: "orders-us-east",
        cluster: "prod-us-east-1",
        error: "Database connection timeout after 30s",
    },
    "ord-5678": {
        status: "SHIPPED",
        created_at: "2024-01-09T08:00:00Z",
        updated_at: "2024-01-10T14:00:00Z",
        customer_id: "cust-456",
        items: [{ sku: "WIDGET-001", qty: 1 }],
        total: 49.99,
        region: "us-west",
        namespace: "orders-us-west",
        cluster: "prod-us-west-2",
        tracking_number: "1Z999AA10123456784",
    },

    // Users
    "usr-1234": {
        status: "ACTIVE",
        created_at: "2023-06-15T00:00:00Z",
        email: "alice@example.com",
        plan: "premium",
        last_login: "2024-01-10T09:00:00Z",
    },

    // Auth tokens
    "tok-abc123": {
        status: "VALID",
        created_at: "2024-01-10T08:00:00Z",
        expires_at: "2024-01-10T20:00:00Z",
        user_id: "usr-1234",
        scopes: ["read", "write"],
    },

    // Sessions
    "sess-xyz789": {
        status: "ACTIVE",
        created_at: "2024-01-10T08:00:00Z",
        user_id: "usr-1234",
        ip_address: "192.168.1.100",
        user_agent: "Mozilla/5.0...",
    },
};

// GET /resources/:id - Return resource status
app.get("/resources/:id", (req, res) => {
    const { id } = req.params;

    console.log(`[${new Date().toISOString()}] GET /resources/${id}`);

    const resource = resources[id];

    if (resource) {
        res.json({
            id,
            ...resource,
        });
    } else {
        // Return a generic "not found" status for unknown resources
        res.json({
            id,
            status: "NOT_FOUND",
            error: `Resource ${id} not found in system`,
        });
    }
});

// Health check
app.get("/health", (_req, res) => {
    res.json({ status: "healthy" });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Mock Resource API running on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET /resources/:id  - Get resource status`);
    console.log(`  GET /health         - Health check`);
    console.log(`\nExample resources:`);
    Object.keys(resources).forEach((id) => {
        console.log(`  - ${id} (${(resources[id].status as string)})`);
    });
    console.log(`\nTest with:`);
    console.log(`  curl http://localhost:${PORT}/resources/ord-1234`);
});
