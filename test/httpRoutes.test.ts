import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { AppDb } from "../src/db";
import { createApp } from "../src/app";

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-http-test-"));
  return new AppDb(path.join(dir, "data.sqlite"));
}

async function withServer<T>(app: ReturnType<typeof createApp>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("HTTP routes expose dashboard data and update work items end-to-end", async () => {
  const db = createDb();
  try {
    db.createWorkItem({
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Initial title",
      description: "Initial description",
      status: "new"
    });
    db.logAction({
      actionType: "seed.action",
      itemId: "item-1",
      message: "Seeded action"
    });

    const cleanupCalls: Array<{ owner?: string; repo?: string; force?: boolean }> = [];
    const app = createApp({
      db,
      config: { monday: { signingSecret: undefined } },
      orchestrator: {
        getRuntimeStats: () => ({ running: true, activeWorkers: 2, lockedItemIds: ["item-1"] }),
        handleMondayWebhook: async () => ({ queueStatus: "accepted", event: { eventId: "evt-1", itemId: "item-1", eventType: "create_update" } })
      },
      workflowAgent: {
        cleanupWorktrees: async (input) => {
          cleanupCalls.push(input);
          return { removed: 1, scanned: 3 };
        }
      }
    });

    await withServer(app, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const summaryResponse = await fetch(`${baseUrl}/api/dashboard/summary`);
      assert.equal(summaryResponse.status, 200);
      const summaryBody = await summaryResponse.json() as any;
      assert.equal(summaryBody.summary.workItems.total, 1);
      assert.equal(summaryBody.summary.actionsLast24h, 1);
      assert.equal(summaryBody.runtime.running, true);
      assert.equal(summaryBody.runtime.activeWorkers, 2);

      const itemsResponse = await fetch(`${baseUrl}/api/dashboard/work-items?limit=1`);
      assert.equal(itemsResponse.status, 200);
      const itemsBody = await itemsResponse.json() as any;
      assert.equal(itemsBody.items.length, 1);
      assert.equal(itemsBody.items[0].mondayItemId, "item-1");

      const patchResponse = await fetch(`${baseUrl}/api/dashboard/work-items/item-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "processing",
          title: "Updated title",
          githubPrNumber: 17
        })
      });
      assert.equal(patchResponse.status, 200);
      const patchBody = await patchResponse.json() as any;
      assert.equal(patchBody.item.status, "processing");
      assert.equal(patchBody.item.title, "Updated title");
      assert.equal(patchBody.item.githubPrNumber, 17);

      const actionsResponse = await fetch(`${baseUrl}/api/dashboard/actions?limit=10`);
      assert.equal(actionsResponse.status, 200);
      const actionsBody = await actionsResponse.json() as any;
      assert.ok(actionsBody.actions.some((action: any) => action.actionType === "admin.work_item.updated"));

      const cleanupResponse = await fetch(`${baseUrl}/api/admin/worktrees/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoOwner: "acme", repoName: "app", force: "true" })
      });
      assert.equal(cleanupResponse.status, 200);
      const cleanupBody = await cleanupResponse.json() as any;
      assert.equal(cleanupBody.ok, true);
      assert.equal(cleanupBody.removed, 1);
      assert.equal(cleanupBody.scanned, 3);
      assert.deepEqual(cleanupCalls, [{ owner: "acme", repo: "app", force: true }]);
    });
  } finally {
    db.close();
  }
});

