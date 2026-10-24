import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var roveoDbPool: Pool | undefined;
}

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured. Add it to the Vercel environment before using database-backed features.");
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

  return new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
  });
}

/**
 * Keep database connection creation lazy. Next.js imports API route modules
 * while collecting build-time page data; requiring DATABASE_URL at module
 * import time makes every deployment fail before the route is even invoked.
 * The first real database operation still requires DATABASE_URL and reports a
 * clear configuration error if the deployment is missing it.
 */
function getPool(): Pool {
  if (!globalThis.roveoDbPool) {
    globalThis.roveoDbPool = createPool();
  }
  return globalThis.roveoDbPool;
}

export const db = new Proxy({} as Pool, {
  get(_target, property) {
    const pool = getPool();
    const value = Reflect.get(pool, property, pool);
    return typeof value === "function" ? value.bind(pool) : value;
  },
});
