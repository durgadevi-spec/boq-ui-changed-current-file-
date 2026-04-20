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

  router.get("/api/global-settings", authMiddleware, async (_req, res) => {
    try {
      const result = await query(`SELECT * FROM global_settings`);
      const settings: { [key: string]: any } = {};
      result.rows.forEach(row => {
        settings[row.id] = row.value;
      });
      res.json(settings);
    } catch (err) {
      console.error("Failed to fetch global settings:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  router.put("/api/global-settings/:id", authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { value } = req.body;
      await query(
        `INSERT INTO global_settings (id, value, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [id, JSON.stringify(value)]
      );
      res.json({ message: `Setting ${id} updated` });
    } catch (err) {
      console.error(`Failed to update global setting ${req.params.id}:`, err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  router.get('/api/my-permissions', authMiddleware, async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      const userId = req.user.id;
      const registry = await query(`SELECT id FROM user_management_registry WHERE user_id = $1`, [userId]);
      if (registry.rows.length === 0) {
        // Even if not custom managed for modules, we want to return project info
        const projectsRes = await query(`SELECT project_id FROM user_project_permissions WHERE user_id = $1`, [userId]);
        const userRes = await query(`SELECT current_project_id FROM users WHERE id = $1`, [userId]);
        res.json({
          isCustomManaged: false,
          modules: [],
          projects: projectsRes.rows.map((r: any) => r.project_id),
          currentProjectId: userRes.rows[0]?.current_project_id || null
        });
        return;
      }
      const perms = await query(`SELECT module_name FROM user_sidebar_permissions WHERE user_id = $1 ORDER BY module_name`, [userId]);
      const projectsRes = await query(`SELECT project_id FROM user_project_permissions WHERE user_id = $1`, [userId]);
      const userRes = await query(`SELECT current_project_id FROM users WHERE id = $1`, [userId]);

      res.json({
        isCustomManaged: true,
        modules: perms.rows.map((r: any) => r.module_name),
        projects: projectsRes.rows.map((r: any) => r.project_id),
        currentProjectId: userRes.rows[0]?.current_project_id || null
      });
    } catch (err) {
      console.error('/api/my-permissions error:', err);
      res.status(500).json({ message: 'Failed to load permissions' });
    }
  });

  router.post('/api/set-active-project', authMiddleware, async (req: Request, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
      const { projectId } = req.body;
      const userId = req.user.id;

      // Verify that the user has permission for this project (unless admin/software_team)
      const check = await query(`SELECT 1 FROM user_project_permissions WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);
      if (check.rows.length === 0 && projectId !== null) {
        return res.status(403).json({ message: 'No permission for this project' });
      }

      await query(`UPDATE users SET current_project_id = $1 WHERE id = $2`, [projectId, userId]);
      res.json({ message: 'Active project updated', currentProjectId: projectId });
    } catch (err) {
      console.error('/api/set-active-project error:', err);
      res.status(500).json({ message: 'Failed to update active project' });
    }
  });

export default router;