test("HTTP routes replay stored webhooks and accept Monday challenges", async () => {
  const db = createDb();
  try {
    const replayedPayloads: unknown[] = [];
    const app = createApp({
      db,
      config: { monday: { signingSecret: undefined } },
      orchestrator: {
        getRuntimeStats: () => ({ running: false, activeWorkers: 0, lockedItemIds: [] }),
        handleMondayWebhook: async (payload) => {
          if (payload && typeof payload === "object" && "challenge" in payload) {
            return { challenge: "abc123" };
          }
          replayedPayloads.push(payload);
          return {
            queueStatus: "accepted",
            event: { eventId: "evt-replayed", itemId: "item-1", eventType: "create_update" }
          };
        }
      },
      workflowAgent: {
        cleanupWorktrees: async () => ({ removed: 0, scanned: 0 })
      }
    });

    db.logWebhookEvent({
      source: "monday",
      eventId: "evt-original",
      itemId: "item-1",
      eventType: "create_update",
      signatureValid: true,
      queueStatus: "accepted",
      httpStatus: 202,
      payload: { event: { type: "create_update", pulseId: 123 } }
    });
    const storedId = db.listWebhookEvents(1)[0].id;

    await withServer(app, async (baseUrl) => {
      const challengeResponse = await fetch(`${baseUrl}/webhooks/monday`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: "abc123" })
      });
      assert.equal(challengeResponse.status, 200);
      assert.deepEqual(await challengeResponse.json(), { challenge: "abc123" });

      const replayResponse = await fetch(`${baseUrl}/api/dashboard/webhooks/${storedId}/replay`, {
        method: "POST"
      });
      assert.equal(replayResponse.status, 202);
      const replayBody = await replayResponse.json() as any;
      assert.equal(replayBody.accepted, true);
      assert.equal(replayBody.queueStatus, "accepted");
      assert.equal(replayedPayloads.length, 1);
      const replayPayload = replayedPayloads[0] as Record<string, unknown>;
      assert.equal(replayPayload.__replayedWebhookId, storedId);
      assert.equal(typeof replayPayload.__replayEventId, "string");

      const replayEvents = db.listWebhookEvents(10).filter((event) => event.source === "replay");
      assert.equal(replayEvents.length, 1);
      assert.equal(replayEvents[0].eventId, "evt-replayed");
    });
  } finally {
    db.close();
  }
});

test("HTTP routes reject invalid dashboard and webhook inputs", async () => {
  const db = createDb();
  try {
    let cleanupCalls = 0;
    let webhookCalls = 0;
    const app = createApp({
      db,
      config: { monday: { signingSecret: "secret" } },
      orchestrator: {
        getRuntimeStats: () => ({ running: false, activeWorkers: 0, lockedItemIds: [] }),
        handleMondayWebhook: async () => {
          webhookCalls += 1;
          return { queueStatus: "accepted", event: { eventId: "evt-1", itemId: "item-1", eventType: "create_update" } };
        }
      },
      workflowAgent: {
        cleanupWorktrees: async () => {
          cleanupCalls += 1;
          throw new Error("boom");
        }
      }
    });

    db.createWorkItem({
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Title",
      description: "Description",
      status: "new"
    });

    await withServer(app, async (baseUrl) => {
      const invalidStatus = await fetch(`${baseUrl}/api/dashboard/work-items/item-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "not-a-status" })
      });
      assert.equal(invalidStatus.status, 400);

      const missingItem = await fetch(`${baseUrl}/api/dashboard/work-items/missing-item`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nope" })
      });
      assert.equal(missingItem.status, 404);

      const invalidReplayId = await fetch(`${baseUrl}/api/dashboard/webhooks/abc/replay`, {
        method: "POST"
      });
      assert.equal(invalidReplayId.status, 400);

      const missingReplay = await fetch(`${baseUrl}/api/dashboard/webhooks/999/replay`, {
        method: "POST"
      });
      assert.equal(missingReplay.status, 404);

      const cleanupFailure = await fetch(`${baseUrl}/api/admin/worktrees/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true })
      });
      assert.equal(cleanupFailure.status, 500);
      const cleanupBody = await cleanupFailure.json() as any;
      assert.equal(cleanupBody.error, "cleanup_failed");
      assert.equal(cleanupCalls, 1);

      const invalidSignature = await fetch(`${baseUrl}/webhooks/monday`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { type: "create_item", pulseId: 1 } })
      });
      assert.equal(invalidSignature.status, 401);
      assert.equal(webhookCalls, 0);
    });
  } finally {
    db.close();
  }
});