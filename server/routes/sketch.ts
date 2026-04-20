import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { authMiddleware, requireRole } from "../middleware";
import { storage } from "../storage";
import { randomUUID } from "crypto";
import { sendSketchPlanEmail, sendSiteReportEmail, sendProposalStatusEmail } from "../email";
import fs from "fs";

const router = Router();

router.get("/api/sketch-plans", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query(
        `SELECT sp.*, p.name as project_name, spl.is_locked, spl.request_status
         FROM sketch_plans sp 
         LEFT JOIN boq_projects p ON sp.project_id = p.id 
         LEFT JOIN sketch_plan_locks spl ON sp.id = spl.plan_id
         ORDER BY sp.project_id NULLS LAST, sp.created_at ASC`
      );
      const archivedIds = archiveService.getArchivedItemIds('sketch_plans');
      const trashedIds = archiveService.getTrashedItemIds('sketch_plans');
      const filtered = (result.rows || []).filter((r: any) => !archivedIds.includes(r.id) && !trashedIds.includes(r.id));
      res.json({ plans: filtered });
    } catch (err) {
      console.error("GET /api/sketch-plans error", err);
      res.status(500).json({ message: "Failed to fetch sketch plans" });
    }
  });

router.post("/api/sketch-plans/:id/new-version", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { copyItems = true } = req.body;
      const created_by = (req as any).user?.id || null;

      // Get the source plan
      const planRes = await query("SELECT * FROM sketch_plans WHERE id = $1", [id]);
      if (planRes.rows.length === 0) return res.status(404).json({ message: "Plan not found" });
      const sourcePlan = planRes.rows[0];

      // Determine root plan id (for grouping versions)
      const rootId = sourcePlan.parent_plan_id || id;

      // Find the current max version number for this root
      const maxVerRes = await query(
        `SELECT COALESCE(MAX(version_number), 1) as max_ver FROM sketch_plans WHERE id = $1 OR parent_plan_id = $1`,
        [rootId]
      );
      const nextVersion = (maxVerRes.rows[0]?.max_ver || 1) + 1;

      const newId = `skp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      await query("BEGIN");
      try {
        // Create the new plan version
        await query(
          `INSERT INTO sketch_plans (id, name, project_id, location, plan_date, created_by, version_number, parent_plan_id, version_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')`,
          [newId, sourcePlan.name, sourcePlan.project_id, sourcePlan.location, sourcePlan.plan_date, created_by, nextVersion, rootId]
        );

        if (copyItems) {
          // Copy items from source plan
          const srcItems = await query("SELECT * FROM sketch_plan_items WHERE plan_id = $1 ORDER BY created_at ASC", [id]);
          for (let i = 0; i < srcItems.rows.length; i++) {
            const srcItem = srcItems.rows[i];
            const newItemId = `ski-${Date.now()}-${String(i).padStart(4, '0')}-${Math.random().toString(36).substr(2, 5)}`;
            await query(
              `INSERT INTO sketch_plan_items (id, plan_id, item_name, description, length, width, height, qty, unit, remarks, material_id, dimension_unit, assigned_vendor_id, vendor_name)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [newItemId, newId, srcItem.item_name, srcItem.description, srcItem.length, srcItem.width, srcItem.height, srcItem.qty, srcItem.unit, srcItem.remarks, srcItem.material_id, srcItem.dimension_unit || 'feet', srcItem.assigned_vendor_id || null, srcItem.vendor_name || null]
            );

            // Copy item-level images
            const srcItemImages = await query("SELECT * FROM sketch_plan_images WHERE plan_id = $1 AND item_id = $2", [id, srcItem.id]);
            for (const img of srcItemImages.rows) {
              const newImgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              await query(
                `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) VALUES ($1, $2, $3, $4, $5)`,
                [newImgId, newId, newItemId, img.image_url, img.image_name]
              );
            }
          }

          // Copy plan-level images (item_id IS NULL)
          const srcPlanImages = await query("SELECT * FROM sketch_plan_images WHERE plan_id = $1 AND item_id IS NULL", [id]);
          for (const img of srcPlanImages.rows) {
            const newImgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) VALUES ($1, $2, $3, $4, $5)`,
              [newImgId, newId, null, img.image_url, img.image_name]
            );
          }

          // Copy attachments
          const srcAttachments = await query("SELECT * FROM sketch_plan_attachments WHERE plan_id = $1", [id]);
          for (const att of srcAttachments.rows) {
            const newAttId = `att-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_attachments (id, plan_id, file_url, file_name, file_type) VALUES ($1, $2, $3, $4, $5)`,
              [newAttId, newId, att.file_url, att.file_name, att.file_type]
            );
          }
        }

        await query("COMMIT");
        res.json({ id: newId, version_number: nextVersion, message: `Version ${nextVersion} created` });
      } catch (err) {
        await query("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("POST /api/sketch-plans/:id/new-version error", err);
      res.status(500).json({ message: "Failed to create new version" });
    }
  });

