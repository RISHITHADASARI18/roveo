import { db } from "@/lib/db";

let schemaReady: Promise<void> | null = null;

/**
 * Keep budget endpoints usable on deployments whose database has not yet had
 * the full schema.sql applied. All operations are idempotent and run once per
 * warm server instance; the promise resets if a migration fails so a retry can
 * recover after the database becomes available.
 */
export async function ensureBudgetSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS trip_budgets (
          id BIGSERIAL PRIMARY KEY,
          trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          destination_travel NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (destination_travel >= 0),
          accommodation NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (accommodation >= 0),
          local_transport NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (local_transport >= 0),
          food NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (food >= 0),
          activities NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (activities >= 0),
          other NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
          contingency NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (contingency >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_manual BOOLEAN NOT NULL DEFAULT FALSE,
          UNIQUE (trip_id)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS trip_cost_estimates (
          id BIGSERIAL PRIMARY KEY,
          trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          destination_travel NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (destination_travel >= 0),
          accommodation NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (accommodation >= 0),
          local_transport NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (local_transport >= 0),
          food NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (food >= 0),
          activities NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (activities >= 0),
          other NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
          contingency NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (contingency >= 0),
          total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
          currency TEXT NOT NULL DEFAULT 'INR',
          confidence TEXT NOT NULL DEFAULT 'fallback',
          source TEXT NOT NULL DEFAULT 'roveo',
          accommodation_property JSONB,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (trip_id)
        )
      `);
      await db.query("ALTER TABLE trip_budgets ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE");
      await db.query("ALTER TABLE trip_cost_estimates ADD COLUMN IF NOT EXISTS accommodation_property JSONB");
      await db.query("CREATE INDEX IF NOT EXISTS trip_budgets_trip_id_idx ON trip_budgets(trip_id)");
      await db.query("CREATE INDEX IF NOT EXISTS trip_cost_estimates_trip_id_idx ON trip_cost_estimates(trip_id)");
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  return schemaReady;
}
