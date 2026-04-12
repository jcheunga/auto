import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ActionLogEntry,
  EventQueueJob,
  QueuedMondayEvent,
  WebhookEventLog,
  WorkItem,
  WorkItemUpdate,
  WorkStatus
} from "./types";

interface WorkItemRow {
  monday_item_id: string;
  board_id: string;
  title: string;
  description: string;
  status: WorkStatus;
  work_branch: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_base_branch: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_pr_head_sha: string | null;
  heroku_app_url: string | null;
  review_app_announced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventQueueRow {
  id: number;
  event_id: string;
  item_id: string;
  payload_json: string;
  status: "pending" | "processing" | "failed";
  attempts: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WebhookEventRow {
  id: number;
  source: string;
  event_id: string | null;
  item_id: string | null;
  event_type: string | null;
  signature_valid: number | null;
  queue_status: "accepted" | "duplicate" | "ignored" | "invalid_signature" | "error";
  http_status: number;
  payload_json: string;
  created_at: string;
}

interface ActionLogRow {
  id: number;
  level: "info" | "warn" | "error";
  action_type: string;
  item_id: string | null;
  event_id: string | null;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export class AppDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const absolute = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getWorkItem(mondayItemId: string): WorkItem | null {
    const stmt = this.db.prepare(`SELECT * FROM work_items WHERE monday_item_id = ?`);
    const row = stmt.get(mondayItemId) as WorkItemRow | undefined;
    if (!row) {
      return null;
    }
    return mapWorkItemRow(row);
  }

  listWorkItems(limit = 100): WorkItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_items ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as WorkItemRow[];

    return rows.map(mapWorkItemRow);
  }

  createWorkItem(input: {
    mondayItemId: string;
    boardId: string;
    title: string;
    description: string;
    status?: WorkStatus;
  }): WorkItem {
    const now = new Date().toISOString();
    const status = input.status ?? "new";
    const stmt = this.db.prepare(
      `INSERT INTO work_items (
        monday_item_id,
        board_id,
        title,
        description,
        status,
        work_branch,
        github_owner,
        github_repo,
        github_base_branch,
        github_pr_number,
        github_pr_url,
        github_pr_head_sha,
        heroku_app_url,
        review_app_announced_at,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    );

    stmt.run(input.mondayItemId, input.boardId, input.title, input.description, status, now, now);

    const inserted = this.getWorkItem(input.mondayItemId);
    if (!inserted) {
      throw new Error(`Failed to create work item ${input.mondayItemId}`);
    }
    return inserted;
  }

  updateWorkItem(mondayItemId: string, update: WorkItemUpdate): WorkItem {
    const assignments: string[] = [];
    const params: unknown[] = [];

    const toColumn = (key: keyof WorkItemUpdate): string => {
      const mapping: Record<keyof WorkItemUpdate, string> = {
        title: "title",
        description: "description",
        status: "status",
        workBranch: "work_branch",
        githubOwner: "github_owner",
        githubRepo: "github_repo",
        githubBaseBranch: "github_base_branch",
        githubPrNumber: "github_pr_number",
        githubPrUrl: "github_pr_url",
        githubPrHeadSha: "github_pr_head_sha",
        herokuAppUrl: "heroku_app_url",
        reviewAppAnnouncedAt: "review_app_announced_at",
        lastError: "last_error"
      };
      return mapping[key];
    };

    for (const [key, value] of Object.entries(update) as [keyof WorkItemUpdate, unknown][]) {
      assignments.push(`${toColumn(key)} = ?`);
      params.push(value);
    }

    assignments.push("updated_at = ?");
    params.push(new Date().toISOString());

    if (assignments.length === 1) {
      const existing = this.getWorkItem(mondayItemId);
      if (!existing) {
        throw new Error(`Work item not found for ${mondayItemId}`);
      }
      return existing;
    }

    const stmt = this.db.prepare(
      `UPDATE work_items SET ${assignments.join(", ")} WHERE monday_item_id = ?`
    );
    stmt.run(...params, mondayItemId);

    const updated = this.getWorkItem(mondayItemId);
    if (!updated) {
      throw new Error(`Work item not found for ${mondayItemId}`);
    }
    return updated;
  }

  enqueueEvent(event: QueuedMondayEvent): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO event_queue (
        event_id,
        item_id,
        payload_json,
        status,
        attempts,
        available_at,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`
    );

    const result = stmt.run(event.eventId, event.itemId, JSON.stringify(event), now, now, now);
    return result.changes > 0;
  }

  claimNextEventJob(excludedItemIds: string[]): EventQueueJob | null {
    const now = new Date().toISOString();

    const blockedClause =
      excludedItemIds.length > 0
        ? `AND item_id NOT IN (${excludedItemIds.map(() => "?").join(",")})`
        : "";

    const selectSql = `
      SELECT id, event_id, item_id, payload_json, attempts
      FROM event_queue
      WHERE status = 'pending'
      AND available_at <= ?
      ${blockedClause}
      ORDER BY id ASC
      LIMIT 1
    `;

    const selectParams: unknown[] = [now, ...excludedItemIds];
    const row = this.db.prepare(selectSql).get(...selectParams) as EventQueueRow | undefined;

    if (!row) {
      return null;
    }

    const updateResult = this.db
      .prepare(
        `UPDATE event_queue
         SET status = 'processing', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, row.id);

    if (updateResult.changes === 0) {
      return null;
    }

    return {
      id: row.id,
      eventId: row.event_id,
      itemId: row.item_id,
      attempts: row.attempts + 1,
      payload: JSON.parse(row.payload_json) as QueuedMondayEvent
    };
  }

  completeEventJob(jobId: number): void {
    this.db.prepare(`DELETE FROM event_queue WHERE id = ?`).run(jobId);
  }

  failOrRetryEventJob(
    jobId: number,
    message: string,
    maxRetries: number,
    retryDelaySeconds: number
  ): "retry" | "failed" {
    const now = new Date().toISOString();

    const row = this.db
      .prepare(`SELECT attempts FROM event_queue WHERE id = ?`)
      .get(jobId) as { attempts: number } | undefined;

    if (!row) {
      return "failed";
    }

    if (row.attempts >= maxRetries) {
      this.db
        .prepare(
          `UPDATE event_queue
           SET status = 'failed',
               last_error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(message, now, jobId);
      return "failed";
    }

    const nextAvailable = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE event_queue
         SET status = 'pending',
             last_error = ?,
             available_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(message, nextAvailable, now, jobId);

    return "retry";
  }

  listQueueJobs(limit = 100): Array<{
    id: number;
    eventId: string;
    itemId: string;
    status: "pending" | "processing" | "failed";
    attempts: number;
    availableAt: string;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM event_queue ORDER BY id DESC LIMIT ?`)
      .all(limit) as EventQueueRow[];

    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      itemId: row.item_id,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  logWebhookEvent(input: {
    source: string;
    eventId: string | null;
    itemId: string | null;
    eventType: string | null;
    signatureValid: boolean | null;
    queueStatus: "accepted" | "duplicate" | "ignored" | "invalid_signature" | "error";
    httpStatus: number;
    payload: unknown;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_events (
          source,
          event_id,
          item_id,
          event_type,
          signature_valid,
          queue_status,
          http_status,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.source,
        input.eventId,
        input.itemId,
        input.eventType,
        input.signatureValid === null ? null : input.signatureValid ? 1 : 0,
        input.queueStatus,
        input.httpStatus,
        JSON.stringify(input.payload),
        now
      );
  }

  listWebhookEvents(limit = 200): WebhookEventLog[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as WebhookEventRow[];

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      eventId: row.event_id,
      itemId: row.item_id,
      eventType: row.event_type,
      signatureValid:
        row.signature_valid === null ? null : row.signature_valid === 1 ? true : false,
      queueStatus: row.queue_status,
      httpStatus: row.http_status,
      payloadJson: row.payload_json,
      createdAt: row.created_at
    }));
  }

  listDuplicateWebhookEvents(limit = 100): WebhookEventLog[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_events WHERE queue_status = 'duplicate' ORDER BY id DESC LIMIT ?`)
      .all(limit) as WebhookEventRow[];

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      eventId: row.event_id,
      itemId: row.item_id,
      eventType: row.event_type,
      signatureValid:
        row.signature_valid === null ? null : row.signature_valid === 1 ? true : false,
      queueStatus: row.queue_status,
      httpStatus: row.http_status,
      payloadJson: row.payload_json,
      createdAt: row.created_at
    }));
  }

  getWebhookEventById(id: number): { event: WebhookEventLog; payload: unknown } | null {
    const row = this.db
      .prepare(`SELECT * FROM webhook_events WHERE id = ?`)
      .get(id) as WebhookEventRow | undefined;

    if (!row) {
      return null;
    }

    return {
      event: {
        id: row.id,
        source: row.source,
        eventId: row.event_id,
        itemId: row.item_id,
        eventType: row.event_type,
        signatureValid:
          row.signature_valid === null ? null : row.signature_valid === 1 ? true : false,
        queueStatus: row.queue_status,
        httpStatus: row.http_status,
        payloadJson: row.payload_json,
        createdAt: row.created_at
      },
      payload: JSON.parse(row.payload_json)
    };
  }

  logAction(input: {
    level?: "info" | "warn" | "error";
    actionType: string;
    itemId?: string | null;
    eventId?: string | null;
    message: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO action_logs (
          level,
          action_type,
          item_id,
          event_id,
          message,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.level ?? "info",
        input.actionType,
        input.itemId ?? null,
        input.eventId ?? null,
        input.message,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now
      );
  }

  listActionLogs(limit = 300): ActionLogEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM action_logs ORDER BY id DESC LIMIT ?`)
      .all(limit) as ActionLogRow[];

    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      actionType: row.action_type,
      itemId: row.item_id,
      eventId: row.event_id,
      message: row.message,
      metadataJson: row.metadata_json,
      createdAt: row.created_at
    }));
  }

  getDashboardSummary(): {
    workItems: {
      total: number;
      byStatus: Record<string, number>;
    };
    queue: {
      pending: number;
      processing: number;
      failed: number;
    };
    webhooksLast24h: number;
    actionsLast24h: number;
  } {
    const byStatusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM work_items GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM work_items`)
      .get() as { count: number };

    const queueRows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM event_queue GROUP BY status`)
      .all() as Array<{ status: "pending" | "processing" | "failed"; count: number }>;

    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const webhookCount = this.db
      .prepare(`SELECT COUNT(*) AS count FROM webhook_events WHERE created_at >= ?`)
      .get(threshold) as { count: number };

    const actionCount = this.db
      .prepare(`SELECT COUNT(*) AS count FROM action_logs WHERE created_at >= ?`)
      .get(threshold) as { count: number };

    const queue = {
      pending: 0,
      processing: 0,
      failed: 0
    };

    for (const row of queueRows) {
      queue[row.status] = row.count;
    }

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byStatus[row.status] = row.count;
    }

    return {
      workItems: {
        total: totalRow.count,
        byStatus
      },
      queue,
      webhooksLast24h: webhookCount.count,
      actionsLast24h: actionCount.count
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        monday_item_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        work_branch TEXT,
        github_owner TEXT,
        github_repo TEXT,
        github_base_branch TEXT,
        github_pr_number INTEGER,
        github_pr_url TEXT,
        github_pr_head_sha TEXT,
        heroku_app_url TEXT,
        review_app_announced_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_queue_ready
      ON event_queue(status, available_at, id);

      CREATE INDEX IF NOT EXISTS idx_event_queue_item_status
      ON event_queue(item_id, status);

      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_id TEXT,
        item_id TEXT,
        event_type TEXT,
        signature_valid INTEGER,
        queue_status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_created
      ON webhook_events(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_webhook_events_item
      ON webhook_events(item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        action_type TEXT NOT NULL,
        item_id TEXT,
        event_id TEXT,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_action_logs_created
      ON action_logs(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_action_logs_item
      ON action_logs(item_id, created_at DESC);
    `);

    this.ensureColumn("work_items", "github_owner", "TEXT");
    this.ensureColumn("work_items", "github_repo", "TEXT");
    this.ensureColumn("work_items", "github_base_branch", "TEXT");
    this.ensureColumn("work_items", "review_app_announced_at", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, typeSql: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;

    const exists = columns.some((column) => column.name === columnName);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeSql}`);
    }
  }
}

function mapWorkItemRow(row: WorkItemRow): WorkItem {
  return {
    mondayItemId: row.monday_item_id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status,
    workBranch: row.work_branch,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    githubBaseBranch: row.github_base_branch,
    githubPrNumber: row.github_pr_number,
    githubPrUrl: row.github_pr_url,
    githubPrHeadSha: row.github_pr_head_sha,
    herokuAppUrl: row.heroku_app_url,
    reviewAppAnnouncedAt: row.review_app_announced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
