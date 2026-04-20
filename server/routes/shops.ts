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

  router.get(
    "/api/suppliers-pending-approval",
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

        const result = await query(
          `SELECT id, username, role, approved, approval_reason
           FROM users
           WHERE role = 'supplier' AND approved IS DISTINCT FROM 'approved'
           ORDER BY username ASC`,
        );

        res.json({ suppliers: result.rows });
      } catch (err: any) {
        console.error("/api/suppliers-pending-approval error", err);
        res.status(500).json({ message: "failed to list pending suppliers" });
      }
    },
  );

  router.post(
    "/api/suppliers/:id/approve",
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
        console.error("/api/suppliers/:id/approve error", err);
        res.status(500).json({ message: "failed to approve supplier" });
      }
    },
  );

  router.post(
    "/api/suppliers/:id/reject",
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
        console.error("/api/suppliers/:id/reject error", err);
        res.status(500).json({ message: "failed to reject supplier" });
      }
    },
  );

  router.get("/api/shops", async (_req, res) => {
    try {
      // Return shops that are not explicitly rejected
      const result = await query(
        "SELECT * FROM shops WHERE approved IS NOT FALSE ORDER BY name ASC",
      );

      const archivedIds = archiveService.getArchivedItemIds('shops');
      const trashedIds = archiveService.getTrashedItemIds('shops');
      const filtered = result.rows.filter(r => !archivedIds.includes(r.id) && !trashedIds.includes(r.id));

      res.json({ shops: filtered });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("/api/shops error", err);
      res.status(500).json({ message: "failed to list shops" });
    }
  });

  router.post(
    "/api/shops",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        if (!req.user) {
          res
            .status(401)
            .json({ message: "Unauthorized: user not authenticated" });
          return;
        }

        const body = req.body || {};
        const id = randomUUID();
        const categories = Array.isArray(body.categories)
          ? body.categories
          : [];

        // eslint-disable-next-line no-console
        console.log(
          `[POST /api/shops] inserting shop: name=${body.name}, owner_id=${req.user.id}`,
        );

        const result = await query(
          `INSERT INTO shops (id, name, location, phoneCountryCode, contactNumber, city, state, country, pincode, image, rating, categories, gstNo, vendor_category, owner_id, approved, new_location, terms_and_conditions, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
           RETURNING *`,
          [
            id,
            body.name,
            body.location || null, // This is "Address" in UI
            body.phoneCountryCode || "+91",
            body.contactNumber,
            body.city || null,
            body.state || null,
            body.country || null,
            body.pincode || null,
            body.image || null,
            body.rating || 0,
            JSON.stringify(categories),
            body.gstNo || null,
            body.vendor_category || null,
            req.user.id,
            false,
            body.new_location || null,
            body.terms_and_conditions || null,
          ],
        );

        if (!result.rows || result.rows.length === 0) {
          res
            .status(500)
            .json({ message: "failed to create shop - no rows returned" });
          return;
        }

        res.status(201).json({ shop: result.rows[0] });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("create shop error", err);
        const errMessage = err instanceof Error ? err.message : String(err);
        res
          .status(500)
          .json({ message: "failed to create shop", error: errMessage });
      }
    },
  );

  router.get("/api/shops/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const result = await query("SELECT * FROM shops WHERE id = $1", [id]);
      if (result.rowCount === 0)
        return res.status(404).json({ message: "not found" });
      res.json({ shop: result.rows[0] });
    } catch (err: unknown) {
      console.error(err as any);
      res.status(500).json({ message: "error" });
    }
  });

  router.put("/api/shops/:id", authMiddleware, async (req, res) => {
    try {
      const id = req.params.id;
      const body = req.body || {};
      console.log("PUT /api/shops/:id - Received body:", JSON.stringify(body, null, 2));
      console.log("PUT /api/shops/:id - Shop ID:", id);

      const fields: string[] = [];
      const vals: any[] = [];
      let idx = 1;

      // Map of request field names to database column names
      const fieldMapping: Record<string, string> = {
        "name": "name",
        "location": "location",
        "phoneCountryCode": "phoneCountryCode",
        "contactNumber": "contactNumber",
        "city": "city",
        "state": "state",
        "country": "country",
        "pincode": "pincode",
        "image": "image",
        "rating": "rating",
        "gstNo": "gstno",
        "vendorCategory": "vendor_category",
        "new_location": "new_location",
        "terms_and_conditions": "terms_and_conditions",
      };

      for (const k of Object.keys(fieldMapping)) {
        if (body[k] !== undefined) {
          let value = body[k];
          // Special handling for rating - ensure it's a number or null
          if (k === 'rating') {
            value = (typeof value === 'number' && !isNaN(value)) ? value : null;
          }
          fields.push(`${fieldMapping[k]} = $${idx++}`);
          vals.push(value);
        }
      }
      if (body.categories !== undefined) {
        let categoriesValue;
        try {
          categoriesValue = Array.isArray(body.categories) ? JSON.stringify(body.categories) : JSON.stringify([]);
        } catch (e) {
          console.log("PUT /api/shops/:id - Error stringifying categories:", e);
          categoriesValue = JSON.stringify([]);
        }
        fields.push(`categories = $${idx++}`);
        vals.push(categoriesValue);
      }

      console.log("PUT /api/shops/:id - Fields to update:", fields);
      console.log("PUT /api/shops/:id - Values:", vals);

      if (fields.length === 0)
        return res.status(400).json({ message: "no fields" });
      vals.push(id);
      const q = `UPDATE shops SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
      console.log("PUT /api/shops/:id - SQL Query:", q);
      console.log("PUT /api/shops/:id - Final values array:", vals);

      const result = await query(q, vals);
      if (result.rowCount === 0) {
        console.log("PUT /api/shops/:id - No rows updated, shop not found");
        return res.status(404).json({ message: "Shop not found" });
      }
      console.log("PUT /api/shops/:id - Update successful, rows affected:", result.rowCount);
      res.json({ shop: result.rows[0] });
    } catch (err: unknown) {
      console.error("PUT /api/shops/:id - Database error:", err);
      if (err instanceof Error) {
        console.error("PUT /api/shops/:id - Error message:", err.message);
        console.error("PUT /api/shops/:id - Error stack:", err.stack);
      }
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ message: "Failed to update shop", error: errorMessage });
    }
  });

  router.delete(
    "/api/shops/:id",
    authMiddleware,
    requireRole("admin", "software_team"),
    async (req, res) => {
      try {
        const id = req.params.id;
        // Fetch shop data before archiving
        const shopRes = await query("SELECT * FROM shops WHERE id = $1", [id]);
        if (shopRes.rows.length === 0) {
          return res.status(404).json({ message: "Shop not found" });
        }

        const archived = archiveService.archiveItem('shops', id, shopRes.rows[0]);
        if (req.query.action === 'trash' && archived) {
          archiveService.trashArchiveItem(archived.id);
        }

        res.json({ message: "deleted" });
      } catch (err: unknown) {
        console.error(err as any);
        res.status(500).json({ message: "error" });
      }
    },
  );

  router.post(
    "/api/shops/:id/approve",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req, res) => {
      try {
        const id = req.params.id;
        // ensure approved column exists
        await query(
          "ALTER TABLE shops ADD COLUMN IF NOT EXISTS approved boolean DEFAULT true",
        );
        await query(
          "ALTER TABLE shops ADD COLUMN IF NOT EXISTS approval_reason text",
        );
        const result = await query(
          "UPDATE shops SET approved = true, approval_reason = NULL WHERE id = $1 RETURNING *",
          [id],
        );
        res.json({ shop: result.rows[0] });
      } catch (err: unknown) {
        console.error(err as any);
        res.status(500).json({ message: "error" });
      }
    },
  );

  router.post(
    "/api/shops/:id/reject",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req, res) => {
      try {
        const id = req.params.id;
        // Delete associated materials first, then the shop itself
        await query("DELETE FROM materials WHERE shop_id = $1", [id]);
        await query("DELETE FROM shops WHERE id = $1", [id]);
        res.json({ message: "Shop rejected and removed", id });
      } catch (err: unknown) {
        console.error(err as any);
        res.status(500).json({ message: "error" });
      }
    },
  );

  router.get("/api/shops-pending-approval", async (_req, res) => {
    try {
      const result = await query(
        "SELECT * FROM shops WHERE approved IS NOT TRUE ORDER BY created_at DESC",
      );
      const requests = result.rows.map((r: any) => ({
        id: r.id,
        status: "pending",
        shop: r,
      }));
      res.json({ shops: requests });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("/api/shops-pending-approval error", err);
      res.status(500).json({ message: "failed to list pending shops" });
    }
  });

  router.get("/api/vendor-categories", async (_req, res) => {
    try {
      const result = await query(
        "SELECT * FROM vendor_categories ORDER BY name ASC",
      );
      res.json({ categories: result.rows });
    } catch (err) {
      console.error("/api/vendor-categories GET error", err);
      res.status(500).json({ message: "failed to list vendor categories" });
    }
  });

  router.post(
    "/api/vendor-categories",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req: Request, res: Response) => {
      try {
        const { name, description } = req.body;

        if (!name || !name.trim()) {
          res.status(400).json({ message: "Name is required" });
          return;
        }

        // Case-insensitive check before insert
        const existing = await query(
          "SELECT id FROM vendor_categories WHERE LOWER(name) = LOWER($1)",
          [name.trim()],
        );

        if (existing.rows.length > 0) {
          res.status(409).json({ message: "VENDOR CATEGORY ALREADY EXISTS" });
          return;
        }

        const result = await query(
          `INSERT INTO vendor_categories (name, description, created_at, updated_at) 
           VALUES ($1, $2, NOW(), NOW()) 
           RETURNING *`,
          [name.trim(), description || null],
        );

        res.status(201).json({ category: result.rows[0] });
      } catch (err: any) {
        console.error("/api/vendor-categories POST error", err);
        if (err.code === "23505") {
          // Unique constraint violation
          res.status(409).json({ message: "VENDOR CATEGORY ALREADY EXISTS" });
        } else {
          res.status(500).json({ message: "failed to create vendor category" });
        }
      }
    },
  );

  router.put(
    "/api/vendor-categories/:id",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const { name, description } = req.body;

        const fields: string[] = [];
        const vals: any[] = [];
        let idx = 1;

        if (name !== undefined && name.trim()) {
          fields.push(`name = $${idx++}`);
          vals.push(name.trim());
        }

        if (description !== undefined) {
          fields.push(`description = $${idx++}`);
          vals.push(description);
        }

        if (fields.length === 0) {
          res.status(400).json({ message: "No fields to update" });
          return;
        }

        fields.push(`updated_at = $${idx++}`);
        vals.push(new Date());
        vals.push(id);

        const q = `UPDATE vendor_categories SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
        const result = await query(q, vals);

        if (result.rows.length === 0) {
          res.status(404).json({ message: "Vendor category not found" });
          return;
        }

        res.json({ category: result.rows[0] });
      } catch (err: any) {
        console.error("/api/vendor-categories PUT error", err);
        if (err.code === "23505") {
          res.status(409).json({ message: "Vendor category name already exists" });
        } else {
          res.status(500).json({ message: "failed to update vendor category" });
        }
      }
    },
  );

  router.delete(
    "/api/vendor-categories/:id",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id;

        const result = await query(
          "DELETE FROM vendor_categories WHERE id = $1 RETURNING id",
          [id],
        );

        if (result.rowCount === 0) {
          res.status(404).json({ message: "Vendor category not found" });
          return;
        }

        res.json({ message: "Vendor category deleted successfully" });
      } catch (err: any) {
        console.error("/api/vendor-categories DELETE error", err);
        res.status(500).json({ message: "failed to delete vendor category" });
      }
    },
  );

  router.post(
    "/api/bulk-shops",
    authMiddleware,
    requireRole("admin", "software_team", "purchase_team"),
    async (req: Request, res: Response) => {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

      if (rows.length === 0) {
        res.status(400).json({ message: "No rows provided" });
        return;
      }

      const createdShops: any[] = [];
      const skipped: any[] = [];
      const errors: any[] = [];

      try {
        await query("BEGIN");
        // eslint-disable-next-line no-console
        console.log(`[POST /api/bulk-shops] Processing ${rows.length} rows`);

        for (let i = 0; i < rows.length; i++) {
          const raw = rows[i] || {};
          const name = (raw.name || raw.Name || "").toString().trim();
          const location = (raw.location || raw.Location || "").toString().trim() || null;
          const city = (raw.city || raw.City || "").toString().trim() || null;
          const phoneCountryCode = (raw.phoneCountryCode || raw.phone_country_code || "").toString().trim() || "+91";
          const contactNumber = (raw.contactNumber || raw.contact_number || raw.Phone || "").toString().trim() || null;
          const state = (raw.state || raw.State || "").toString().trim() || null;
          const country = (raw.country || raw.Country || "").toString().trim() || "India";
          const pincode = (raw.pincode || raw.Pincode || raw.Zipcode || "").toString().trim() || null;
          const gstNo = (raw.gstNo || raw.gst_no || raw.gstno || raw.GST || "").toString().trim() || null;
          const vendorCategory = (raw.vendorCategory || raw.vendor_category || "").toString().trim() || null;

          if (!name) {
            skipped.push({ row: i, reason: "missing name" });
            continue;
          }

          if (!city) {
            skipped.push({ row: i, reason: "missing city" });
            continue;
          }

          try {
            const id = randomUUID();
            const result = await query(
              `INSERT INTO shops (id, name, location, phonecountrycode, contactnumber, city, state, country, pincode, gstno, vendor_category, owner_id, approved, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now()) RETURNING *`,
              [
                id,
                name,
                location,
                phoneCountryCode,
                contactNumber,
                city,
                state,
                country,
                pincode,
                gstNo,
                vendorCategory,
                (req as any).user.id,
                false, // Bulk uploaded shops go through approval flow
              ],
            );
            createdShops.push(result.rows[0]);
          } catch (insertErr) {
            errors.push({ row: i, error: `Insert error: ${String(insertErr)}` });
            continue;
          }
        }

        await query("COMMIT");

        res.json({
          message: "Bulk shops uploaded successfully",
          createdShopsCount: createdShops.length,
          skipped,
          errors,
        });
      } catch (err) {
        try { await query("ROLLBACK"); } catch (rbErr) { console.error("rollback failed", rbErr); }
        console.error("/api/bulk-shops error", err);
        res.status(500).json({ message: "bulk shop upload failed", error: String(err) });
      }
    },
  );

  router.get(
    "/api/supplier/my-shops",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).user?.id;
        if (!userId) {
          return res
            .status(401)
            .json({ message: "Unauthorized: user not authenticated" });
        }

        // Get shops owned by this user
        const result = await query(
          "SELECT * FROM shops WHERE owner_id = $1 ORDER BY created_at DESC",
          [userId],
        );

        res.json({ shops: result.rows });
      } catch (err: any) {
        console.error("/api/supplier/my-shops error", err);
        res.status(500).json({ message: "failed to get shops" });
      }
    },
  );

  router.get(
    "/api/supplier/my-submissions",
    authMiddleware,
    requireRole("supplier", "purchase_team", "admin"),
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).user?.id;
        console.log(
          "[supplier/my-submissions] fetching shops for user:",
          userId,
        );

        // Get shops owned by this user
        const shopsResult = await query(
          "SELECT id as shop_id FROM shops WHERE owner_id = $1",
          [userId],
        );
        const shopIds = shopsResult.rows.map((row: any) => row.shop_id);

        if (shopIds.length === 0) {
          return res.json({ submissions: [] });
        }

        // Get submissions for these shops
        const result = await query(
          `SELECT ms.*, mt.name as template_name, mt.code as template_code, mt.category, s.name as shop_name
           FROM material_submissions ms
           JOIN material_templates mt ON ms.template_id = mt.id
           JOIN shops s ON ms.shop_id = s.id
           WHERE ms.shop_id = ANY($1)
           ORDER BY ms.submitted_at DESC`,
          [shopIds],
        );

        const submissions = result.rows.map((row: any) => ({
          id: row.id,
          status:
            row.approved === true
              ? "approved"
              : row.approved === false
                ? "rejected"
                : "pending",
          submission: row,
        }));

        res.json({ submissions });
      } catch (err: any) {
        console.error("/api/supplier/my-submissions error", err);
        res.status(500).json({ message: "failed to get submissions" });
      }
    },
  );

export default router;
