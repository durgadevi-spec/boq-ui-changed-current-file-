import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { authMiddleware, requireRole } from "../middleware";
import { storage } from "../storage";
import { randomUUID } from "crypto";
import { archiveService } from "../archive_service";
import { parseSafeNumeric } from "../utils";
import { logActivity } from "../audit";
import { sendSketchPlanEmail, sendSiteReportEmail, sendProposalStatusEmail, sendResetPasswordEmail } from "../email";
import { recalculateProjectValue } from "../db/helpers";
import fs from "fs";

const router = Router();

  router.get("/api/support-messages", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      let sql = `SELECT id::text, sender_name, sender_email, sender_role, message, info, admin_reply, is_read, sent_at as submitted_at, created_at 
                 FROM messages`;
      const params: any[] = [];

      // If not admin/software/purchase, only show their own messages
      if (user.role !== 'admin' && user.role !== 'software_team' && user.role !== 'purchase_team') {
        params.push(user.username);
        sql += ` WHERE sender_email = $${params.length}`;
      }

      sql += ` ORDER BY created_at DESC`;

      const result = await query(sql, params);
      res.json({ messages: result.rows });
    } catch (err) {
      console.error("/api/support-messages GET error", err);
      res.status(500).json({ message: "Failed to fetch support messages" });
    }
  });

  router.post("/api/support-messages", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { senderName, message, info, admin_reply } = req.body;

      if (!message) {
        return res.status(400).json({ message: "Message content is required" });
      }

      const id = randomUUID();
      const result = await query(
        `INSERT INTO messages (id, sender_name, sender_email, sender_role, message, info, admin_reply) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id::text, sender_name, sender_email, sender_role, message, info, admin_reply, is_read, sent_at as submitted_at, created_at`,
        [id, senderName || user.fullName || user.username, user.username, user.role, message, info || null, admin_reply || null]
      );

      res.status(201).json({ message: result.rows[0] });
    } catch (err) {
      console.error("/api/support-messages POST error", err);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  router.put("/api/support-messages/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { admin_reply, is_read, info } = req.body;

      const result = await query(
        `UPDATE messages 
         SET admin_reply = COALESCE($1, admin_reply),
             is_read = COALESCE($2, is_read),
             info = COALESCE($3, info)
         WHERE id = $4
         RETURNING id::text, sender_name, sender_email, sender_role, message, info, admin_reply, is_read, sent_at as submitted_at, created_at`,
        [admin_reply || null, is_read !== undefined ? is_read : null, info || null, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Message not found" });
      }

      res.json({ message: result.rows[0] });
    } catch (err) {
      console.error("/api/support-messages PUT error", err);
      res.status(500).json({ message: "Failed to update message" });
    }
  });

  router.delete("/api/support-messages/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = (req as any).user;

      // Only allow user to delete their own, or admin to delete any
      const checkResult = await query("SELECT sender_email FROM messages WHERE id = $1", [id]);
      if (checkResult.rowCount === 0) {
        return res.status(404).json({ message: "Message not found" });
      }

      if (user.role !== 'admin' && user.username !== checkResult.rows[0].sender_email) {
        return res.status(403).json({ message: "Unauthorized to delete this message" });
      }

      await query("DELETE FROM messages WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("/api/support-messages DELETE error", err);
      res.status(500).json({ message: "Failed to delete message" });
    }
  });

  router.post("/api/bot-query", authMiddleware, async (req, res) => {
    try {
      const q = (req.body.query || "").toLowerCase().trim();
      let answer = "I'm sorry, I didn't understand that. You can ask me about material prices, availability, or products (e.g., 'price of MDF', 'do we have hinges', 'list restroom products').";

      // 1. HELP / GUIDE
      if (q.match(/help|guide|what can you do|how to use/i)) {
        answer = `**I'm your Assistant Bot!** I can help you find information quickly.

**Try asking me:**
- ≡ƒÆ░ **Prices**: "Price of MDF 18mm"
- ≡ƒôª **Stock**: "Do we have hinges?"
- ≡ƒôé **Categories**: "List all categories"
- ≡ƒÅù∩╕Å **Projects**: "How many projects?"
- ≡ƒÅó **Vendors**: "Info for Mohan Electricals"`;
      }
      // 2. PROJECT COUNT / LIST
      else if (q.match(/how many projects|list projects|active projects|show projects/i)) {
        const r = await query(`SELECT COUNT(*) as count FROM boq_projects`);
        const list = await query(`SELECT name FROM boq_projects ORDER BY created_at DESC LIMIT 5`);
        answer = `We have **${r.rows[0].count} total projects**.

**Recent Projects:**
${list.rows.map((row: any) => `- ${row.name}`).join('\n')}`;
      }
      // 3. CATEGORY LISTING
      else if (q.match(/list categories|show categories|what categories|all categories/i)) {
        const r = await query(`SELECT name FROM material_categories ORDER BY name ASC`);
        answer = `**Material Categories:**\n${r.rows.map((row: any) => `- ${row.name}`).join('\n')}`;
      }
      // 4. PRICE LOOKUP
      else if (q.match(/price of (.+)|cost of (.+)|rate of (.+)|how much is (.+)/i)) {
        const priceMatch = q.match(/price of (.+)|cost of (.+)|rate of (.+)|how much is (.+)/i);
        const matName = priceMatch![1] || priceMatch![2] || priceMatch![3] || priceMatch![4];
        const r = await query(`SELECT name, rate, unit FROM materials WHERE name ILIKE $1 LIMIT 5`, [`%${matName.trim()}%`]);
        if (r.rows.length === 0) {
          answer = `I couldn't find any material matching "**${matName}**".`;
        } else {
          answer = `**Price Results for "${matName}":**\n\n| Material | Rate | Unit |\n| :--- | :--- | :--- |\n` +
            r.rows.map((row: any) => `| ${row.name} | Γé╣${row.rate} | ${row.unit || 'unit'} |`).join('\n');
        }
      }
      // 5. VENDOR INFO
      else if (q.match(/info for (.+)|vendor (.+)|who is (.+)/i)) {
        const vendorMatch = q.match(/info for (.+)|vendor (.+)|who is (.+)/i);
        const vName = vendorMatch![1] || vendorMatch![2] || vendorMatch![3];
        const r = await query(`SELECT name, location, city, gstno FROM shops WHERE name ILIKE $1 LIMIT 1`, [`%${vName.trim()}%`]);
        if (r.rows.length === 0) {
          answer = `I couldn't find a vendor named "**${vName}**".`;
        } else {
          const v = r.rows[0];
          answer = `**Vendor Information:**
- **Name**: ${v.name}
- **Location**: ${v.location || 'N/A'}, ${v.city || ''}
- **GSTIN**: ${v.gstno || 'Not Provided'}`;
        }
      }
      // 6. AVAILABILITY
      else if (q.match(/do we have (.+)|is (.+) available|is (.+) in stock|any (.+)/i)) {
        const availMatch = q.match(/do we have (.+)|is (.+) available|is (.+) in stock|any (.+)/i);
        const matName = availMatch![1] || availMatch![2] || availMatch![3] || availMatch![4];
        const r = await query(`SELECT name FROM materials WHERE name ILIKE $1 LIMIT 5`, [`%${matName.trim()}%`]);
        if (r.rows.length === 0) {
          answer = `No, we don't have materials matching "**${matName}**" in our database.`;
        } else {
          answer = `**Yes, we have these matching items:**\n${r.rows.map((row: any) => '- ' + row.name).join('\n')}`;
        }
      }
      // 7. FALLBACK SEARCH
      else {
        const matRes = await query(`SELECT name, rate, unit FROM materials WHERE name ILIKE $1 LIMIT 3`, [`%${q}%`]);
        if (matRes.rows.length > 0) {
          answer = `I found these materials matching "**${q}**":\n${matRes.rows.map((row: any) => `- ${row.name} (Γé╣${row.rate}/${row.unit || 'unit'})`).join('\n')}`;
        } else {
          const pRes = await query(`SELECT name FROM products WHERE name ILIKE $1 LIMIT 3`, [`%${q}%`]);
          if (pRes.rows.length > 0) {
            answer = `I found these products matching "**${q}**":\n${pRes.rows.map((p: any) => `- ${p.name}`).join('\n')}`;
          } else {
            answer = "I'm sorry, I couldn't find anything matching your query. Type **'help'** to see what I can do!";
          }
        }
      }

      res.json({ answer });
    } catch (err) {
      console.error("/api/bot-query error:", err);
      res.status(500).json({ error: "Failed to process query" });
    }
  });

export default router;
