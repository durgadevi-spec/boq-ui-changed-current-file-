const { Client } = require('pg');
const client = new Client({ 
  connectionString: "postgresql://postgres.kfbquadkplnnqovsbnji:Durga%219Qx%407B%2325Lm@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
  ssl: { rejectUnauthorized: false }
});

async function checkProduct() {
  try {
    await client.connect();
    console.log("Testing prioritized join logic...");
    const res = await client.query(`
      SELECT p.id, p.name, p.subcategory, s.category as joined_category
      FROM products p
      LEFT JOIN (
        SELECT DISTINCT ON (LOWER(TRIM(name))) name, category
        FROM material_subcategories
        ORDER BY LOWER(TRIM(name)), (CASE WHEN category = 'Demolishing' THEN 1 ELSE 0 END) ASC, created_at DESC
      ) s ON LOWER(TRIM(p.subcategory)) = LOWER(TRIM(s.name))
      WHERE p.name ILIKE '%Single Skin%'
    `);
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

checkProduct();
