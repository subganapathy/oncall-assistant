/**
 * Database migration script.
 *
 * Run with: npm run db:migrate
 *
 * This creates all the tables needed for the service catalog.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */

import { pool, close } from "../src/lib/db.js";

async function migrate() {
    console.log("🔄 Running database migrations...\n");

    // ─────────────────────────────────────────────────────────────
    // SERVICES TABLE
    // ─────────────────────────────────────────────────────────────

    console.log("Creating services table...");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS services (
            -- Identity (primary key)
            name            TEXT PRIMARY KEY,

            -- Ownership
            team            TEXT NOT NULL,
            slack_channel   TEXT NOT NULL,
            pager_alias     TEXT NOT NULL,

            -- Configuration (JSONB for flexibility)
            observability   JSONB NOT NULL DEFAULT '{}',
            dependencies    JSONB NOT NULL DEFAULT '[]',
            deployment      JSONB NOT NULL DEFAULT '{}',
            automation      JSONB NOT NULL DEFAULT '{"allowed_actions": [], "requires_approval": []}',
            runbook_path    TEXT,

            -- Metadata
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Index for team queries ("show me all services owned by payments")
        CREATE INDEX IF NOT EXISTS idx_services_team ON services(team);

        -- GIN index for dependency queries ("what depends on auth-service")
        CREATE INDEX IF NOT EXISTS idx_services_deps ON services USING GIN (dependencies);

        COMMENT ON TABLE services IS 'Service catalog - metadata about each service for on-call assistance';
        COMMENT ON COLUMN services.name IS 'Service name, e.g., user-service';
        COMMENT ON COLUMN services.observability IS 'Where to find logs, metrics, dashboards';
        COMMENT ON COLUMN services.dependencies IS 'Array of {name, type, critical} objects';
        COMMENT ON COLUMN services.automation IS 'What actions agent can take without approval';
    `);
    console.log("✓ services table ready\n");

    // ─────────────────────────────────────────────────────────────
    // ALERTS TABLE (for history/audit)
    // ─────────────────────────────────────────────────────────────

    console.log("Creating alerts table...");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id              TEXT PRIMARY KEY,
            service         TEXT NOT NULL REFERENCES services(name),
            name            TEXT NOT NULL,
            severity        TEXT NOT NULL,
            message         TEXT NOT NULL,
            instance        JSONB NOT NULL DEFAULT '{}',
            slack_context   JSONB NOT NULL DEFAULT '{}',
            fired_at        TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_service ON alerts(service);
        CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts(fired_at DESC);

        COMMENT ON TABLE alerts IS 'Alert history for audit and analysis';
    `);
    console.log("✓ alerts table ready\n");

    // ─────────────────────────────────────────────────────────────
    // DIAGNOSES TABLE (agent outputs)
    // ─────────────────────────────────────────────────────────────

    console.log("Creating diagnoses table...");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS diagnoses (
            id              SERIAL PRIMARY KEY,
            alert_id        TEXT NOT NULL REFERENCES alerts(id),
            service         TEXT NOT NULL,
            severity        TEXT NOT NULL,
            summary         TEXT NOT NULL,
            root_cause      JSONB NOT NULL,
            impact          JSONB NOT NULL,
            actions         JSONB NOT NULL,
            escalation      JSONB NOT NULL,
            links           JSONB NOT NULL DEFAULT '{}',
            diagnosed_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_diagnoses_alert ON diagnoses(alert_id);
        CREATE INDEX IF NOT EXISTS idx_diagnoses_service ON diagnoses(service);

        COMMENT ON TABLE diagnoses IS 'Agent diagnosis outputs - what the agent concluded and recommended';
    `);
    console.log("✓ diagnoses table ready\n");

    // ─────────────────────────────────────────────────────────────
    // DEPLOYMENTS TABLE (from ArgoCD webhooks)
    // ─────────────────────────────────────────────────────────────

    console.log("Creating deployments table...");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS deployments (
            id              SERIAL PRIMARY KEY,
            service         TEXT NOT NULL REFERENCES services(name),
            version         TEXT NOT NULL,
            previous_version TEXT,
            deployed_at     TIMESTAMP WITH TIME ZONE NOT NULL,
            deployed_by     TEXT,
            status          TEXT NOT NULL,
            argocd_app      TEXT NOT NULL,
            commit_message  TEXT,
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service);
        CREATE INDEX IF NOT EXISTS idx_deployments_deployed_at ON deployments(deployed_at DESC);

        COMMENT ON TABLE deployments IS 'Deployment history from ArgoCD webhooks';
    `);
    console.log("✓ deployments table ready\n");

    // ─────────────────────────────────────────────────────────────
    // UPDATED_AT TRIGGER
    // ─────────────────────────────────────────────────────────────

    console.log("Creating updated_at trigger...");
    await pool.query(`
        -- Function to auto-update updated_at
        CREATE OR REPLACE FUNCTION update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        -- Apply to services table
        DROP TRIGGER IF EXISTS services_updated_at ON services;
        CREATE TRIGGER services_updated_at
            BEFORE UPDATE ON services
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
    `);
    console.log("✓ updated_at trigger ready\n");

    console.log("✅ All migrations complete!");
}

// Run migrations
migrate()
    .catch((err) => {
        console.error("❌ Migration failed:", err);
        process.exit(1);
    })
    .finally(() => {
        close();
    });
