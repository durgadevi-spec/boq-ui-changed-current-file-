
import fs from "fs";
import path from "path";

// Manually load .env since client.ts might fail to find it when run via tsx
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(/DATABASE_URL="?([^"\s]+)"?/);
  if (match) {
    process.env.DATABASE_URL = match[1];
    console.log("Loaded DATABASE_URL from .env");
  }
}

import { query } from "./server/db/client";

async function test() {
  try {
    const result = await query("SELECT id, name, category, subcategory, vendor_category FROM material_templates WHERE name LIKE '%Height Adjustable Table%';");
    console.log("TEMPLATE DATA:");
    console.log(JSON.stringify(result.rows, null, 2));

    if (result.rows.length > 0) {
        const result2 = await query("SELECT id, name, category, subcategory FROM materials WHERE template_id = $1 AND approved IS TRUE;", [result.rows[0]?.id]);
        console.log("APPROVED MATERIALS FOR THIS TEMPLATE:");
        console.log(JSON.stringify(result2.rows, null, 2));
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

test();