router.get("/api/sketch-plans/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const planRes = await query(
        `SELECT sp.*, spl.is_locked, spl.request_status, spl.request_reason,
                p.name as project_name
         FROM sketch_plans sp
         LEFT JOIN sketch_plan_locks spl ON sp.id = spl.plan_id
         LEFT JOIN boq_projects p ON sp.project_id = p.id
         WHERE sp.id = $1`,
        [id]
      );
      if (planRes.rows.length === 0) {
        return res.status(404).json({ message: "Plan not found" });
      }

      const itemsRes = await query(`
        SELECT spi.*, 
               COALESCE(m.category, p.subcategory) AS category
        FROM sketch_plan_items spi
        LEFT JOIN materials m ON spi.material_id::text = m.id::text
        LEFT JOIN products p ON spi.material_id::text = p.id::text
        WHERE spi.plan_id = $1 
        ORDER BY spi.created_at ASC, spi.id ASC`,
        [id]
      );
      const imagesRes = await query(
        "SELECT id, item_id, image_url, image_name FROM sketch_plan_images WHERE plan_id = $1",
        [id]
      );
      const attachmentsRes = await query(
        "SELECT id, file_url, file_name, file_type FROM sketch_plan_attachments WHERE plan_id = $1",
        [id]
      );

      res.json({
        plan: planRes.rows[0],
        items: itemsRes.rows || [],
        images: imagesRes.rows || [],
        attachments: attachmentsRes.rows || []
      });
    } catch (err) {
      console.error("GET /api/sketch-plans/:id error", err);
      res.status(500).json({ message: "Failed to fetch plan details" });
    }
  });

router.post("/api/sketch-plans", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { name, project_id, location, plan_date, items, images } = req.body;
      const id = `skp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const created_by = (req as any).user?.id || null;

      await query("BEGIN");

      try {
        const finalPlanDate = (plan_date && plan_date.trim() !== "") ? plan_date : null;
        console.log(`[api/sketch-plans] Creating plan: name=${name}, date=${finalPlanDate}, project_id=${project_id}`);
        await query(
          `INSERT INTO sketch_plans (id, name, project_id, location, plan_date, created_by) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, name, project_id || null, location || null, finalPlanDate, created_by]
        );

        if (items && Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemId = `ski-${`${Date.now()}`.padStart(15, '0')}-${String(i).padStart(4, '0')}-${Math.random().toString(36).substr(2, 5)}`;
            await query(
              `INSERT INTO sketch_plan_items (id, plan_id, item_name, description, length, width, height, qty, unit, remarks, material_id, dimension_unit, assigned_vendor_id, vendor_name) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                itemId, id, item.item_name, item.description,
                parseSafeNumeric(item.length),
                parseSafeNumeric(item.width),
                parseSafeNumeric(item.height),
                parseSafeNumeric(item.qty),
                item.unit, item.remarks,
                item.material_id || null,
                item.dimension_unit || 'feet',
                item.assigned_vendor_id || null,
                item.vendor_name || null
              ]
            );

            // Row-level images
            if (item.images && Array.isArray(item.images)) {
              for (const img of item.images) {
                const imgUrl = typeof img === "string" ? img : (img.url || img.image_url);
                const imgName = typeof img === "string" ? null : (img.name || img.image_name);
                const imgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                await query(
                  `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) VALUES ($1, $2, $3, $4, $5)`,
                  [imgId, id, itemId, imgUrl, imgName]
                );
              }
            }
          }
        }

        // Plan-level images
        if (images && Array.isArray(images)) {
          for (const img of images) {
            if (img.item_id) continue;
            const imgUrl = typeof img === "string" ? img : (img.image_url || img.url);
            const imgName = typeof img === "string" ? null : (img.name || img.image_name);
            const imgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) 
               VALUES ($1, $2, $3, $4, $5)`,
              [imgId, id, null, imgUrl, imgName]
            );
          }
        }

        // Plan-level attachments (PDF/Excel)
        const attachments = req.body.attachments;
        if (attachments && Array.isArray(attachments)) {
          for (const att of attachments) {
            const attId = `att-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_attachments (id, plan_id, file_url, file_name, file_type) 
               VALUES ($1, $2, $3, $4, $5)`,
              [attId, id, att.file_url || att.url, att.file_name || att.name, att.file_type || att.type]
            );
          }
        }

        await query("COMMIT");
        res.json({ id, message: "Sketch plan created successfully" });
      } catch (err) {
        await query("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("POST /api/sketch-plans error", err);
      res.status(500).json({ message: "Failed to create sketch plan" });
    }
  });

