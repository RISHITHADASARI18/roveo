import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);
  console.log("Test database schema initialized.");
} finally {
  await pool.end();
}