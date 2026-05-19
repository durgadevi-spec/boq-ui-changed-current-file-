
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const dbUrl = envContent.match(/DATABASE_URL="?([^"\n\s]+)"?/)[1];

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function check() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'product_step3_config'
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
