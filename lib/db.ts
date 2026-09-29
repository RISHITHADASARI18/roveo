import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var roveoDbPool: Pool | undefined;
}

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return new Pool({
    connectionString: process.env.DATABASE_URL,
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
