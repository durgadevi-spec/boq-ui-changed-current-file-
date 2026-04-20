const { Pool } = require('pg');
require('dotenv').config();

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Connecting to database...');
    await pool.connect();
    console.log('Connected to database successfully');

    const queries = [
      'ALTER TABLE boq_items ALTER COLUMN estimator TYPE TEXT',
      'ALTER TABLE estimator_step9_cart ALTER COLUMN estimator TYPE TEXT',
      'ALTER TABLE estimator_step11_finalize_boq ALTER COLUMN estimator TYPE TEXT',
      'ALTER TABLE estimator_step12_qa_boq ALTER COLUMN estimator TYPE TEXT'
    ];

    for (const q of queries) {
      console.log(`Executing: ${q}...`);
      try {
        await pool.query(q);
        console.log(`✅ Success: ${q}`);
      } catch (err) {
        console.error(`❌ Failed: ${q}`, err.message);
      }
    }

    console.log('\nMigration completed!');

  } catch (err) {
    console.error('❌ Database connection error:', err.message);
  } finally {
    await pool.end();
    console.log('Database connection closed');
  }
}

migrate();
