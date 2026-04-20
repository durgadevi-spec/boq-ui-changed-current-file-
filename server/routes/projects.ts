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

  router.post(
    "/api/boq-projects",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { name, client, budget, location, client_address, gst_no, project_value, project_status } = req.body;
        console.log('/api/boq-projects POST body ->', { name, client, budget, location, client_address, gst_no, project_value, project_status });


        if (!name) {
          res.status(400).json({ message: "Project name is required" });
          return;
        }

        const projectId = `proj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        await query(
          `INSERT INTO boq_projects (id, name, client, budget, location, client_address, gst_no, project_value, project_status, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
          [projectId, name.trim(), client || "", budget || "", location || null, client_address || null, gst_no || null, project_value || null, project_status || 'started', "draft"],
        );


        res.json({
          id: projectId,
          name: name.trim(),
          client: client || "",
          budget: budget || "",
          location: location || "",
          client_address: client_address || "",
          gst_no: gst_no || "",
          project_value: project_value || "",
          status: "draft",
        });
      } catch (err) {
        console.error("POST /api/boq-projects error", err);
        res.status(500).json({ message: "Failed to create project" });
      }
    },
  );

  router.get(
    "/api/boq-projects",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const user = (req as any).user;
        const { all } = req.query;
        let queryStr = `
          SELECT p.*, 
            v_bom.version_number as bom_version_number, v_bom.project_value as bom_version_price,
            v_boq.version_number as boq_version_number, v_boq.project_value as boq_version_price
          FROM boq_projects p
          LEFT JOIN (
            SELECT DISTINCT ON (project_id) project_id, version_number, project_value
            FROM boq_versions
            WHERE type = 'bom'
            ORDER BY project_id, 
              is_last_final DESC NULLS LAST, 
              (CASE WHEN status = 'approved' THEN 2 ELSE 1 END) DESC,
              version_number DESC
          ) v_bom ON p.id = v_bom.project_id
          LEFT JOIN (
            SELECT DISTINCT ON (project_id) project_id, version_number, project_value
            FROM boq_versions
            WHERE type = 'boq'
            ORDER BY project_id, 
              is_last_final DESC NULLS LAST, 
              (CASE WHEN status = 'approved' THEN 2 ELSE 1 END) DESC,
              version_number DESC
          ) v_boq ON p.id = v_boq.project_id
        `;
        const params: any[] = [];

        const privilegedRoles = ['admin', 'software_team'];

        // Only allow admins to bypass project restrictions
        if (privilegedRoles.includes(user?.role)) {
          // Privileged roles see all projects
        } else {
          queryStr += ` WHERE id IN (SELECT project_id FROM user_project_permissions WHERE user_id = $1)`;
          params.push(user.id);
        }

        queryStr += ` ORDER BY created_at DESC`;
        const result = await query(queryStr, params);

        const archivedIds = archiveService.getArchivedItemIds('boq_projects');
        const trashedIds = archiveService.getTrashedItemIds('boq_projects');
        const filtered = (result.rows || []).filter(
          (r: any) => !archivedIds.includes(r.id) && !trashedIds.includes(r.id)
        );

        res.json({ projects: filtered || [] });
      } catch (err) {
        console.error("GET /api/boq-projects error", err);
        res.status(500).json({ message: "Failed to fetch projects" });
      }
    },
  );

  router.get(
    "/api/boq-projects/:projectId",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;

        const result = await query(
          `SELECT id, name, client, budget, location, client_address, gst_no, project_value, status, created_at, updated_at FROM boq_projects WHERE id = $1`,
          [projectId],
        );

        if (result.rows.length === 0) {
          res.status(404).json({ message: "Project not found" });
          return;
        }

        res.json(result.rows[0]);
      } catch (err) {
        console.error("GET /api/boq-projects/:projectId error", err);
        res.status(500).json({ message: "Failed to fetch project" });
      }
    },
  );

  router.put(
    "/api/boq-projects/:projectId",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { status, name, client, budget, location, client_address, gst_no, project_value } = req.body;

        const fields: string[] = [];
        const vals: any[] = [];
        let idx = 1;

        if (name !== undefined) {
          if (!name.trim()) {
            res.status(400).json({ message: "Project name cannot be empty" });
            return;
          }
          fields.push(`name = $${idx++}`);
          vals.push(name.trim());
        }

        if (status !== undefined) {
          if (!["draft", "submitted", "finalized"].includes(status)) {
            res.status(400).json({ message: "Invalid status" });
            return;
          }
          fields.push(`status = $${idx++}`);
          vals.push(status);
        }

        if (client !== undefined) {
          fields.push(`client = $${idx++}`);
          vals.push(client);
        }

        if (budget !== undefined) {
          fields.push(`budget = $${idx++}`);
          vals.push(budget);
        }

        if (location !== undefined) {
          fields.push(`location = $${idx++}`);
          vals.push(location);
        }

        if (client_address !== undefined) {
          fields.push(`client_address = $${idx++}`);
          vals.push(client_address);
        }

        if (gst_no !== undefined) {
          fields.push(`gst_no = $${idx++}`);
          vals.push(gst_no);
        }

        if (project_value !== undefined) {
          fields.push(`project_value = $${idx++}`);
          vals.push(project_value);
        }

        const { project_status } = req.body;
        if (project_status !== undefined) {
          const validStatuses = ['started', 'in_progress', 'hold', 'cancelled', 'closed', 'bom_stage', 'boq_stage', 'client_approval', 'work_in_execution', 'finance'];
          if (!validStatuses.includes(project_status)) {
            res.status(400).json({ message: 'Invalid project_status' });
            return;
          }
          fields.push(`project_status = $${idx++}`);
          vals.push(project_status);
        }

        if (fields.length > 0) {
          fields.push(`updated_at = NOW()`);
          vals.push(projectId);
          const q = `UPDATE boq_projects SET ${fields.join(", ")} WHERE id = $${idx}`;
          await query(q, vals);
        }

        res.json({ message: "Project updated" });
      } catch (err) {
        console.error("PUT /api/boq-projects/:projectId error", err);
        res.status(500).json({ message: "Failed to update project" });
      }
    },
  );

  router.delete(
    "/api/boq-projects/:projectId",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;

        // First, delete all items related to this project
        await query(`DELETE FROM boq_items WHERE project_id = $1`, [projectId]);

        // Then delete all versions related to this project
        await query(`DELETE FROM boq_versions WHERE project_id = $1`, [projectId]);

        // Finally delete the project itself
        const result = await query(
          `DELETE FROM boq_projects WHERE id = $1`,
          [projectId],
        );

        if (result.rowCount === 0) {
          res.status(404).json({ message: "Project not found" });
          return;
        }

        res.json({ message: "Project deleted successfully" });
      } catch (err) {
        console.error("DELETE /api/boq-projects/:projectId error", err);
        res.status(500).json({ message: "Failed to delete project" });
      }
    },
  );

  router.get(
    "/api/boq-projects/:projectId/items",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const allItems: any[] = [];
        const isGlobal = !projectId || projectId === 'global' || projectId === 'none' || projectId === 'undefined';

        console.log(`[DEBUG] Fetching items for project: ${projectId} (isGlobal: ${isGlobal})`);

        // 1. Get Project BOQ Items (Only if not global)
        if (!isGlobal) {
          const latestVersionResult = await query(
            `SELECT id FROM boq_versions 
             WHERE project_id = $1 
             ORDER BY version_number DESC LIMIT 1`,
            [projectId]
          );

          if (latestVersionResult.rows.length > 0) {
            const versionId = latestVersionResult.rows[0].id;
            const itemsResult = await query(
              `SELECT id, table_data FROM boq_items WHERE version_id = $1`,
              [versionId]
            );

            itemsResult.rows.forEach(row => {
              let tableData = row.table_data;
              if (typeof tableData === 'string') {
                try { tableData = JSON.parse(tableData); } catch (e) { return; }
              }

              if (tableData && tableData.step11_items && Array.isArray(tableData.step11_items)) {
                tableData.step11_items.forEach((item: any, index: number) => {
                  allItems.push({
                    id: `boq-${row.id}-${index}`,
                    itemName: item.itemName || item.item || item.name || "Unnamed Item",
                    category: "BOQ Item",
                    type: "item"
                  });
                });
              }
            });
          }
        }

        // 2. Get All Step11 Products
        const productsResult = await query("SELECT id, product_name, category_id FROM step11_products");
        productsResult.rows.forEach(p => {
          allItems.push({
            id: `prod-${p.id}`,
            itemName: p.product_name,
            category: p.category_id || "Product",
            type: "product"
          });
        });

        // 3. Get All Materials (from estimator_step9_cart or similar master list if exists)
        // For now, let's pull names from estimator_step9_cart uniquely to act as a material list
        const materialsResult = await query("SELECT DISTINCT item FROM estimator_step9_cart WHERE item IS NOT NULL AND item != ''");
        materialsResult.rows.forEach((m, idx) => {
          allItems.push({
            id: `mat-${idx}`,
            itemName: m.item,
            category: "Material",
            type: "material"
          });
        });

        res.json({ items: allItems });
      } catch (err) {
        console.error("GET /api/boq-projects/:projectId/items error", err);
        res.status(500).json({ message: "Failed to fetch items" });
      }
    }
  );

export default router;
