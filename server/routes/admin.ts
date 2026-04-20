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

  router.get("/api/audit/logs", authMiddleware, requireRole("admin", "software_team"), async (req: Request, res: Response) => {
    try {
      const { username, module, action, limit = "200" } = req.query;
      let sql = `SELECT id::text, user_id, username, user_role as role, action, module, description as details, metadata, ip_address, 
                        user_agent, page, requested_at as created_at
                 FROM audit_logs WHERE 1=1`;
      const params: any[] = [];

      if (username) {
        params.push(`%${username}%`);
        sql += ` AND username ILIKE $${params.length}`;
      }
      if (module && module !== "all") {
        params.push(module);
        sql += ` AND module = $${params.length}`;
      }
      if (action && action !== "all") {
        params.push(action);
        sql += ` AND action = $${params.length}`;
      }

      params.push(Math.min(Number(limit) || 200, 1000));
      sql += ` ORDER BY requested_at DESC LIMIT $${params.length}`;

      const result = await query(sql, params);
      res.json({ logs: result.rows });
    } catch (err) {
      console.error("/api/audit/logs GET error", err);
      res.status(500).json({ message: "Failed to fetch audit logs" });
    }
  });

  router.post("/api/audit/navigate", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { page, module, details } = req.body;
      await logActivity({
        userId: user?.id,
        username: user?.username,
        role: user?.role,
        action: "NAVIGATE",
        module: module || (page || "").split("/")[1]?.toUpperCase() || "HOME",
        page,
        details: details || `Navigated to ${page}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
      res.json({ success: true });
    } catch (err) {
      console.error("/api/audit/navigate POST error", err);
      res.status(500).json({ message: "Failed to log navigation" });
    }
  });

  router.get(
    "/api/admin/pending-suppliers",
    authMiddleware,
    requireRole("admin"),
    async (_req: Request, res: Response) => {
      try {
        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved text DEFAULT 'approved'`,
        );
        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_reason text`,
        );

        // Only PENDING suppliers (so the page won't show approved ones)
        const result = await query(
          `SELECT id, username, role, approved, approval_reason, created_at
           FROM users
           WHERE role = 'supplier' AND approved = 'pending'
           ORDER BY created_at DESC`,
        );

        res.json({ suppliers: result.rows });
      } catch (err: any) {
        console.error("/api/admin/pending-suppliers error", err);
        res.status(500).json({ message: "failed to list pending suppliers" });
      }
    },
  );

  router.post(
    "/api/admin/suppliers/:id/approve",
    authMiddleware,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id;

        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved text DEFAULT 'approved'`,
        );
        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_reason text`,
        );

        const result = await query(
          `UPDATE users
           SET approved = 'approved', approval_reason = NULL
           WHERE id = $1 AND role = 'supplier'
           RETURNING id, username, role, approved, approval_reason`,
          [id],
        );

        if (result.rowCount === 0) {
          res.status(404).json({ message: "Supplier not found" });
          return;
        }

        res.json({ supplier: result.rows[0] });
      } catch (err: any) {
        console.error("/api/admin/suppliers/:id/approve error", err);
        res.status(500).json({ message: "failed to approve supplier" });
      }
    },
  );

  router.post(
    "/api/admin/suppliers/:id/reject",
    authMiddleware,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const reason = req.body?.reason || null;

        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved text DEFAULT 'approved'`,
        );
        await query(
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_reason text`,
        );

        const result = await query(
          `UPDATE users
           SET approved = 'rejected', approval_reason = $2
           WHERE id = $1 AND role = 'supplier'
           RETURNING id, username, role, approved, approval_reason`,
          [id, reason],
        );

        if (result.rowCount === 0) {
          res.status(404).json({ message: "Supplier not found" });
          return;
        }

        res.json({ supplier: result.rows[0] });
      } catch (err: any) {
        console.error("/api/admin/suppliers/:id/reject error", err);
        res.status(500).json({ message: "failed to reject supplier" });
      }
    },
  );

  router.get('/api/admin/dynamic-access/pending-users', authMiddleware, requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const result = await query(`
        SELECT u.id, u.username, u.role, u.full_name, u.created_at
        FROM users u
        WHERE u.role NOT IN ('admin', 'software_team')
          AND u.id NOT IN (SELECT user_id FROM user_management_registry)
        ORDER BY u.created_at DESC
      `);
      res.json({ users: result.rows });
    } catch (err) {
      console.error('/api/admin/dynamic-access/pending-users error:', err);
      res.status(500).json({ message: 'Failed to load pending users' });
    }
  });

  router.get('/api/admin/dynamic-access/managed-users', authMiddleware, requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const usersResult = await query(`
        SELECT u.id, u.username, u.role, u.full_name, umr.created_at as assigned_at
        FROM users u
        INNER JOIN user_management_registry umr ON umr.user_id = u.id
        ORDER BY umr.created_at DESC
      `);
      const users = usersResult.rows;
      // Attach permissions for each user
      for (const u of users) {
        const perms = await query(`SELECT module_name FROM user_sidebar_permissions WHERE user_id = $1 ORDER BY module_name`, [u.id]);
        u.modules = perms.rows.map((r: any) => r.module_name);

        const projects = await query(`SELECT project_id FROM user_project_permissions WHERE user_id = $1`, [u.id]);
        u.projects = projects.rows.map((r: any) => r.project_id);
      }
      res.json({ users });
    } catch (err) {
      console.error('/api/admin/dynamic-access/managed-users error:', err);
      res.status(500).json({ message: 'Failed to load managed users' });
    }
  });

  router.get('/api/admin/dynamic-access/permissions/:userId', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const result = await query(`SELECT module_name FROM user_sidebar_permissions WHERE user_id = $1 ORDER BY module_name`, [userId]);
      res.json({ modules: result.rows.map((r: any) => r.module_name) });
    } catch (err) {
      console.error('/api/admin/dynamic-access/permissions/:userId error:', err);
      res.status(500).json({ message: 'Failed to load permissions' });
    }
  });

  router.post('/api/admin/dynamic-access/assign', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const { userId, modules } = req.body as { userId: string; modules: string[] };
      if (!userId) {
        res.status(400).json({ message: 'userId is required' });
        return;
      }

      // Enroll user in management registry (upsert)
      await query(`
        INSERT INTO user_management_registry (user_id, is_custom_managed)
        VALUES ($1, TRUE)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);

      // Delete existing permissions then insert new ones
      await query(`DELETE FROM user_sidebar_permissions WHERE user_id = $1`, [userId]);

      if (Array.isArray(modules) && modules.length > 0) {
        for (const mod of modules) {
          if (mod && typeof mod === 'string') {
            await query(`
              INSERT INTO user_sidebar_permissions (user_id, module_name)
              VALUES ($1, $2)
              ON CONFLICT (user_id, module_name) DO NOTHING
            `, [userId, mod]);
          }
        }
      }

      // Handle projects if provided
      const { projects } = req.body as { projects?: string[] };
      if (projects !== undefined) {
        await query(`DELETE FROM user_project_permissions WHERE user_id = $1`, [userId]);
        if (Array.isArray(projects) && projects.length > 0) {
          for (const pid of projects) {
            if (pid && typeof pid === 'string') {
              await query(`
                INSERT INTO user_project_permissions (user_id, project_id)
                VALUES ($1, $2)
                ON CONFLICT (user_id, project_id) DO NOTHING
              `, [userId, pid]);
            }
          }
        }
      }

      res.json({ message: 'Permissions saved successfully' });
    } catch (err) {
      console.error('/api/admin/dynamic-access/assign error:', err);
      res.status(500).json({ message: 'Failed to save permissions' });
    }
  });

export default router;
