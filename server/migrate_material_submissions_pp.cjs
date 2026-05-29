process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres.kfbquadkplnnqovsbnji:Durga%219Qx%407B%2325Lm@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const tables = [
    'materials',
    'material_submissions',
    'product_step3_config_items',
    'product_approval_items',
    'step11_product_items',
  ];

  for (const table of tables) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_project_pricing BOOLEAN DEFAULT FALSE`);
      console.log(`✅ ${table} - is_project_pricing column OK`);
    } catch (e) {
      console.error(`❌ ${table} - FAILED:`, e.message);
    }
  }

  console.log("\nDone! All tables checked.");
  pool.end();
}

run();
