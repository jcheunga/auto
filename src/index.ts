import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { config } from "./config";
import { AppDb } from "./db";
import { HerokuClient } from "./integrations/heroku";
import { MondayClient } from "./integrations/monday";
import { ClaudeWorkflowAgent } from "./integrations/workflowAgent";
import { appLogger } from "./lib/appLogger";
import { parseBoolean, parseLimit, parseNullableInteger, parseNullableString, parseStatusValue } from "./lib/requestValues";
import { serializeError } from "./lib/logger";
import { normalizeMondayWebhook } from "./lib/mondayEvents";
import { verifyMondaySignature } from "./lib/signature";
import { AutomationOrchestrator } from "./orchestrator";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();
const logger = appLogger.child({ component: "server" });

app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    }
  })
);

const db = new AppDb(config.databasePath);

const monday = new MondayClient(
  config.monday.apiToken,
  config.monday.apiUrl
);

const workflowAgent = new ClaudeWorkflowAgent({
  githubToken: config.github.token,
  command: config.codeAgent.command,
  gitWorkspaceRoot: config.github.workspaceRoot
});

const heroku = new HerokuClient(
  config.heroku.apiToken,
  config.heroku.pipelineId,
  config.heroku.teamId
);

const orchestrator = new AutomationOrchestrator(db, config, monday, workflowAgent, heroku);
orchestrator.start();
const publicDir = path.resolve(process.cwd(), "public");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.use("/assets", express.static(publicDir));

app.get("/api/dashboard/summary", (_req, res) => {
  res.json({
    summary: db.getDashboardSummary(),
    runtime: orchestrator.getRuntimeStats()
  });
});

app.get("/api/dashboard/work-items", (req, res) => {
  const limit = parseLimit(req.query.limit);
  res.json({
    items: db.listWorkItems(limit)
  });
});

app.get("/api/dashboard/queue", (req, res) => {
  const limit = parseLimit(req.query.limit);
  res.json({
    jobs: db.listQueueJobs(limit)
  });
});

app.get("/api/dashboard/webhooks", (req, res) => {
  const limit = parseLimit(req.query.limit);
  res.json({
    events: db.listWebhookEvents(limit)
  });
});

app.get("/api/dashboard/webhooks/duplicates", (req, res) => {
  const limit = parseLimit(req.query.limit);
  res.json({
    events: db.listDuplicateWebhookEvents(limit)
  });
});

app.post("/api/dashboard/webhooks/:id/replay", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  const stored = db.getWebhookEventById(id);
  if (!stored) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }

  const payload = injectReplayMarker(stored.payload, id);
  const result = await orchestrator.handleMondayWebhook(payload);

  db.logWebhookEvent({
    source: "replay",
    eventId: result.event?.eventId ?? null,
    itemId: result.event?.itemId ?? null,
    eventType: result.event?.eventType ?? null,
    signatureValid: null,
    queueStatus: result.queueStatus ?? "accepted",
    httpStatus: 202,
    payload
  });

  db.logAction({
    actionType: "webhook.replayed",
    itemId: result.event?.itemId ?? stored.event.itemId ?? null,
    eventId: result.event?.eventId ?? stored.event.eventId ?? null,
    message: `Replayed webhook history entry ${id}`,
    metadata: {
      storedWebhookId: id,
      queueStatus: result.queueStatus ?? "accepted"
    }
  });

  res.status(202).json({
    accepted: true,
    queueStatus: result.queueStatus ?? "accepted",
    event: result.event ?? null
  });
});

app.get("/api/dashboard/actions", (req, res) => {
  const limit = parseLimit(req.query.limit, 300, 1000);
  res.json({
    actions: db.listActionLogs(limit)
  });
});

app.patch("/api/dashboard/work-items/:itemId", (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!itemId) {
    res.status(400).json({ error: "invalid item id" });
    return;
  }

  const existing = db.getWorkItem(itemId);
  if (!existing) {
    res.status(404).json({ error: "work item not found" });
    return;
  }

  const update: Record<string, unknown> = {};
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = parseStatusValue(body.status);
    if (!status) {
      res.status(400).json({ error: "invalid status" });
      return;
    }
    update.status = status;
  }

  for (const key of [
    "title",
    "description",
    "workBranch",
    "githubOwner",
    "githubRepo",
    "githubBaseBranch",
    "githubPrUrl",
    "githubPrHeadSha",
    "herokuAppUrl",
    "reviewAppAnnouncedAt",
    "lastError"
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      update[key] = parseNullableString(body[key]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "githubPrNumber")) {
    const parsedNumber = parseNullableInteger(body.githubPrNumber);
    if (parsedNumber === undefined) {
      res.status(400).json({ error: "invalid githubPrNumber" });
      return;
    }
    update.githubPrNumber = parsedNumber;
  }

  const updated = db.updateWorkItem(itemId, update as never);
  db.logAction({
    actionType: "admin.work_item.updated",
    itemId,
    message: "Updated work item through dashboard admin controls",
    metadata: update
  });

  res.json({ item: updated });
});

