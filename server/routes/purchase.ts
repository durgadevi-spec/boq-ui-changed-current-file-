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

  router.get("/api/purchase-orders/preview-vendors", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { versionId } = req.query;
      if (!versionId) return res.status(400).json({ message: "versionId is required" });

      const itemsResult = await query(
        `SELECT table_data FROM boq_items WHERE version_id = $1`,
        [versionId]
      );

      const shopNames = new Set();

      // Helper: recursively extract shop_name from items and their nested step11_items
      const extractShopNames = (items: any[]) => {
        for (const item of items) {
          const name = item.shop_name || item.shopName;
          if (name && typeof name === "string" && name.trim().length > 0) {
            shopNames.add(name.trim());
          }
          // Drill into nested step11_items (consolidated products)
          if (Array.isArray(item.step11_items)) {
            extractShopNames(item.step11_items);
          }
        }
      }

      for (const row of itemsResult.rows) {
        const td = parseSafeTableData(row.table_data);
        // For engine-based products, prioritize materialLines (they have shop_name)
        if (Array.isArray(td.materialLines) && td.targetRequiredQty !== undefined) {
          extractShopNames(td.materialLines);
        }
        if (Array.isArray(td.step11_items)) extractShopNames(td.step11_items);
        if (Array.isArray(td.materialLines)) extractShopNames(td.materialLines);
        if (Array.isArray(td.items)) extractShopNames(td.items);
        if (Array.isArray(td.rows)) extractShopNames(td.rows);
      }

      if (shopNames.size === 0) {
        return res.json({ vendors: [] });
      }

      const shopNamesArr = Array.from(shopNames);
      const shopsResult = await query(
        `SELECT id, name, location FROM shops WHERE TRIM(name) = ANY($1::text[])`,
        [shopNamesArr]
      );

      // For shop names with no matching shop record, create placeholder entries
      const foundNames = new Set(shopsResult.rows.map((r) => r.name.trim()));
      const placeholders = shopNamesArr
        .filter(n => !foundNames.has(n))
        .map(n => ({ id: null, name: n, location: null }));

      res.json({ vendors: [...shopsResult.rows, ...placeholders] });
    } catch (err) {
      console.error("GET /api/purchase-orders/preview-vendors error", err);
      res.status(500).json({ message: "Failed to preview vendors" });
    }
  });

  router.get("/api/purchase-orders/check-existence", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { versionId } = req.query;
      if (!versionId) return res.status(400).json({ message: "Version ID is required" });
      const result = await query("SELECT id FROM purchase_orders WHERE version_id = $1 LIMIT 1", [versionId]);
      res.json({ exists: result.rowCount > 0 });
    } catch (err) {
      console.error("GET /api/purchase-orders/check-existence error", err);
      res.status(500).json({ message: "Failed to check PO existence" });
    }
  });

  router.post(
    "/api/purchase-orders/generate",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const { projectId, versionId, versionNumber } = req.body;
        if (!projectId || !versionId) {
          return res
            .status(400)
            .json({ message: "Project ID and Version ID are required" });
        }

        // 1. Get BOM items for this version
        const itemsResult = await query(
          "SELECT * FROM boq_items WHERE project_id = $1 AND version_id = $2",
          [projectId, versionId],
        );

        if (itemsResult.rowCount === 0) {
          return res.status(404).json({ message: "No items found for this BOM version" });
        }

        // 2. Extract lines from each item's table_data and group by vendor (shop_id)
        const vendorGroups: Record<string, any[]> = {};

        // Helper: flatten all material lines including those nested inside consolidated products
        const flattenItems = (items: any[]): any[] => {
          const result: any[] = [];
          for (const item of items) {
            // If this item has nested step11_items (consolidated product), drill in
            if (Array.isArray(item.step11_items) && item.step11_items.length > 0) {
              result.push(...flattenItems(item.step11_items));
            } else {
              result.push(item);
            }
          }
          return result;
        }

        for (const boqItem of itemsResult.rows) {
          const tableData = parseSafeTableData(boqItem.table_data);

          let lines: any[] = [];

          if (tableData.materialLines && tableData.targetRequiredQty !== undefined) {
            // Engine-based product: must scale quantities
            const base = Number(tableData.baseRequiredQty || tableData.configBasis?.baseRequiredQty || 1);
            const target = Number(tableData.targetRequiredQty) || 0;

            // 1. Process engine lines (materialLines)
            if (Array.isArray(tableData.materialLines)) {
              const engineLines = tableData.materialLines.map((l: any) => {
                const baseQty = Number(l.baseQty || l.qty || 0);
                const applyR = l.apply_rounding !== undefined ? Boolean(l.apply_rounding) : (l.applyRounding !== undefined ? Boolean(l.applyRounding) : true);
                
                // Excel/BOQ Logic: Round up at basis, then scale, then round off for PO
                // Per instructions, exclude wastage for PO (use baseQty directly)
                const roundedQtyAtBasis = applyR ? Math.ceil(baseQty) : baseQty;
                const computedPerUnitQty = base > 0 ? roundedQtyAtBasis / base : 0;
                // Use l.perUnitQty if it exists (allows respecting edits from Generate PO / BOM Edit screen)
                const perUnitQty = l.perUnitQty !== undefined ? Number(l.perUnitQty) : computedPerUnitQty;
                
                const scaledQty = Number((perUnitQty * target).toFixed(2));
                const roundOffQty = applyR ? Math.ceil(scaledQty) : scaledQty;

                const sRate = Number(l.supply_rate || l.supplyRate || 0);
                const iRate = Number(l.install_rate || l.installRate || 0);
                const rate = sRate + iRate;
                const amount = Number((roundOffQty * rate).toFixed(2));

                return {
                  ...l,
                  qty: roundOffQty,
                  rate: rate,
                  amount: Number((roundOffQty * rate).toFixed(2)),
                  item: l.name || l.material_name || "Unknown Item"
                };
              });
              lines.push(...engineLines);
            }

            // 2. Process manual items in engine-based product (if any)
            if (Array.isArray(tableData.step11_items)) {
              const manualLines = tableData.step11_items.filter((it: any) => it.manual).map((it: any) => {
                const qty = Number(it.qty || 0);
                const sRate = Number(it.supply_rate || it.supplyRate || 0);
                const iRate = Number(it.install_rate || it.installRate || 0);
                const rate = sRate + iRate;
                const amount = qty * rate;
                return {
                  ...it,
                  qty,
                  rate,
                  amount: Number((qty * rate).toFixed(2)),
                  item: it.title || it.name || "Unknown Item"
                };
              });
              lines.push(...manualLines);
            }
          } else {
            // Non-engine product: use step11_items, materialLines or rows directly
            if (Array.isArray(tableData.step11_items)) {
              lines = flattenItems(tableData.step11_items);
            } else if (Array.isArray(tableData.materialLines)) {
              lines = flattenItems(tableData.materialLines);
            } else if (Array.isArray(tableData.rows)) {
              lines = flattenItems(tableData.rows);
            } else if (Array.isArray(tableData.items)) {
              lines = flattenItems(tableData.items);
            }
          }

          for (const line of lines) {
            const vendorName = (line.shop_name || line.shopName || "unassigned").trim();
            if (!vendorGroups[vendorName]) {
              vendorGroups[vendorName] = [];
            }
            vendorGroups[vendorName].push({
              ...line,
              boq_item_id: boqItem.id,
              hsn_code: line.hsn_code || tableData.hsn_sac_code || tableData.hsn_code || null,
              sac_code: line.sac_code || tableData.sac_code || null
            });
          }
        }


        const generatedPos = [];

        // 3. For each vendor group, create a PO
        for (const [vendorName, items] of Object.entries(vendorGroups)) {
          if (vendorName === "unassigned") continue;

          const poNumber = `Anx-${Math.floor(1000 + Math.random() * 9000)}-${Date.now().toString().slice(-4)}`;
          let totalAmount = 0;

          // Look up vendor's UUID by name
          const shopLookup = await query(
            `SELECT id FROM shops WHERE TRIM(name) = $1 LIMIT 1`,
            [vendorName]
          );
          const vendorId = shopLookup.rows.length > 0 ? shopLookup.rows[0].id : vendorName;

          // Create the PO first to get an ID
          const poResult = await query(
            `INSERT INTO purchase_orders (po_number, project_id, vendor_id, vendor_name, status, total, version_id, version_number) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [poNumber, projectId, vendorId, vendorName, "draft", 0, versionId, versionNumber || null],
          );


          const poId = poResult.rows[0].id;

          // Insert items
          for (const item of items) {
            const qty = parseFloat(item.qty || item.quantity || 0) || 0;
            const supplyRate = parseFloat(item.supply_rate || item.supplyRate || item.rate || 0) || 0;
            const installRate = parseFloat(item.install_rate || item.installRate || 0) || 0;
            const rate = supplyRate + installRate;
            const amount = Number((parseFloat(item.amount || 0) || (qty * rate) || 0).toFixed(2));
            totalAmount += amount;

            await query(
              `INSERT INTO purchase_order_items (po_id, material_id, item, description, unit, qty, original_qty, rate, amount, hsn_code, sac_code, qty_modified) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                poId,
                item.material_id || item.materialId || item.id || null,
                item.item || item.material_name || item.title || item.name || "Unknown Item",
                item.description || item.location || null,
                item.unit || null,
                qty,
                qty, // original_qty starts same as qty
                rate,
                amount,
                item.hsn_code || item.hsn_sac_code || null,
                item.sac_code || null,
                false // qty_modified starts false
              ],
            );
          }

          // Update PO with total amount
          await query("UPDATE purchase_orders SET total = $1 WHERE id = $2", [
            totalAmount,
            poId,
          ]);

          generatedPos.push({ id: poId, poNumber, vendorId, totalAmount });
        }

        res.json({
          message: "Purchase orders generated successfully",
          generatedCount: generatedPos.length,
          orders: generatedPos,
        });
      } catch (err) {
        console.error("POST /api/purchase-orders/generate error", err);
        res.status(500).json({ message: "Failed to generate POs" });
      }
    },
  );

  router.post("/api/po-requests", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { projectId, projectName, employeeId, department, items } = req.body;
      const user = (req as any).user;

      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      if (!projectId || !projectName || !items || !items.length) {
        return res.status(400).json({ message: "Missing required fields or items" });
      }

      // Insert PO Request
      const poReqResult = await query(
        `INSERT INTO po_requests 
         (project_id, project_name, requester_id, requester_name, employee_id, department, status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_approval') RETURNING *`,
        [projectId, projectName, user.id, user.fullName || user.username, employeeId || user.employeeCode, department || user.department]
      );

      const poRequest = poReqResult.rows[0];

      // Insert Items
      for (const item of items) {
        await query(
          `INSERT INTO po_request_items 
           (po_request_id, material_id, item, category, subcategory, unit, qty, rate, remarks) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [poRequest.id, item.material_id || item.id || null, item.item, item.category, item.subcategory, item.unit, item.qty, item.rate || null, item.remarks]
        );
      }

      res.status(201).json({ message: "PO Request raised successfully", poRequest });
    } catch (err) {
      console.error("POST /api/po-requests error", err);
      res.status(500).json({ message: "Failed to raise PO Request" });
    }
  });

  router.get("/api/po-requests", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { status, view } = req.query;
      const user = (req as any).user;

      let queryStr = `SELECT * FROM po_requests WHERE 1=1`;
      const params: any[] = [];

      if (view === 'my') {
        params.push(user.id);
        queryStr += ` AND requester_id = $${params.length}`;
      }

      if (status) {
        params.push(status);
        queryStr += ` AND status = $${params.length}`;
      }

      if (user.role === 'admin' || user.role === 'software_team' || user.role === 'purchase_team') {
        // Admins, software team and purchase team see all requests
      } else if (view !== 'my') {
        params.push(user.id);
        queryStr += ` AND project_id IN (SELECT project_id FROM user_project_permissions WHERE user_id = $${params.length})`;
      }

      queryStr += ` ORDER BY created_at DESC`;

      const result = await query(queryStr, params);

      // For each request, optionally fetch item count
      const requests = result.rows;

      res.json({ poRequests: requests });
    } catch (err) {
      console.error("GET /api/po-requests error:", err);
      res.status(500).json({ message: "Failed to load PO Requests" });
    }
  });

  router.get("/api/po-requests/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const reqResult = await query(`SELECT * FROM po_requests WHERE id::text = $1`, [id]);
      if (reqResult.rows.length === 0) {
        return res.status(404).json({ message: "PO Request not found" });
      }

      const itemsResult = await query(
        `SELECT i.*, i.original_qty, m.hsn_code, m.sac_code, m.shop_id, s.name as shop_name, s.location as shop_location, s.gstNo as shop_gstin
         FROM po_request_items i
         LEFT JOIN materials m ON i.material_id::text = m.id::text
         LEFT JOIN shops s ON m.shop_id::text = s.id::text
         WHERE i.po_request_id::text = $1 
         ORDER BY i.created_at ASC`,
        [id]
      );

      res.json({
        poRequest: reqResult.rows[0],
        items: itemsResult.rows
      });
    } catch (err) {
      console.error(`[GET /api/po-requests/:id] Error for ID ${req.params.id}:`, err);
      res.status(500).json({ message: "Failed to load PO Request details" });
    }
  });

  router.put("/api/po-requests/:id/items", authMiddleware, requireRole('admin', 'purchase_team'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { items, deliver_to, payment_terms, terms_conditions } = req.body;

      if (items && Array.isArray(items)) {
        // Update each item
        for (const item of items) {
          await query(
            `UPDATE po_request_items SET qty = $1, remarks = $2, rate = $3, updated_at = NOW() WHERE id = $4 AND po_request_id = $5`,
            [item.qty, item.remarks || null, item.rate || null, item.id, id]
          );
        }
      }

      // Update the request with main fields
      await query(
        `UPDATE po_requests 
         SET deliver_to = COALESCE($1, deliver_to), 
             payment_terms = COALESCE($2, payment_terms), 
             terms_conditions = COALESCE($3, terms_conditions),
             updated_at = NOW() 
         WHERE id = $4`,
        [deliver_to, payment_terms, terms_conditions, id]
      );

      res.json({ message: "PO Request updated successfully" });
    } catch (err) {
      console.error("PUT /api/po-requests/:id/items error:", err);
      res.status(500).json({ message: "Failed to update PO Request items" });
    }
  });

  router.patch("/api/po-requests/:id/status", authMiddleware, requireRole('admin', 'software_team', 'purchase_team'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'approved' or 'rejected'

      if (!status) {
        return res.status(400).json({ message: "Status is required" });
      }

      const result = await query(
        `UPDATE po_requests SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "PO Request not found" });
      }

      res.json({ message: `PO Request ${status}`, poRequest: result.rows[0] });
    } catch (err) {
      console.error("PATCH /api/po-requests/:id/status error:", err);
      res.status(500).json({ message: "Failed to update PO Request status" });
    }
  });

  router.post("/api/po-requests/:id/generate-po", authMiddleware, requireRole('admin', 'purchase_team'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { vendorId, vendorName, itemsWithRates } = req.body;
      const user = (req as any).user;

      // 1. Validate PO Request
      const reqResult = await query(`SELECT * FROM po_requests WHERE id = $1`, [id]);
      if (reqResult.rows.length === 0) {
        return res.status(404).json({ message: "PO Request not found" });
      }
      const poReq = reqResult.rows[0];

      if (poReq.status !== 'approved') {
        return res.status(400).json({ message: "Only approved PO requests can generate POs" });
      }

      if (!vendorId) {
        return res.status(400).json({ message: "Vendor ID is required" });
      }

      // 2. Generate PO Number
      const poCountRes = await query(`SELECT COUNT(*) FROM purchase_orders`);
      const poNumStr = String(parseInt(poCountRes.rows[0].count) + 1).padStart(3, "0");
      const generatedPoNumber = `Anx-${new Date().getFullYear()}-${poNumStr}`;

      // 3. Calculate Totals based on matching selected rates
      let subtotal = 0;
      const finalItems = [];

      for (const item of itemsWithRates) { // Expecting { poRequestItemId, rate, qty }
        const itemRes = await query(`SELECT * FROM po_request_items WHERE id = $1 AND po_request_id = $2`, [item.poRequestItemId, id]);
        if (itemRes.rows.length > 0) {
          const dbItem = itemRes.rows[0];
          const qty = item.qty || dbItem.qty;
          const rate = item.rate || 0;
          const amount = qty * rate;
          subtotal += amount;

          finalItems.push({
            material_id: dbItem.material_id, // Ensure material_id is carried forward
            item: dbItem.item,
            description: dbItem.remarks || '',
            unit: dbItem.unit,
            qty: qty,
            rate: rate,
            amount: amount
          });
        }
      }

      // 4. Create PO (Draft initially or Generated directly?)
      const poCreateRes = await query(
        `INSERT INTO purchase_orders 
         (po_number, project_id, project_name, vendor_id, vendor_name, subtotal, tax, total, status, requested_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [generatedPoNumber, poReq.project_id, poReq.project_name, vendorId, vendorName || vendorId, subtotal, 0, subtotal, 'draft', poReq.requester_name]
      );
      const newPo = poCreateRes.rows[0];

      // 5. Create PO Items
      for (const fItem of finalItems) {
        await query(
          `INSERT INTO purchase_order_items 
           (po_id, material_id, item, description, unit, qty, original_qty, rate, amount, qty_modified) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [newPo.id, fItem.material_id, fItem.item, fItem.description, fItem.unit, fItem.qty, fItem.qty, fItem.rate, fItem.amount, false]
        );
      }

      // 6. Update PO Request Status
      await query(`UPDATE po_requests SET status = 'po_generated', updated_at = NOW() WHERE id = $1`, [id]);

      res.status(201).json({ message: "Purchase Order generated successfully", po: newPo });
    } catch (err) {
      console.error("POST /api/po-requests/:id/generate-po error:", err);
      res.status(500).json({ message: "Failed to generate PO from request" });
    }
  });

  router.post("/api/purchase-orders/:id/revise", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { items, reason, deletedItems, delivery_date, shippingAddress, paymentTerms, vendor_id, vendor_name } = req.body;
      const user = (req as any).user;

      // 1. Get existing PO
      const poRes = await query(`SELECT * FROM purchase_orders WHERE id = $1`, [id]);
      if (poRes.rows.length === 0) {
        return res.status(404).json({ message: "Purchase Order not found" });
      }
      const existingPo = poRes.rows[0];

      // 2. Generate new PO Number (-R1, -R2, etc)
      let revCount = 1;
      let defCount = 1;
      let originalPoNumber = existingPo.po_number;
      let basePoNumber = originalPoNumber;

      const revMatch = basePoNumber.match(/-R(\d+)$/);
      if (revMatch) {
        revCount = parseInt(revMatch[1], 10) + 1;
        basePoNumber = basePoNumber.replace(/-R\d+$/, "");
      }
      const newPoNumber = `${basePoNumber}-R${revCount}`;

      // Look up existing deferred POs for numbering
      const defRes = await query(`SELECT boq_number FROM (SELECT po_number as boq_number FROM purchase_orders WHERE po_number LIKE $1) as tmp ORDER BY boq_number DESC LIMIT 1`, [`${basePoNumber}-Deferred%`]);
      if (defRes.rows.length > 0) {
        const dMatch = defRes.rows[0].boq_number.match(/-Deferred(\d+)$/);
        if (dMatch) defCount = parseInt(dMatch[1], 10) + 1;
      }


      // 3. Determine new status
      let hasIncrease = false;
      const existingItemsRes = await query(`SELECT * FROM purchase_order_items WHERE po_id = $1`, [id]);
      const existingItems = existingItemsRes.rows;

      for (const item of items) {
        const original = existingItems.find((i: any) => i.id === item.id);
        if (original && parseFloat(item.qty) > parseFloat(original.qty)) {
          hasIncrease = true;
          break;
        }
      }

      const newStatus = "draft";

      // Auto-generate Change Summary
      let changeSummary = "Change Log:\n";
      for (const item of items) {
        const original = existingItems.find((i: any) =>
          (i.item || i.item_name) === (item.item || item.item_name) && i.description === item.description
        );
        if (original) {
          const oldQty = parseFloat(original.qty);
          const newQty = parseFloat(item.qty);
          if (oldQty !== newQty) {
            changeSummary += `- ${item.item || item.item_name}: Qty changed from ${oldQty} to ${newQty}\n`;
          }
        } else {
          changeSummary += `- Added new item: ${item.item || item.item_name} (Qty: ${item.qty})\n`;
        }
      }

      if (deletedItems && deletedItems.length > 0) {
        for (const ditem of deletedItems) {
          changeSummary += `- Removed item: ${ditem.item || ditem.item_name} (Qty: ${ditem.qty}) -> Moved to Deferred PO\n`;
        }
      }

      const finalComments = `${reason ? reason + "\n\n" : ""}${changeSummary}`;
      const approvalComments = hasIncrease ? finalComments : (reason ? finalComments : existingPo.approval_comments);

      // Calculate new total
      let totalAmount = 0;
      for (const item of items) {
        totalAmount += parseFloat(item.amount) || (parseFloat(item.qty) * parseFloat(item.rate)) || 0;
      }

      const finalVendorId = vendor_id || existingPo.vendor_id;
      const finalVendorName = vendor_name || existingPo.vendor_name;

      console.log(`[revise-po] Attempting revision for PO ${id}. New PO Number: ${newPoNumber}. Vendor: ${finalVendorName}`);

      // 4. Create new PO
      const newPoRes = await query(
        `INSERT INTO purchase_orders (po_number, project_id, project_name, vendor_id, vendor_name, subtotal, total, status, requested_by, approval_comments, delivery_date, shipping_address, payment_terms) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [newPoNumber, existingPo.project_id, existingPo.project_name, finalVendorId, finalVendorName, totalAmount, totalAmount, newStatus, existingPo.requested_by, approvalComments, delivery_date || null, shippingAddress || null, paymentTerms || null]
      );
      const newPo = newPoRes.rows[0];
      console.log(`[revise-po] New PO created with ID: ${newPo.id}`);

      // 5. Insert new items
      for (const item of items) {
        // Find if this item existed in the previous PO
        const originalItem = existingItems.find((ei: any) =>
          (ei.id === item.id) ||
          (ei.material_id && ei.material_id === item.material_id) ||
          ((ei.item || ei.item_name) === (item.item || item.item_name) && ei.description === item.description)
        );

        let originalQty = parseFloat(item.qty);
        let qtyModified = false;

        if (originalItem) {
          // Carry forward the FIRST original_qty recorded in the chain
          originalQty = parseFloat(originalItem.original_qty || originalItem.qty);
          // qty_modified is true if current qty differs from original_qty
          qtyModified = parseFloat(item.qty) !== originalQty;
        }

        await query(
          `INSERT INTO purchase_order_items (po_id, material_id, item, description, unit, qty, original_qty, rate, amount, hsn_code, sac_code, qty_modified) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [newPo.id, item.material_id || item.id || null, item.item || item.item_name, item.description || null, item.unit || null, item.qty, originalQty, item.rate, item.amount, item.hsn_code || null, item.sac_code || null, qtyModified]
        );
      }

      // 5.5 Handle deleted items (Defer them)
      if (deletedItems && deletedItems.length > 0) {
        const deferredPoNumber = `${basePoNumber}-Deferred${defCount}`;
        let deferredTotal = 0;
        for (const ditem of deletedItems) {
          deferredTotal += parseFloat(ditem.amount) || (parseFloat(ditem.qty || 0) * parseFloat(ditem.rate || 0)) || 0;
        }

        const defPoRes = await query(
          `INSERT INTO purchase_orders (po_number, project_id, project_name, vendor_id, vendor_name, subtotal, total, status, requested_by, approval_comments) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [deferredPoNumber, existingPo.project_id, existingPo.project_name, finalVendorId, finalVendorName, deferredTotal, deferredTotal, "draft", existingPo.requested_by, "Items deferred due to budget constraints during revision."]
        );
        const defPo = defPoRes.rows[0];

        for (const ditem of deletedItems) {
          const originalItem = existingItems.find((ei: any) => ei.id === ditem.id);
          const originalQty = originalItem ? parseFloat(originalItem.original_qty || originalItem.qty) : parseFloat(ditem.qty);
          const qtyModified = originalItem ? (parseFloat(ditem.qty) !== originalQty) : false;

          await query(
            `INSERT INTO purchase_order_items (po_id, material_id, item, description, unit, qty, original_qty, rate, amount, hsn_code, sac_code, qty_modified) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [defPo.id, ditem.material_id || ditem.id || null, ditem.item || ditem.item_name, ditem.description || null, ditem.unit || null, ditem.qty, originalQty, ditem.rate, ditem.amount, ditem.hsn_code || null, ditem.sac_code || null, qtyModified]
          );
        }
      }

      // 6. Update old PO status
      await query(`UPDATE purchase_orders SET status = 'revised', updated_at = NOW() WHERE id = $1`, [id]);

      res.status(201).json({ message: "PO Revised successfully", newPo });
    } catch (err) {
      console.error("POST /api/purchase-orders/:id/revise error:", err);
      res.status(500).json({ message: "Failed to revise PO" });
    }
  });

  router.get("/api/purchase-orders", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { status } = req.query;
      const user = (req as any).user;
      let queryStr = `
        SELECT po.*, po.total as total_amount, p.name as project_name,
        COALESCE(po.vendor_name, s.name, po.vendor_id) as vendor_name,
        COALESCE(po.version_number, (
          SELECT CAST(v.version_number AS TEXT)
          FROM boq_versions v
          WHERE v.project_id = po.project_id AND v.created_at <= po.created_at
          ORDER BY v.created_at DESC
          LIMIT 1
        )) as version_number
        FROM purchase_orders po
        LEFT JOIN boq_projects p ON po.project_id = p.id
        LEFT JOIN shops s ON(po.vendor_id:: text = s.id:: text OR TRIM(s.name) = TRIM(po.vendor_name))
        `;
      const params: any[] = [];
      const whereConditions: string[] = [];

      if (status) {
        whereConditions.push(`po.status = $${params.length + 1}`);
        params.push(status);
      }

      if (user.role !== 'admin' && user.role !== 'software_team' && user.role !== 'purchase_team') {
        whereConditions.push(`po.project_id IN (SELECT project_id FROM user_project_permissions WHERE user_id = $${params.length + 1})`);
        params.push(user.id);
      }

      if (whereConditions.length > 0) {
        queryStr += ` WHERE ` + whereConditions.join(" AND ");
      }

      queryStr += ` ORDER BY po.created_at DESC`;

      const result = await query(queryStr, params);
      res.json({ purchaseOrders: result.rows });
    } catch (err) {
      console.error("GET /api/purchase-orders error:", err);
      res.status(500).json({ message: "Failed to load purchase orders" });
    }
  });

  router.get("/api/purchase-orders/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Fetch the PO header with detailed shop information
      const poResult = await query(
        `SELECT po.*, po.total as total_amount,
        p.name as project_name, p.client as project_client, p.location as project_location,
        COALESCE(po.vendor_name, s.name, po.vendor_id) as vendor_name,
        COALESCE(po.version_number, (
          SELECT CAST(v.version_number AS TEXT)
          FROM boq_versions v
          WHERE v.project_id = po.project_id AND v.created_at <= po.created_at
          ORDER BY v.created_at DESC
          LIMIT 1
        )) as version_number,
        COALESCE(po.version_id, (
          SELECT CAST(v.id AS TEXT)
          FROM boq_versions v
          WHERE v.project_id = po.project_id AND v.created_at <= po.created_at
          ORDER BY v.created_at DESC
          LIMIT 1
        )) as version_id,
        s.location as vendor_location, s.new_location as vendor_new_location, s.city as vendor_city,
        s.state as vendor_state, s.pincode as vendor_pincode, s.gstno as vendor_gstin,
        s.contactnumber as vendor_phone, s.phonecountrycode as vendor_phone_code,
        s.terms_and_conditions as vendor_terms
         FROM purchase_orders po
         LEFT JOIN boq_projects p ON po.project_id = p.id
         LEFT JOIN shops s ON(po.vendor_id:: text = s.id:: text OR TRIM(s.name) = TRIM(po.vendor_name))
         WHERE po.id = $1`,
        [id]
      );

      if (poResult.rows.length === 0) {
        res.status(404).json({ message: "Purchase order not found" });
        return;
      }

      // Fetch the PO items
      const itemsResult = await query(
        `SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY created_at ASC`,
        [id]
      );

      // Fetch Related PO Versions
      const currentPo = poResult.rows[0];
      let fullPoNumber = currentPo.po_number;
      let basePoNumber = fullPoNumber.split('-R')[0].split('-Deferred')[0].split('-R')[0].trim();

      const relatedPosResult = await query(
        `SELECT id, po_number, status, total, approval_comments, created_at 
         FROM purchase_orders 
         WHERE (TRIM(po_number) ILIKE $1 OR TRIM(po_number) ILIKE $4) 
           AND id::text != $2::text
           AND project_id = $3
         ORDER BY created_at DESC`,
        [`${basePoNumber}%`, id, currentPo.project_id, `%${basePoNumber}%`]
      );

      console.log(`[debug-related-po] Base: ${basePoNumber}, Current: ${fullPoNumber}, Project: ${currentPo.project_id}, Found: ${relatedPosResult.rows.length}`);

      // Fetch Parent PO Items for Change Tracking
      let parentItems: any[] = [];
      const revMatch = fullPoNumber.match(/-R(\d+)$/);
      if (revMatch) {
        const revNum = parseInt(revMatch[1], 10);
        let parentNumber = revNum === 1
          ? fullPoNumber.replace(/-R\d+$/, "")
          : fullPoNumber.replace(/-R\d+$/, `-R${revNum - 1}`);

        const parentRes = await query(
          `SELECT id FROM purchase_orders WHERE po_number = $1 AND project_id = $2 LIMIT 1`,
          [parentNumber, currentPo.project_id]
        );

        if (parentRes.rows.length > 0) {
          const pItemsResult = await query(
            `SELECT * FROM purchase_order_items WHERE po_id = $1`,
            [parentRes.rows[0].id]
          );
          parentItems = pItemsResult.rows;
        }
      }

      // Fetch BOM Items for original quantity reference
      let bomItems: any[] = [];
      if (currentPo.version_id) {
        const bomResult = await query(
          `SELECT * FROM boq_items WHERE version_id = $1`,
          [currentPo.version_id]
        );
        
        for (const boqItem of bomResult.rows) {
          const tableData = typeof boqItem.table_data === 'string' ? JSON.parse(boqItem.table_data) : boqItem.table_data;
          
          if (tableData.materialLines && tableData.targetRequiredQty !== undefined) {
             const base = Number(tableData.baseRequiredQty || tableData.configBasis?.baseRequiredQty || 1);
             const target = Number(tableData.targetRequiredQty) || 0;
             
             if (Array.isArray(tableData.materialLines)) {
               tableData.materialLines.forEach((l: any) => {
                 const baseQty = Number(l.baseQty || l.qty || 0);
                 const applyR = l.apply_rounding !== undefined ? Boolean(l.apply_rounding) : true;
                 const roundedQtyAtBasis = applyR ? Math.ceil(baseQty) : baseQty;
                 const perUnitQty = l.perUnitQty !== undefined ? Number(l.perUnitQty) : (base > 0 ? roundedQtyAtBasis / base : 0);
                 const theoreticalQty = perUnitQty * target;
                 
                 const itemName = l.name || l.material_name;
                 const desc = l.description || "";
                 const existing = bomItems.find(i => i.item === itemName && i.description === desc);
                 if (existing) {
                   existing.qty += theoreticalQty;
                 } else {
                   bomItems.push({
                     item: itemName,
                     description: desc,
                     qty: theoreticalQty,
                     unit: l.unit
                   });
                 }
               });
             }
             
             if (Array.isArray(tableData.step11_items)) {
               tableData.step11_items.filter((it: any) => it.manual).forEach((it: any) => {
                 const itemName = it.item || it.title;
                 const desc = it.description || "";
                 const qty = Number(it.qty || 0);
                 
                 const existing = bomItems.find(i => i.item === itemName && i.description === desc);
                 if (existing) {
                   existing.qty += qty;
                 } else {
                   bomItems.push({
                     item: itemName,
                     description: desc,
                     qty: qty,
                     unit: it.unit
                   });
                 }
               });
             }
          }
        }
      }

      res.json({
        purchaseOrder: currentPo,
        items: itemsResult.rows,
        relatedPos: relatedPosResult.rows,
        parentItems: parentItems,
        bomItems: bomItems
      });
    } catch (err) {
      console.error("GET /api/purchase-orders/:id error:", err);
      res.status(500).json({ message: "Failed to load purchase order details" });
    }
  });

  router.patch("/api/purchase-orders/:id/status", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status, delivery_date, dc_number, dc_date } = req.body;

      const setFields: string[] = [];
      const params: any[] = [];
      let paramCount = 1;

      if (status !== undefined) {
        setFields.push(`status = $${paramCount++}`);
        params.push(status);
      }
      if (delivery_date !== undefined) {
        setFields.push(`delivery_date = $${paramCount++}`);
        params.push(delivery_date || null);
      }
      if (dc_number !== undefined) {
        setFields.push(`dc_number = $${paramCount++}`);
        params.push(dc_number || null);
      }
      if (dc_date !== undefined) {
        setFields.push(`dc_date = $${paramCount++}`);
        params.push(dc_date || null);
      }

      if (setFields.length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }

      params.push(id);
      const result = await query(
        `UPDATE purchase_orders SET ${setFields.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING * `,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ message: "Purchase order not found" });
        return;
      }

      res.json({ purchaseOrder: result.rows[0] });
    } catch (err) {
      console.error("PATCH /api/purchase-orders/:id/status error:", err);
      res.status(500).json({ message: "Failed to update purchase order status" });
    }
  });

  router.post("/api/purchase-orders/:id/approve", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { approve, comment } = req.body;

      const status = approve ? 'approved' : 'rejected';

      const result = await query(
        `UPDATE purchase_orders 
         SET status = $1, approval_comments = $2, updated_at = NOW() 
         WHERE id = $3 RETURNING * `,
        [status, comment || null, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ message: "Purchase order not found" });
        return;
      }

      res.json({ message: `Purchase order ${status} successfully`, purchaseOrder: result.rows[0] });
    } catch (err) {
      console.error("POST /api/purchase-orders/:id/approve error:", err);
      res.status(500).json({ message: "Failed to process purchase order approval" });
    }
  });

  router.delete("/api/purchase-orders/:id", authMiddleware, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      await query("BEGIN");
      try {
        // Remove child items first
        await query("DELETE FROM purchase_order_items WHERE po_id = $1", [id]);
        const result = await query("DELETE FROM purchase_orders WHERE id = $1 RETURNING id", [id]);
        if (result.rows.length === 0) {
          await query("ROLLBACK");
          res.status(404).json({ message: "Purchase order not found" });
          return;
        }
        await query("COMMIT");
        res.json({ message: "Purchase order deleted successfully" });
      } catch (err) {
        await query("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("DELETE /api/purchase-orders/:id error:", err);
      res.status(500).json({ message: "Failed to delete purchase order" });
    }
  });

  router.get("/api/purchase-orders/check-material-increases", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { materialIds } = req.query;
      if (!materialIds || typeof materialIds !== 'string') {
        return res.status(400).json({ message: "materialIds query parameter is required" });
      }

      const ids = materialIds.split(',').filter(id => id.trim());
      if (ids.length === 0) return res.json({ increases: {} });

      // Query for the latest approved PO item for each material
      // We exclude 'Deferred' POs as they are usually budget-split, not increases
      const result = await query(
        `SELECT DISTINCT ON (material_id) 
           material_id, qty, original_qty, po_id, p.po_number, p.updated_at
         FROM purchase_order_items poi
         JOIN purchase_orders p ON poi.po_id = p.id
         WHERE material_id = ANY($1) 
           AND p.status = 'approved'
           AND poi.qty_modified = true
           AND (poi.is_synced = false OR poi.is_synced IS NULL)
           AND p.po_number NOT LIKE '%Deferred%'
         ORDER BY material_id, p.updated_at DESC`,
        [ids]
      );

      const increases: Record<string, any> = {};
      result.rows.forEach((row: any) => {
        increases[row.material_id] = {
          qty: parseFloat(row.qty),
          originalQty: parseFloat(row.original_qty || row.qty),
          poNumber: row.po_number,
          poId: row.po_id,
          updatedAt: row.updated_at
        };
      });

      res.json({ increases });
    } catch (err) {
      console.error("GET /api/purchase-orders/check-material-increases error:", err);
      res.status(500).json({ message: "Failed to check material increases" });
    }
  });

export default router;