router.put("/api/sketch-plans/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, project_id, location, plan_date, items, images } = req.body;

      await query("BEGIN");

      try {
        const finalPlanDate = (plan_date && plan_date.trim() !== "") ? plan_date : null;
        console.log(`[api/sketch-plans] Updating plan: id=${id}, name=${name}, date=${finalPlanDate}, project_id=${project_id}`);
        await query(
          `UPDATE sketch_plans SET name = $1, project_id = $2, location = $3, plan_date = $4, updated_at = NOW() WHERE id = $5`,
          [name, project_id || null, location || null, finalPlanDate, id]
        );

        // Delete old items and images
        await query("DELETE FROM sketch_plan_items WHERE plan_id = $1", [id]);
        await query("DELETE FROM sketch_plan_images WHERE plan_id = $1", [id]);

        if (items && Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemId = `ski-${`${Date.now()}`.padStart(15, '0')}-${String(i).padStart(4, '0')}-${Math.random().toString(36).substr(2, 5)}`;
            await query(
              `INSERT INTO sketch_plan_items (id, plan_id, item_name, description, length, width, height, qty, unit, remarks, material_id, dimension_unit, assigned_vendor_id, vendor_name) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                itemId, id, item.item_name, item.description,
                parseSafeNumeric(item.length),
                parseSafeNumeric(item.width),
                parseSafeNumeric(item.height),
                parseSafeNumeric(item.qty),
                item.unit, item.remarks,
                item.material_id || null,
                item.dimension_unit || 'feet',
                item.assigned_vendor_id || null,
                item.vendor_name || null
              ]
            );

            // Row-level images
            if (item.images && Array.isArray(item.images)) {
              for (const img of item.images) {
                const imgUrl = typeof img === "string" ? img : (img.url || img.image_url);
                const imgName = typeof img === "string" ? null : (img.name || img.image_name);
                const imgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                await query(
                  `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) VALUES ($1, $2, $3, $4, $5)`,
                  [imgId, id, itemId, imgUrl, imgName]
                );
              }
            }
          }
        }

        // Plan-level images
        if (images && Array.isArray(images)) {
          for (const img of images) {
            if (img.item_id) continue;
            const imgUrl = typeof img === "string" ? img : (img.image_url || img.url);
            const imgName = typeof img === "string" ? null : (img.name || img.image_name);
            const imgId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_images (id, plan_id, item_id, image_url, image_name) 
               VALUES ($1, $2, $3, $4, $5)`,
              [imgId, id, null, imgUrl, imgName]
            );
          }
        }

        // Plan-level attachments (PDF/Excel)
        await query("DELETE FROM sketch_plan_attachments WHERE plan_id = $1", [id]);
        const attachments = req.body.attachments;
        if (attachments && Array.isArray(attachments)) {
          for (const att of attachments) {
            const attId = `att-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await query(
              `INSERT INTO sketch_plan_attachments (id, plan_id, file_url, file_name, file_type) 
               VALUES ($1, $2, $3, $4, $5)`,
              [attId, id, att.file_url || att.url, att.file_name || att.name, att.file_type || att.type]
            );
          }
        }

        await query("COMMIT");
        res.json({ message: "Sketch plan updated successfully" });
      } catch (err) {
        await query("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("PUT /api/sketch-plans/:id error", err);
      res.status(500).json({ message: "Failed to update sketch plan" });
    }
  });

router.delete("/api/sketch-plans/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const planRes = await query("SELECT * FROM sketch_plans WHERE id = $1", [id]);
      if (planRes.rows.length === 0) return res.status(404).json({ message: "Plan not found" });

      const archived = archiveService.archiveItem('sketch_plans', id, planRes.rows[0]);
      if (req.query.action === 'trash' && archived) {
        archiveService.trashArchiveItem(archived.id);
      }
      res.json({ message: "Sketch plan deleted successfully" });
    } catch (err) {
      console.error("DELETE /api/sketch-plans/:id error", err);
      res.status(500).json({ message: "Failed to delete sketch plan" });
    }
  });

router.post("/api/sketch-plans/:id/lock", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const lockId = `spl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Upsert lock status
      await query(
        `INSERT INTO sketch_plan_locks (id, plan_id, is_locked, updated_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (plan_id) DO UPDATE SET is_locked = TRUE, updated_at = NOW()`,
        [lockId, id]
      );

      res.json({ message: "Plan locked successfully" });
    } catch (err) {
      console.error("POST /api/sketch-plans/:id/lock error", err);
      res.status(500).json({ message: "Failed to lock plan" });
    }
  });