app.post("/api/admin/worktrees/cleanup", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const owner = parseNullableString(body.owner ?? body.repoOwner) ?? undefined;
    const repo = parseNullableString(body.repo ?? body.repoName) ?? undefined;
    const force = parseBoolean(body.force);
    const result = await workflowAgent.cleanupWorktrees({ owner, repo, force });

    db.logAction({
      actionType: "admin.worktrees.cleanup",
      message: "Triggered worktree cleanup from dashboard admin controls",
      metadata: {
        owner: owner ?? null,
        repo: repo ?? null,
        force: force ?? false,
        ...result
      }
    });

    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    logger.error("Worktree cleanup failed", serializeError(error));
    res.status(500).json({
      error: "cleanup_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/webhooks/monday", async (req, res) => {
  const normalized = normalizeMondayWebhook(req.body);
  const event = normalized.event;

  try {
    logger.info("Received Monday webhook", {
      eventId: event?.eventId ?? null,
      itemId: event?.itemId ?? null,
      eventType: event?.type ?? null,
      hasChallenge: Boolean(normalized.challenge)
    });

    const signature = req.header("x-monday-signature") ?? undefined;
    const signatureValid = verifyMondaySignature(
      req.rawBody ?? Buffer.from(""),
      signature,
      config.monday.signingSecret
    );

    if (!signatureValid) {
      logger.warn("Rejected Monday webhook due to invalid signature", {
        eventId: event?.eventId ?? null,
        itemId: event?.itemId ?? null,
        eventType: event?.type ?? null
      });
      db.logWebhookEvent({
        source: "monday",
        eventId: event?.eventId ?? null,
        itemId: event?.itemId ?? null,
        eventType: event?.type ?? null,
        signatureValid: false,
        queueStatus: "invalid_signature",
        httpStatus: 401,
        payload: req.body
      });
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const result = await orchestrator.handleMondayWebhook(req.body);

    if (result.challenge) {
      logger.info("Responding to Monday webhook challenge");
      db.logWebhookEvent({
        source: "monday",
        eventId: event?.eventId ?? null,
        itemId: event?.itemId ?? null,
        eventType: event?.type ?? null,
        signatureValid: true,
        queueStatus: "ignored",
        httpStatus: 200,
        payload: req.body
      });
      res.json({ challenge: result.challenge });
      return;
    }

    db.logWebhookEvent({
      source: "monday",
      eventId: result.event?.eventId ?? event?.eventId ?? null,
      itemId: result.event?.itemId ?? event?.itemId ?? null,
      eventType: result.event?.eventType ?? event?.type ?? null,
      signatureValid: true,
      queueStatus: result.queueStatus ?? "accepted",
      httpStatus: 202,
      payload: req.body
    });

    logger.info("Accepted Monday webhook", {
      eventId: result.event?.eventId ?? event?.eventId ?? null,
      itemId: result.event?.itemId ?? event?.itemId ?? null,
      eventType: result.event?.eventType ?? event?.type ?? null,
      queueStatus: result.queueStatus ?? "accepted"
    });

    res.status(202).json({ accepted: true });
  } catch (error) {
    logger.error("Webhook handler failed", {
      eventId: event?.eventId ?? null,
      itemId: event?.itemId ?? null,
      eventType: event?.type ?? null,
      ...serializeError(error)
    });
    db.logWebhookEvent({
      source: "monday",
      eventId: event?.eventId ?? null,
      itemId: event?.itemId ?? null,
      eventType: event?.type ?? null,
      signatureValid: config.monday.signingSecret ? true : null,
      queueStatus: "error",
      httpStatus: 500,
      payload: req.body
    });
    db.logAction({
      level: "error",
      actionType: "webhook.handler.error",
      itemId: event?.itemId ?? null,
      eventId: event?.eventId ?? null,
      message: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ error: "internal_error" });
  }
});

const server = app.listen(config.port, () => {
  logger.info("Automation server started", {
    port: config.port,
    databasePath: config.databasePath,
    logLevel: config.logLevel,
    workerConcurrency: config.worker.concurrency,
    workflowAgentCommand: config.codeAgent.command ? "configured" : "missing"
  });
});

function shutdown(): void {
  logger.info("Shutting down automation server");
  server.close(() => {
    orchestrator.stop();
    db.close();
    logger.info("Automation server shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function injectReplayMarker(payload: unknown, id: number): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  cloned.__replayEventId = crypto.randomUUID();
  cloned.__replayedWebhookId = id;
  return cloned;
}

