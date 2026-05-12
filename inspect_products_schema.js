import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'products'");
    console.log("COLUMNS FOR products:");
    console.log(JSON.stringify(res.rows, null, 2));
    
    // Also check some values for 'status' or 'deleted'
    const statusCheck = await pool.query("SELECT DISTINCT status FROM products");
    console.log("\nDISTINCT STATUSES:");
    console.log(JSON.stringify(statusCheck.rows, null, 2));
    
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