router.post("/api/sketch-plans/:id/request-unlock", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const lockId = `spl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      await query(
        `INSERT INTO sketch_plan_locks (id, plan_id, request_status, request_reason, updated_at)
         VALUES ($1, $2, 'pending', $3, NOW())
         ON CONFLICT (plan_id) DO UPDATE SET request_status = 'pending', request_reason = $3, updated_at = NOW()`,
        [lockId, id, reason || "No reason provided"]
      );

      res.json({ message: "Unlock request submitted" });
    } catch (err) {
      console.error("POST /api/sketch-plans/:id/request-unlock error", err);
      res.status(500).json({ message: "Failed to submit unlock request" });
    }
  });

router.post("/api/sketch-plans/:id/handle-unlock", authMiddleware, requireRole("admin"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { action } = req.body; // 'approve' or 'reject'

      if (action === 'approve') {
        await query(
          `UPDATE sketch_plan_locks 
           SET is_locked = FALSE, request_status = 'approved', updated_at = NOW() 
           WHERE plan_id = $1`,
          [id]
        );
        res.json({ message: "Unlock request approved" });
      } else {
        await query(
          `UPDATE sketch_plan_locks 
           SET request_status = 'rejected', updated_at = NOW() 
           WHERE plan_id = $1`,
          [id]
        );
        res.json({ message: "Unlock request rejected" });
      }
    } catch (err) {
      console.error("POST /api/sketch-plans/:id/handle-unlock error", err);
      res.status(500).json({ message: "Failed to handle unlock request" });
    }
  });

router.get("/api/sketch-templates", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query("SELECT * FROM sketch_templates ORDER BY created_at DESC");
      res.json({ templates: result.rows || [] });
    } catch (err) {
      console.error("GET /api/sketch-templates error", err);
      res.status(500).json({ message: "Failed to fetch templates" });
    }
  });

router.post("/api/sketch-templates", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { name, template_data } = req.body;
      const id = `skt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await query(
        `INSERT INTO sketch_templates (id, name, template_data) VALUES ($1, $2, $3)`,
        [id, name, JSON.stringify(template_data)]
      );
      res.json({ id, message: "Template saved" });
    } catch (err) {
      console.error("POST /api/sketch-templates error", err);
      res.status(500).json({ message: "Failed to save template" });
    }
  });

router.delete("/api/sketch-templates/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await query("DELETE FROM sketch_templates WHERE id = $1", [id]);
      res.json({ message: "Template deleted" });
    } catch (err) {
      console.error("DELETE /api/sketch-templates/:id error", err);
      res.status(500).json({ message: "Failed to delete template" });
    }
  });

