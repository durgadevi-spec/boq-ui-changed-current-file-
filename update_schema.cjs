const pg = require('pg');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Load .env
dotenv.config();

async function run() {
  let connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const match = envContent.match(/DATABASE_URL="?([^"\n]+)"?/);
          if (match) connectionString = match[1];
      }
  }

  if (!connectionString) {
    console.error('DATABASE_URL not found');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Adding purchase_team_status column to boq_versions...');
    await pool.query("ALTER TABLE boq_versions ADD COLUMN IF NOT EXISTS purchase_team_status VARCHAR(50) DEFAULT 'pending'");
    console.log('Success');
  } catch (err) {
    console.error('Failed to add column:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
