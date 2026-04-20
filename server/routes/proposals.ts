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

  router.get("/api/proposals", authMiddleware, async (req: Request, res: Response) => {
    try {
      const userRole = (req as any).user?.role;
      const userId = (req as any).user?.id;
      const { projectId } = req.query;

      let q = "SELECT * FROM proposals";
      const params: any[] = [];

      if (userRole === 'supplier') {
      const shopRes = await query("SELECT id FROM shops WHERE owner_id::text = $1::text LIMIT 1", [userId]);
        if (shopRes.rows.length > 0) {
          q += " WHERE vendor_id = $1";
          params.push(shopRes.rows[0].id);
        } else {
          q += " WHERE vendor_id = 'NONE'";
        }

        if (projectId) {
          q += ` AND project_id = $${params.length + 1}`;
          params.push(projectId);
        }
      } else {
        // Admin
        if (projectId) {
          q += " WHERE project_id = $1";
          params.push(projectId);
        }
      }

      q += " ORDER BY created_at DESC";
      const result = await query(q, params);
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch proposals" });
    }
  });

  router.get("/api/proposals/:id/items", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query("SELECT * FROM proposal_items WHERE proposal_id = $1 ORDER BY created_at ASC", [req.params.id]);
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch proposal items" });
    }
  });

  router.post("/api/proposals/:id/submit", authMiddleware, async (req: Request, res: Response) => {
    try {
      // Can update item rates and quantities here from req.body.items if provided
      const { items } = req.body;

      await query("BEGIN");

      if (items && Array.isArray(items)) {
        for (const it of items) {
          await query(
            "UPDATE proposal_items SET rate = $1, amount = $2 WHERE id = $3",
            [it.rate, it.amount, it.id]
          );
        }
      }

      const result = await query(
        "UPDATE proposals SET status = 'submitted', updated_at = NOW() WHERE id = $1 RETURNING *",
        [req.params.id]
      );

      await query("COMMIT");
      res.json(result.rows[0]);
    } catch (err) {
      await query("ROLLBACK");
      console.error(err);
      res.status(500).json({ message: "Failed to submit proposal" });
    }
  });

  router.post("/api/proposals/:id/approve", authMiddleware, requireRole('admin', 'software_team'), async (req: Request, res: Response) => {
    try {
      const result = await query(
        "UPDATE proposals SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      const proposal = result.rows[0];

      try {
        const vendorRes = await query(`
          SELECT u.email, u.display_name 
          FROM users u 
          JOIN shops s ON u.id = s.owner_id 
          WHERE s.id = $1
        `, [proposal.vendor_id]);

        if (vendorRes.rows.length > 0 && vendorRes.rows[0].email) {
          await sendProposalStatusEmail(
            vendorRes.rows[0].email,
            vendorRes.rows[0].display_name || 'Vendor',
            proposal.project_name || 'Project',
            proposal.version_number,
            'approved'
          );
        }
      } catch (e) {
        console.error("Failed to send approval email", e);
      }

      res.json(proposal);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to approve proposal" });
    }
  });

  router.post("/api/proposals/:id/reject", authMiddleware, requireRole('admin', 'software_team'), async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      const result = await query(
        "UPDATE proposals SET status = 'rejected', rejection_reason = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
        [reason || 'No reason specified', req.params.id]
      );
      const proposal = result.rows[0];

      try {
        const vendorRes = await query(`
          SELECT u.email, u.display_name 
          FROM users u 
          JOIN shops s ON u.id = s.owner_id 
          WHERE s.id = $1
        `, [proposal.vendor_id]);

        if (vendorRes.rows.length > 0 && vendorRes.rows[0].email) {
          await sendProposalStatusEmail(
            vendorRes.rows[0].email,
            vendorRes.rows[0].display_name || 'Vendor',
            proposal.project_name || 'Project',
            proposal.version_number,
            'rejected',
            proposal.rejection_reason
          );
        }
      } catch (e) {
        console.error("Failed to send rejection email", e);
      }

      res.json(proposal);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to reject proposal" });
    }
  });

  router.get("/api/proposals/approved/:projectId", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query(
        "SELECT * FROM proposals WHERE project_id = $1 AND status = 'approved' ORDER BY vendor_name, version_number DESC",
        [req.params.projectId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch approved proposals" });
    }
  });

export default router;
