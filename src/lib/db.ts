/**
 * Database connection and utilities.
 *
 * This module provides a connection pool to PostgreSQL.
 * We use a pool (not single connection) because:
 * - Multiple requests can run concurrently
 * - Connections are reused (efficient)
 * - Automatic reconnection on failure
 */

import pg from "pg";
const { Pool } = pg;

// ─────────────────────────────────────────────────────────────
// CONNECTION POOL
// ─────────────────────────────────────────────────────────────

/**
 * Create the database pool.
 * Reads connection info from environment variables.
 *
 * In production, set DATABASE_URL.
 * In development, docker-compose sets individual vars.
 */
export const pool = new Pool({
    // If DATABASE_URL is set, use it (production pattern)
    connectionString: process.env.DATABASE_URL,

    // Otherwise, use individual vars (docker-compose pattern)
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "oncall",
    user: process.env.PGUSER || "oncall",
    password: process.env.PGPASSWORD || "oncall",

    // Pool settings
    max: 20,                       // Max connections in pool
    idleTimeoutMillis: 30000,      // Close idle connections after 30s
    connectionTimeoutMillis: 2000,  // Fail fast if can't connect
});

// Log connection errors (don't crash, just log)
pool.on("error", (err) => {
    console.error("Unexpected database error:", err);
});

// ─────────────────────────────────────────────────────────────
// QUERY HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Execute a query and return rows.
 *
 * Usage:
 *   const services = await query<ServiceCatalog>(
 *     "SELECT * FROM services WHERE team = $1",
 *     ["payments"]
 *   );
 */
export async function query<T>(
    text: string,
    params?: unknown[]
): Promise<T[]> {
    const result = await pool.query(text, params);
    return result.rows as T[];
}

/**
 * Execute a query and return first row (or null).
 *
 * Usage:
 *   const service = await queryOne<ServiceCatalog>(
 *     "SELECT * FROM services WHERE name = $1",
 *     ["user-service"]
 *   );
 */
export async function queryOne<T>(
    text: string,
    params?: unknown[]
): Promise<T | null> {
    const rows = await query<T>(text, params);
    return rows[0] || null;
}

/**
 * Execute a query that doesn't return data (INSERT, UPDATE, DELETE).
 *
 * Usage:
 *   await execute(
 *     "UPDATE services SET updated_at = NOW() WHERE name = $1",
 *     ["user-service"]
 *   );
 */
export async function execute(
    text: string,
    params?: unknown[]
): Promise<void> {
    await pool.query(text, params);
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────

/**
 * Check if database is reachable.
 * Used by health check endpoints.
 */
export async function checkHealth(): Promise<boolean> {
    try {
        await pool.query("SELECT 1");
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

/**
 * Close all connections.
 * Call this when shutting down the server.
 */
export async function close(): Promise<void> {
    await pool.end();
}
