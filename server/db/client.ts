import pg from "pg";
import type { QueryResultRow } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "[db-client] ❌ DATABASE_URL is not set! Check your environment variables."
  );
}

console.log(
  "[db-client] Connecting to:",
  connectionString.includes("supabase") ? "SUPABASE ✓" : "LOCAL ✗"
);

const poolConfig: pg.PoolConfig = {
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500,
  statement_timeout: 60000,
  query_timeout: 60000,
  ssl: connectionString.includes("supabase")
    ? { rejectUnauthorized: false }
    : undefined,
};

export const pool = new pg.Pool(poolConfig);

pool.on("error", (err: any) => {
  console.error("[db-pool] Unexpected error on idle client:", err.message);
  if (err.code === "ECONNRESET") {
    console.warn("[db-pool] Connection reset by Supabase pooler — handled by pg-pool.");
  }
});

pool
  .connect()
  .then((client) => {
    console.log("[db-pool] ✓ Successfully connected to database");
    client.release();
  })
  .catch((err: any) => {
    console.error("[db-pool] ✗ Failed to connect:", err.message);
  });

export async function query<T extends QueryResultRow = any>(
  text: string,
  params: any[] = []
) {
  return pool.query<T>(text, params);
}

export default { pool, query };