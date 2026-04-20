import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { authMiddleware, requireRole } from "../middleware";
import { storage } from "../storage";
import { randomUUID } from "crypto";
import { sendSketchPlanEmail, sendSiteReportEmail, sendProposalStatusEmail } from "../email";
import fs from "fs";

const router = Router();

router.get("/api/materials", async (_req, res) => {
  try {
    // Only return materials that are approved for public listing
    const result = await query(
      `SELECT m.*, s.name as shop_name, 
                mt.tax_code_type, mt.tax_code_value 
         FROM materials m 
         LEFT JOIN shops s ON m.shop_id = s.id 
         LEFT JOIN material_templates mt ON m.template_id = mt.id 
         WHERE m.approved IS TRUE 
         ORDER BY m.created_at DESC`,
    );

    const archivedIds = archiveService.getArchivedItemIds('materials');
    const trashedIds = archiveService.getTrashedItemIds('materials');
    const filtered = result.rows.filter(r => !archivedIds.includes(r.id) && !trashedIds.includes(r.id));

    res.json({ materials: filtered });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("/api/materials error", err);
    res.status(500).json({ message: "failed to list materials" });
  }
});

router.get("/api/material-rate", async (req, res) => {
  try {
    const { template_id, shop_id } = req.query;

    if (!template_id || !shop_id) {
      res.status(400).json({
        message: "template_id and shop_id are required",
      });
      return;
    }

    // First try to fetch from approved materials
    const materialResult = await query(
      `SELECT rate, unit, brandname, modelnumber, category, subcategory, product, technicalspecification, dimensions, finishtype, metaltype, image, created_at 
         FROM materials 
         WHERE template_id = $1 AND shop_id = $2 AND approved IS TRUE 
         LIMIT 1`,
      [template_id, shop_id],
    );

    if (materialResult.rows.length > 0) {
      res.json({
        found: true,
        source: "approved",
        material: materialResult.rows[0],
      });
      return;
    }

    // If no approved material found, try to fetch from material submissions
    const submissionResult = await query(
      `SELECT rate, unit, brandname, modelnumber, category, subcategory, product, technicalspecification, dimensions, finishtype, metaltype, image, submitted_at as created_at 
         FROM material_submissions 
         WHERE template_id = $1 AND shop_id = $2 
         ORDER BY submitted_at DESC 
         LIMIT 1`,
      [template_id, shop_id],
    );

    if (submissionResult.rows.length > 0) {
      res.json({
        found: true,
        source: "submitted",
        material: submissionResult.rows[0],
      });
      return;
    }

    // No rate found
    res.json({
      found: false,
      source: null,
      material: null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("/api/material-rate error", err);
    res.status(500).json({ message: "failed to fetch material rate" });
  }
});

router.put("/api/materials/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const fields: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    for (const k of [
      "name",
      "code",
      "rate",
      "shop_id",
      "unit",
      "category",
      "brandname",
      "modelnumber",
      "subcategory",
      "subCategory",
      "product",
      "hsn_code",
      "hsnCode",
      "sac_code",
      "sacCode",
      "technicalspecification",
      "dimensions",
      "finishtype",
      "metaltype",
      "metalType",
      "materialtype",
      "materialType",
      "image",
      "template_id",
      "templateId"
    ]) {
      if (body[k] !== undefined) {
        let val = body[k];
        let dbFieldName = k;
        if (k === "templateId") dbFieldName = "template_id";
        if (k === "subCategory") dbFieldName = "subcategory";
        if (k === "metalType" || k === "materialtype" || k === "materialType") dbFieldName = "metaltype";
        if (k === "hsnCode") dbFieldName = "hsn_code";
        if (k === "sacCode") dbFieldName = "sac_code";
        if (k === "brandName") dbFieldName = "brandname";
        if (k === "modelNumber") dbFieldName = "modelnumber";
        if (k === "finishType") dbFieldName = "finishtype";

        if (dbFieldName === "shop_id" && val === "") val = null;
        if (dbFieldName === "rate") val = parseSafeNumeric(val);
        fields.push(`${dbFieldName} = $${idx++}`);
        vals.push(val);
      }
    }
    if (body.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`);
      vals.push(JSON.stringify(body.attributes));
    }
    if (fields.length === 0)
      return res.status(400).json({ message: "no fields" });
    vals.push(id);
    const q = `UPDATE materials SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
    console.log('[PUT /api/materials/:id] body:', body);
    console.log('[PUT /api/materials/:id] query:', q);
    console.log('[PUT /api/materials/:id] vals:', vals);
    const result = await query(q, vals);
    res.json({ material: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "error" });
  }
});

export default router;
