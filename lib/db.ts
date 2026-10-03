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

  return new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
  });
}

export const db = globalThis.roveoDbPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalThis.roveoDbPool = db;
}
