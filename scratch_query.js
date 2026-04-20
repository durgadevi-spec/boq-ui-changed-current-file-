
const { query } = require("./server/db/client");

async function test() {
  try {
    const result = await query("SELECT id, name, category, subcategory FROM material_templates WHERE name LIKE '%Height Adjustable Table%';");
    console.log(JSON.stringify(result.rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

test();
