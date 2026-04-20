import { query } from "./db/client";

async function verifyAuditLogsTable() {
  try {
    const result = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'audit_logs'");
    console.log("Audit Logs Table Columns:");
    result.rows.forEach(row => {
      console.log(`- ${row.column_name}: ${row.data_type}`);
    });
    
    if (result.rows.some(r => r.column_name === 'created_at')) {
      console.log("\n[VERIFICATION] SUCCESS: 'created_at' column exists!");
    } else {
      console.error("\n[VERIFICATION] FAILED: 'created_at' column is still missing!");
    }
  } catch (err) {
    console.error("Verification failed:", err.message);
  } finally {
    process.exit();
  }
}

verifyAuditLogsTable();
