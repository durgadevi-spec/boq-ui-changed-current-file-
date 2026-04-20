import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { authMiddleware, requireRole } from "../middleware";
import { storage } from "../storage";
import { randomUUID } from "crypto";
import { sendSketchPlanEmail, sendSiteReportEmail, sendProposalStatusEmail } from "../email";
import fs from "fs";

const router = Router();

router.get("/api/bom-templates", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query("SELECT * FROM bom_templates ORDER BY name ASC");
      const archivedIds = archiveService.getArchivedItemIds('bom_templates');
      const trashedIds = archiveService.getTrashedItemIds('bom_templates');
      const filtered = result.rows.filter((r) => !archivedIds.includes(r.id) && !trashedIds.includes(r.id));
      res.json({ templates: filtered });
    } catch (err) {
      console.error("GET /api/bom-templates error", err);
      res.status(500).json({ message: "Failed to fetch BOM templates" });
    }
  });

router.post("/api/bom-templates", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { name, config } = req.body;
      if (!name || !config) {
        return res.status(400).json({ message: "Name and config are required" });
      }

      await query(
        `INSERT INTO bom_templates (name, config, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (name) DO UPDATE SET config = $2, updated_at = NOW()`,
        [name, JSON.stringify(config)]
      );

      res.json({ message: "BOM Template saved successfully" });
    } catch (err) {
      console.error("POST /api/bom-templates error", err);
      res.status(500).json({ message: "Failed to save BOM template" });
    }
  });

router.delete("/api/bom-templates/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const getTpl = await query("SELECT * FROM bom_templates WHERE id = $1", [id]);
      if (getTpl.rows.length === 0) return res.status(404).json({ message: "Template not found" });

      const archived = archiveService.archiveItem('bom_templates', id, getTpl.rows[0]);
      if (req.query.action === 'trash' && archived) {
        archiveService.trashArchiveItem(archived.id);
      }
      res.json({ message: "BOM Template archived" });
    } catch (err) {
      console.error("DELETE /api/bom-templates error", err);
      res.status(500).json({ message: "Failed to delete BOM template" });
    }
  });

export default router;
