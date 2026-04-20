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

  router.get("/api/site-reports", authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await query("SELECT * FROM site_reports ORDER BY report_date DESC");
      res.json({ reports: result.rows });
    } catch (err) {
      console.error("GET /api/site-reports error:", err);
      res.status(500).json({ message: "Failed to fetch site reports" });
    }
  });

  router.post("/api/site-reports", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { project_id, project_name, report_date, summary, tasks } = req.body;
      const userId = (req as any).user?.id;

      await query("BEGIN");

      const reportResult = await query(
        `INSERT INTO site_reports (project_id, project_name, user_id, report_date, summary, status)
         VALUES ($1, $2, $3, $4, $5, 'draft')
         RETURNING *`,
        [project_id, project_name, userId, report_date || new Date(), summary]
      );
      const report = reportResult.rows[0];

      if (tasks && Array.isArray(tasks)) {
        for (const task of tasks) {
          const taskRes = await query(
            `INSERT INTO site_report_tasks (site_report_id, item_type, item_id, item_name, task_description, completion_percentage, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [report.id, task.item_type || 'item', task.item_id, task.item_name, task.task_description, task.completion_percentage || 0, task.status || 'In Progress']
          );
          const taskId = taskRes.rows[0].id;

          if (task.labour && Array.isArray(task.labour)) {
            for (const l of task.labour) {
              await query(
                `INSERT INTO site_report_labours (task_id, labour_name, count, in_time, out_time)
                 VALUES ($1, $2, $3, $4, $5)`,
                [taskId, l.labour_name, l.count || 1, l.in_time, l.out_time]
              );
            }
          }

          if (task.issues && Array.isArray(task.issues)) {
            for (const issue of task.issues) {
              await query(
                `INSERT INTO site_report_issues (task_id, description)
                 VALUES ($1, $2)`,
                [taskId, issue.description]
              );
            }
          }

          if (task.materials && Array.isArray(task.materials)) {
            for (const mat of task.materials) {
              await query(
                `INSERT INTO site_report_materials (task_id, material_name, quantity, unit)
                 VALUES ($1, $2, $3, $4)`,
                [taskId, mat.material_name || '', mat.quantity || 1, mat.unit || '']
              );
            }
          }

          if (task.media && Array.isArray(task.media)) {
            for (const m of task.media) {
              const fileUrl = m.file_url || m.url || m.fileUrl;
              const fileType = m.file_type || m.type || 'image/jpeg';
              const fileName = m.file_name || m.name || 'image';

              if (fileUrl) {
                await query(
                  `INSERT INTO site_report_media (task_id, file_url, file_type, file_name)
                   VALUES ($1, $2, $3, $4)`,
                  [taskId, fileUrl, fileType, fileName]
                );
              }
            }
          }
        }
      }

      await query("COMMIT");
      res.status(201).json({ report });
    } catch (err) {
      await query("ROLLBACK");
      console.error("POST /api/site-reports error:", err);
      res.status(500).json({ message: "Failed to create site report" });
    }
  });

  router.get("/api/site-reports/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      console.log(`[DEBUG] Fetching report details for ID: ${id}`);

      const reportRes = await query("SELECT * FROM site_reports WHERE id = $1", [id]);
      if (reportRes.rows.length === 0) {
        console.log(`[DEBUG] Report ${id} not found`);
        return res.status(404).json({ message: "Report not found" });
      }
      const report = reportRes.rows[0];

      const tasksRes = await query("SELECT * FROM site_report_tasks WHERE site_report_id = $1", [id]);
      const tasks = tasksRes.rows.map((t: any) => ({
        ...t,
        itemName: t.item_name,
        taskDescription: t.task_description,
        completionPercentage: t.completion_percentage
      }));
      console.log(`[DEBUG] Found ${tasks.length} tasks for report ${id}`);

      for (const task of tasks) {
        const labourRes = await query("SELECT * FROM site_report_labours WHERE task_id = $1", [task.id]);
        task.labour = labourRes.rows.map((l: any) => ({
          ...l,
          labourName: l.labour_name,
          inTime: l.in_time,
          outTime: l.out_time
        }));

        const mediaRes = await query("SELECT * FROM site_report_media WHERE task_id = $1", [task.id]);
        task.media = mediaRes.rows.map((m: any) => ({
          ...m,
          fileUrl: m.file_url,
          fileType: m.file_type,
          fileName: m.file_name
        }));

        const issuesRes = await query("SELECT * FROM site_report_issues WHERE task_id = $1", [task.id]);
        task.issues = issuesRes.rows;

        const materialsRes = await query("SELECT * FROM site_report_materials WHERE task_id = $1", [task.id]);
        task.materials = materialsRes.rows.map((m: any) => ({
          ...m,
          materialName: m.material_name,
        }));

        console.log(`[DEBUG] Task ${task.id} has ${task.labour.length} labour entries, ${task.issues.length} issues, and ${task.materials.length} materials`);
      }

      report.tasks = tasks;
      res.json({ report });
    } catch (err) {
      console.error("GET /api/site-reports/:id error:", err);
      res.status(500).json({ message: "Failed to fetch report details" });
    }
  });

  router.post("/api/site-reports/:id/tasks", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { item_type, item_id, item_name, task_description, completion_percentage, status } = req.body;

      const result = await query(
        `INSERT INTO site_report_tasks (site_report_id, item_type, item_id, item_name, task_description, completion_percentage, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, item_type, item_id, item_name, task_description, completion_percentage || 0, status || 'In Progress']
      );

      res.status(201).json({ task: result.rows[0] });
    } catch (err) {
      console.error("POST /api/site-reports/tasks error:", err);
      res.status(500).json({ message: "Failed to add task to site report" });
    }
  });

  router.post("/api/site-report-tasks/:id/labour", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { labour_name, count, in_time, out_time } = req.body;

      const result = await query(
        `INSERT INTO site_report_labours (task_id, labour_name, count, in_time, out_time)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, labour_name, count || 1, in_time, out_time]
      );

      res.status(201).json({ labour: result.rows[0] });
    } catch (err) {
      console.error("POST /api/site-report-tasks/:id/labour error:", err);
      res.status(500).json({ message: "Failed to add labour entry" });
    }
  });

  router.post("/api/site-report-tasks/:id/media", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { file_url, file_type, file_name } = req.body;

      const result = await query(
        `INSERT INTO site_report_media (task_id, file_url, file_type, file_name)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, file_url, file_type, file_name]
      );

      res.status(201).json({ media: result.rows[0] });
    } catch (err) {
      console.error("POST /api/site-report-tasks/:id/media error:", err);
      res.status(500).json({ message: "Failed to add media entry" });
    }
  });

  router.post("/api/site-report-tasks/:id/issues", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { description } = req.body;

      const result = await query(
        `INSERT INTO site_report_issues (task_id, description)
         VALUES ($1, $2)
         RETURNING *`,
        [id, description]
      );

      res.status(201).json({ issue: result.rows[0] });
    } catch (err) {
      console.error("POST /api/site-report-tasks/:id/issues error:", err);
      res.status(500).json({ message: "Failed to add issue entry" });
    }
  });

  router.get("/api/email-groups", authMiddleware, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      const result = await query("SELECT * FROM email_groups WHERE user_id = $1", [userId]);
      const groups = result.rows;

      for (const group of groups) {
        const membersRes = await query("SELECT * FROM email_group_members WHERE group_id = $1", [group.id]);
        group.members = membersRes.rows;
      }

      res.json({ groups });
    } catch (err) {
      console.error("GET /api/email-groups error:", err);
      res.status(500).json({ message: "Failed to fetch email groups" });
    }
  });

  router.post("/api/email-groups", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { name, members, isClientGroup } = req.body;
      const userId = (req as any).user?.id;

      await query("BEGIN");

      let groupRes;
      try {
        groupRes = await query(
          "INSERT INTO email_groups (name, user_id, is_client_group) VALUES ($1, $2, $3) RETURNING *",
          [name, userId, isClientGroup || false]
        );
      } catch (insertErr: any) {
        // If is_client_group column is not present in old schema, fallback to legacy insert.
        if (insertErr.code === '42703' || /column .* does not exist/i.test(insertErr.message)) {
          groupRes = await query(
            "INSERT INTO email_groups (name, user_id) VALUES ($1, $2) RETURNING *",
            [name, userId]
          );
        } else {
          throw insertErr;
        }
      }
      const group = groupRes.rows[0];

      if (members && Array.isArray(members)) {
        for (const email of members) {
          await query("INSERT INTO email_group_members (group_id, email) VALUES ($1, $2)", [group.id, email]);
        }
      }

      await query("COMMIT");
      res.status(201).json({ group });
    } catch (err) {
      await query("ROLLBACK");
      console.error("POST /api/email-groups error:", err);
      res.status(500).json({ message: "Failed to create email group" });
    }
  });

  router.delete("/api/email-groups/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await query("DELETE FROM email_groups WHERE id = $1", [id]);
      res.json({ message: "Email group deleted" });
    } catch (err) {
      console.error("DELETE /api/email-groups error:", err);
      res.status(500).json({ message: "Failed to delete email group" });
    }
  });

  router.patch("/api/site-reports/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status, summary } = req.body;

      const updateFields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (status !== undefined) {
        updateFields.push(`status = $${paramCount++}`);
        values.push(status);
      }
      if (summary !== undefined) {
        updateFields.push(`summary = $${paramCount++}`);
        values.push(summary);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }

      values.push(id);
      await query(
        `UPDATE site_reports SET ${updateFields.join(", ")}, updated_at = NOW() WHERE id = $${paramCount}`,
        values
      );

      res.json({ message: "Site report updated" });
    } catch (err) {
      console.error("PATCH /api/site-reports/:id error:", err);
      res.status(500).json({ message: "Failed to update site report" });
    }
  });

  router.delete("/api/site-reports/:id", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // All related tasks, labour, etc. will be deleted via ON DELETE CASCADE in schema
      await query("DELETE FROM site_reports WHERE id = $1", [id]);
      res.json({ message: "Site report deleted" });
    } catch (err) {
      console.error("DELETE /api/site-reports/:id error:", err);
      res.status(500).json({ message: "Failed to delete site report" });
    }
  });

  router.post("/api/site-reports/:id/send-email", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { email_group_id, additional_emails, is_client_group } = req.body;

      // Fetch report and tasks (same logic as GET /api/site-reports/:id)
      const reportRes = await query("SELECT * FROM site_reports WHERE id = $1", [id]);
      if (reportRes.rows.length === 0) return res.status(404).json({ message: "Report not found" });
      const report = reportRes.rows[0];

      const tasksRes = await query("SELECT * FROM site_report_tasks WHERE site_report_id = $1", [id]);
      const tasks = tasksRes.rows;

      for (const task of tasks) {
        const labourRes = await query("SELECT * FROM site_report_labours WHERE task_id = $1", [task.id]);
        task.labour = labourRes.rows;
        const mediaRes = await query("SELECT * FROM site_report_media WHERE task_id = $1", [task.id]);
        task.media = mediaRes.rows;
        const issuesRes = await query("SELECT * FROM site_report_issues WHERE task_id = $1", [task.id]);
        task.issues = issuesRes.rows;

        const materialsRes = await query("SELECT * FROM site_report_materials WHERE task_id = $1", [task.id]);
        task.materials = materialsRes.rows;
      }

      // Determine if it's a client group (simplified template)
      let isClientGroup = false;

      // 1. Check if explicitly passed in request body (e.g. for single email to client)
      if (is_client_group === true || is_client_group === 'true') {
        isClientGroup = true;
      }

      // 2. Collect recipient emails from group
      let recipients: string[] = [];
      if (email_group_id) {
        // If not already determined true from body, check the group's setting in DB
        if (!isClientGroup) {
          try {
            const groupRes = await query("SELECT is_client_group FROM email_groups WHERE id = $1", [email_group_id]);
            if (groupRes.rows.length > 0) {
              isClientGroup = !!groupRes.rows[0].is_client_group;
            }
          } catch (groupErr: any) {
            // Fallback for deployments where schema isn't migrated yet.
            if (groupErr.code === '42703' || /column .* does not exist/i.test(groupErr.message)) {
              isClientGroup = false;
            } else {
              throw groupErr;
            }
          }
        }

        const membersRes = await query("SELECT email FROM email_group_members WHERE group_id = $1", [email_group_id]);
        recipients = membersRes.rows.map(r => r.email);
      }
      if (additional_emails && Array.isArray(additional_emails)) {
        recipients = [...new Set([...recipients, ...additional_emails])];
      }

      if (recipients.length === 0) {
        return res.status(400).json({ message: "No recipients specified" });
      }

      // Send email
      console.log("[EMAIL_DEBUG] recipients:", recipients);
      console.log("[EMAIL_DEBUG] is_client_group from body:", is_client_group);
      console.log("[EMAIL_DEBUG] final isClientGroup flag:", isClientGroup);
      console.log("[EMAIL_DEBUG] reportId:", id);

      await sendSiteReportEmail(recipients, report, tasks, isClientGroup);

      // Update report status to submitted if it was draft
      if (report.status === 'draft') {
        await query("UPDATE site_reports SET status = 'submitted', updated_at = NOW() WHERE id = $1", [id]);
      }

      res.json({ message: "Report sent successfully", recipients });
    } catch (err: any) {
      await query("ROLLBACK");
      console.error("POST /api/site-reports/:id/send-email error:", err);
      res.status(500).json({ message: "Failed to send report email", error: err.message || String(err) });
    }
  });

export default router;
