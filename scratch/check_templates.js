
import "dotenv/config";
import { query } from "../server/db/client";

async function checkTemplates() {
  try {
    const res = await query("SELECT * FROM sketch_templates ORDER BY created_at DESC LIMIT 5");
    console.log("Templates found:", res.rowCount);
    for (const row of res.rows) {
      const data = typeof row.template_data === 'string' ? JSON.parse(row.template_data) : row.template_data;
      const items = Array.isArray(data) ? data : (data?.items || []);
      console.log(`Template: ${row.name}, Items Count: ${items.length}`);
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

checkTemplates();
