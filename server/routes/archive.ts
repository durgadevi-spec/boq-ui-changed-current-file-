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

  router.get('/api/archive', authMiddleware, (req, res) => {
    res.json({ items: archiveService.getArchived() });
  });

  router.get('/api/trash', authMiddleware, (req, res) => {
    res.json({ items: archiveService.getTrashed() });
  });

  router.post('/api/archive/:id/trash', authMiddleware, (req, res) => {
    const item = archiveService.trashArchiveItem(req.params.id);
    if (item) res.json({ success: true, item });
    else res.status(404).json({ error: "Item not found in archive" });
  });

  router.post('/api/archive/:id/restore', authMiddleware, (req, res) => {
    const success = archiveService.restoreArchiveItem(req.params.id);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: "Item not found in archive or trash" });
  });

  router.delete('/api/archive/:id/permanent', authMiddleware, async (req, res) => {
    try {
      const item = archiveService.permanentlyDelete(req.params.id);
      if (!item) return res.status(404).json({ error: "Item not found" });

      // Actually delete from DB now based on module
      if (item.module === 'materials') {
        await query("DELETE FROM materials WHERE id = $1", [item.originId]);
      } else if (item.module === 'products') {
        await query("DELETE FROM products WHERE id = $1", [item.originId]);
      } else if (item.module === 'boq_items') {
        await query("DELETE FROM boq_items WHERE id = $1", [item.originId]);
      } else if (item.module === 'boq_projects') {
        await query("DELETE FROM boq_projects WHERE id = $1", [item.originId]);
        // Also cleanup dependent items/versions if needed, but usually cascading or manual delete handles it
        await query("DELETE FROM boq_versions WHERE project_id = $1", [item.originId]);
        await query("DELETE FROM boq_items WHERE project_id = $1", [item.originId]);
      } else if (item.module === 'templates') {
        await query("DELETE FROM material_templates WHERE id = $1", [item.originId]);
      } else if (item.module === 'categories') {
        await query("DELETE FROM vendor_categories WHERE id = $1", [item.originId]);
      } else if (item.module === 'subcategories') {
        await query("DELETE FROM vendor_subcategories WHERE id = $1", [item.originId]);
      } else if (item.module === 'sketch_plans') {
        await query("DELETE FROM sketch_plans WHERE id = $1", [item.originId]);
      } // add others as needed

      res.json({ success: true, message: "Permanently deleted" });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to permanently delete" });
    }
  });

  router.get('/api/alerts', async (_req, res) => {
    try {
      const result = await query(`SELECT id::text, type, material_id, name, old_rate, new_rate, edited_by, shop_id, shop_name, created_at FROM alerts ORDER BY created_at DESC LIMIT 200`);
      res.json({ alerts: result.rows });
    } catch (err) {
      console.error('/api/alerts GET error', err);
      res.status(500).json({ message: 'failed to load alerts' });
    }
  });

  router.post('/api/alerts', authMiddleware, requireRole('admin', 'software_team', 'purchase_team'), async (req: Request, res: Response) => {
    try {
      const { type, materialId, name, oldRate, newRate, editedBy, shopId, shopName } = req.body || {};
      const id = randomUUID();
      const result = await query(`INSERT INTO alerts (id, type, material_id, name, old_rate, new_rate, edited_by, shop_id, shop_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id::text, type, material_id, name, old_rate, new_rate, edited_by, shop_id, shop_name, created_at`, [id, type, materialId || null, name || null, oldRate || null, newRate || null, editedBy || null, shopId || null, shopName || null]);
      res.status(201).json({ alert: result.rows[0] });
    } catch (err) {
      console.error('/api/alerts POST error', err);
      res.status(500).json({ message: 'failed to create alert' });
    }
  });

  router.delete('/api/alerts', authMiddleware, requireRole('admin', 'software_team'), async (_req, res) => {
    try {
      await query(`DELETE FROM alerts`);
      res.json({ message: 'alerts cleared' });
    } catch (err) {
      console.error('/api/alerts DELETE error', err);
      res.status(500).json({ message: 'failed to clear alerts' });
    }
  });

  router.delete('/api/alerts/:id', authMiddleware, requireRole('admin', 'software_team'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await query(`DELETE FROM alerts WHERE id = $1`, [id]);
      res.json({ message: 'alert dismissed' });
    } catch (err) {
      console.error('/api/alerts/:id DELETE error', err);
      res.status(500).json({ message: 'failed to delete alert' });
    }
  });

export default router;
