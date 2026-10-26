import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var roveoDbPool: Pool | undefined;
}

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  // Neon/Postgres URLs sometimes carry sslmode=prefer/require, which newer
  // pg-connection-string versions warn about. Roveo already supplies its own
  // TLS configuration, so remove that legacy URL option before pg parses it.
  let connectionString = process.env.DATABASE_URL;
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    connectionString = parsed.toString();
  } catch {
    connectionString = connectionString.replace(/([?&])sslmode=(?:prefer|require|verify-ca)(?=&|$)/i, "$1").replace(/[?&]$/, "");
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
  });

  if (process.env.NODE_ENV !== "production") {
    globalThis.roveoDbPool = pool;
  }

  return pool;
}

// Do not create the pool at module-import/build time. Next.js may import API
// route modules while collecting route configuration, when deployment runtime
// secrets are not available. Create the real pool only when code uses the DB.
export const db = new Proxy({} as Pool, {
  get(_target, property) {
    const pool = globalThis.roveoDbPool ?? createPool();
    const value = Reflect.get(pool, property, pool);
    return typeof value === "function" ? value.bind(pool) : value;
  },
});