router.post("/api/sketch-plans/:id/load-to-proposal", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;
      const userRole = (req as any).user?.role;

      if (userRole !== 'supplier' && userRole !== 'admin' && userRole !== 'software_team') {
        return res.status(403).json({ message: "Only vendors or admins can load items to proposal" });
      }

      const planRes = await query("SELECT * FROM sketch_plans WHERE id = $1", [id]);
      if (planRes.rows.length === 0) return res.status(404).json({ message: "Plan not found" });
      const plan = planRes.rows[0];

      if (!plan.project_id) {
        return res.status(400).json({ message: "This sketch plan is not linked to any project" });
      }

      let itemsQuery = "SELECT * FROM sketch_plan_items WHERE plan_id = $1";
      const queryParams: any[] = [id];
      let shopName = "All Vendors";
      let shopId = null;

      const shopRes = await query("SELECT id, name FROM shops WHERE owner_id::text = $1::text LIMIT 1", [userId]);
      if (userRole === 'supplier') {
        if (shopRes.rows.length === 0) {
          return res.status(400).json({ message: "No shop associated with your account" });
        }
        shopId = shopRes.rows[0].id;
        shopName = shopRes.rows[0].name || "Vendor";
        // Use case-insensitive matching for vendor name and explicit text casting for IDs
        itemsQuery += " AND (assigned_vendor_id::text = $2::text OR LOWER(vendor_name) = LOWER($3) OR assigned_vendor_id = $4)";
        queryParams.push(shopId);
        queryParams.push(shopName);
        queryParams.push(userId);
      } else if (userRole !== 'admin' && userRole !== 'software_team') {
        return res.status(403).json({ message: "Only vendors or admins can load items to proposal" });
      }

      const itemsRes = await query(itemsQuery, queryParams);
      const items = itemsRes.rows;

      if (items.length === 0) {
        return res.status(400).json({ message: "No items assigned to you in this plan" });
      }

      await query("BEGIN");
      try {
        const vendorIdToUse = shopId || userId;
        console.log(`[LoadToProposal] User: ${userId}, Role: ${userRole}, ShopId: ${shopId}, ShopName: ${shopName}`);
        console.log(`[LoadToProposal] Items found: ${items.length}`);

        const projectRes = await query("SELECT * FROM boq_projects WHERE id = $1", [plan.project_id]);
        const project = projectRes.rows[0];
        if (!project) throw new Error(`Associated project (${plan.project_id}) not found`);

        const versionRes = await query(
          "SELECT COALESCE(MAX(version_number), 0) as last_version FROM proposals WHERE project_id = $1 AND vendor_id::text = $2::text",
          [plan.project_id, vendorIdToUse]
        );
        const nextVersionNum = (versionRes.rows[0].last_version || 0) + 1;

        const proposalCreateRes = await query(
          `INSERT INTO proposals (
            project_id, project_name, vendor_id, vendor_name, version_number, status
          ) VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING id`,
          [plan.project_id, project.name, vendorIdToUse, shopName, nextVersionNum]
        );
        const newProposalId = proposalCreateRes.rows[0].id;

        const materialsRes = await query("SELECT id, name, rate, unit, technicalspecification FROM materials", []);
        const materialsById = Object.fromEntries(materialsRes.rows.map(m => [m.id?.toString(), m]));
        const materialsByName = Object.fromEntries(materialsRes.rows.map(m => [m.name?.toLowerCase()?.trim() || "", m]));

        for (const item of items) {
          let matchedMaterial = item.material_id ? materialsById[item.material_id.toString()] : null;
          if (!matchedMaterial && item.item_name) {
            matchedMaterial = materialsByName[item.item_name.toLowerCase().trim()];
          }

          // Robust parsing for dimensions and quantity
          const qty = parseFloat(item.qty || item.quantity) || 0;
          const rate = matchedMaterial ? parseFloat(matchedMaterial.rate) : 0;

          await query(
            `INSERT INTO proposal_items (
              proposal_id, material_id, item_name, qty, unit, rate, amount
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              newProposalId,
              matchedMaterial?.id || item.material_id || null,
              item.item_name || "Untitled Item",
              qty,
              item.unit || matchedMaterial?.unit || "unit",
              rate,
              qty * rate
            ]
          );
        }

        await query("COMMIT");
        res.json({
          success: true,
          message: `Proposal version ${nextVersionNum} for ${shopName} created`,
          versionId: newProposalId,
          projectId: plan.project_id
        });
      } catch (err: any) {
        await query("ROLLBACK");
        console.error("[LoadToProposal] Internal error:", err);
        res.status(500).json({ message: `Database error: ${err.message}` });
      }
    } catch (err: any) {
      console.error("[LoadToProposal] Outer error:", err);
      res.status(500).json({ message: err.message || "Failed to load items to proposal" });
    }
  });

export default router;
