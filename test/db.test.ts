import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AppDb } from "../src/db";

test("AppDb migrates, stores work items, and updates records", () => {
  const db = createDb();
  try {
    const created = db.createWorkItem({
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Initial title",
      description: "Initial description",
      status: "new"
    });

    assert.equal(created.mondayItemId, "item-1");
    assert.equal(created.status, "new");

    const updated = db.updateWorkItem("item-1", {
      status: "processing",
      workBranch: "monday-board-1-fix-item-1",
      githubOwner: "acme",
      githubRepo: "app",
      githubBaseBranch: "develop",
      githubPrNumber: 42,
      githubPrUrl: "https://github.com/acme/app/pull/42",
      githubPrHeadSha: "abc123",
      herokuAppUrl: "https://example.herokuapp.com",
      reviewAppAnnouncedAt: new Date().toISOString(),
      lastError: null
    });

    assert.equal(updated.status, "processing");
    assert.equal(updated.githubPrNumber, 42);
    assert.equal(updated.githubRepo, "app");
    assert.equal(db.getWorkItem("item-1")?.workBranch, "monday-board-1-fix-item-1");
  } finally {
    db.close();
  }
});

test("AppDb queue deduping, claiming, retrying, and failing behave as expected", () => {
  const db = createDb();
  try {
    const event = {
      eventId: "evt-1",
      type: "create_update",
      itemId: "item-1",
      boardId: "board-1",
      columnId: null,
      statusLabel: null,
      commentBody: "hello"
    };

    assert.equal(db.enqueueEvent(event), true);
    assert.equal(db.enqueueEvent(event), false);

    const claimed = db.claimNextEventJob([]);
    assert.ok(claimed);
    assert.equal(claimed?.eventId, "evt-1");
    assert.equal(claimed?.attempts, 1);

    db.completeEventJob(claimed!.id);
    assert.equal(db.listQueueJobs().length, 0);

    assert.equal(
      db.enqueueEvent({ ...event, eventId: "evt-2", itemId: "item-2" }),
      true
    );
    const blocked = db.claimNextEventJob(["item-2"]);
    assert.equal(blocked, null);

    const retryDb = createDb();
    try {
      retryDb.enqueueEvent({ ...event, eventId: "evt-3", itemId: "item-3" });
      const job = retryDb.claimNextEventJob([])!;
      assert.equal(retryDb.failOrRetryEventJob(job.id, "temporary fail", 3, 0), "retry");
      const queued = retryDb.listQueueJobs()[0];
      assert.equal(queued.status, "pending");
      assert.equal(queued.lastError, "temporary fail");

      const retryJob = retryDb.claimNextEventJob([])!;
      retryDb.failOrRetryEventJob(retryJob.id, "still failing", 1, 0);
      const failed = retryDb.listQueueJobs()[0];
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, "still failing");
    } finally {
      retryDb.close();
    }
  } finally {
    db.close();
  }
});

test("AppDb records webhook and action history and summarizes counts", () => {
  const db = createDb();
  try {
    db.createWorkItem({
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "One",
      description: "",
      status: "new"
    });
    db.createWorkItem({
      mondayItemId: "item-2",
      boardId: "board-1",
      title: "Two",
      description: "",
      status: "processing"
    });

    db.logWebhookEvent({
      source: "monday",
      eventId: "event-1",
      itemId: "item-1",
      eventType: "create_update",
      signatureValid: true,
      queueStatus: "duplicate",
      httpStatus: 202,
      payload: { ok: true }
    });

    db.logAction({
      actionType: "item.started",
      itemId: "item-1",
      eventId: "event-1",
      message: "Started work",
      metadata: { branch: "feature/a" }
    });

    const duplicates = db.listDuplicateWebhookEvents();
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].eventId, "event-1");

    const webhookById = db.getWebhookEventById(duplicates[0].id);
    assert.ok(webhookById);
    assert.equal((webhookById?.payload as Record<string, unknown>).ok, true);

    const summary = db.getDashboardSummary();
    assert.equal(summary.workItems.total, 2);
    assert.equal(summary.workItems.byStatus.new, 1);
    assert.equal(summary.workItems.byStatus.processing, 1);
    assert.equal(summary.webhooksLast24h, 1);
    assert.equal(summary.actionsLast24h, 1);
  } finally {
    db.close();
  }
});

function createDb(): AppDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-db-test-"));
  return new AppDb(path.join(dir, "data.sqlite"));
}
