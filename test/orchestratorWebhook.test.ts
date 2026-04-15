import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDb } from "../src/db";
import type { QueuedMondayEvent } from "../src/types";

process.env.MONDAY_API_TOKEN ??= "test-token";
process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_OWNER ??= "acme";
process.env.GITHUB_REPO ??= "mobile";

const orchestratorPromise = import("../src/orchestrator");

test("handleMondayWebhook enqueues comment updates and ignores automation-authored comments", async () => {
  const { AutomationOrchestrator } = await orchestratorPromise;
  const db = createDb();
  const mondayCalls: Array<{ itemId: string }> = [];
  try {
    const orchestrator = new AutomationOrchestrator(db, makeConfig(), {
      getItemContext: async (itemId: string) => {
        mondayCalls.push({ itemId });
        return makeItemContext(itemId);
      }
    } as never, {
      run: async () => ({ decision: "reply_only", summary: "Replied to the comment" }),
      announceReviewApp: async () => ({ postedUpdate: false, updateSummary: "noop" }),
      cleanupWorktrees: async () => ({ reposScanned: 0, worktreesRemoved: 0, repoKeys: [] })
    } as never, {
      isConfigured: () => false
    } as never);

    const result = await orchestrator.handleMondayWebhook({
      event: {
        eventId: "evt-1",
        type: "create_update",
        pulseId: 42,
        boardId: 7,
        columnId: "updates",
        value: {
          text: "Please update the copy"
        }
      }
    });

    assert.equal(result.queueStatus, "accepted");
    assert.equal(result.event?.eventId, "evt-1");
    const queued = db.listQueueJobs();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].itemId, "42");
    assert.equal(queued[0].eventId, "evt-1");
    assert.equal(mondayCalls.length, 0, "queued event should not run the workflow synchronously");

    const ignored = await orchestrator.handleMondayWebhook({
      event: {
        eventId: "evt-2",
        type: "create_update",
        pulseId: 42,
        boardId: 7,
        columnId: "updates",
        value: {
          text: "[automation] already handled"
        }
      }
    });

    assert.equal(ignored.queueStatus, "ignored");
    assert.equal(db.listQueueJobs().length, 1);
    assert.equal(mondayCalls.length, 0);
  } finally {
    db.close();
  }
});

test("handleMondayWebhook deduplicates repeated event ids and ignores missing item ids", async () => {
  const { AutomationOrchestrator } = await orchestratorPromise;
  const db = createDb();
  try {
    const orchestrator = new AutomationOrchestrator(db, makeConfig(), {
      getItemContext: async () => makeItemContext("item-1")
    } as never, {
      run: async () => ({ decision: "noop", summary: "Noop" }),
      announceReviewApp: async () => ({ postedUpdate: false, updateSummary: "noop" }),
      cleanupWorktrees: async () => ({ reposScanned: 0, worktreesRemoved: 0, repoKeys: [] })
    } as never, {
      isConfigured: () => false
    } as never);

    const payload: QueuedMondayEvent = {
      eventId: "evt-3",
      type: "create_update",
      itemId: "item-1",
      boardId: "7",
      columnId: null,
      statusLabel: null,
      commentBody: "hello"
    };

    const first = await orchestrator.handleMondayWebhook({ event: payload });
    const second = await orchestrator.handleMondayWebhook({ event: payload });
    const missingItem = await orchestrator.handleMondayWebhook({
      event: {
        eventId: "evt-4",
        type: "create_update",
        boardId: 7,
        columnId: "updates",
        value: { text: "Hello" }
      }
    });

    assert.equal(first.queueStatus, "accepted");
    assert.equal(second.queueStatus, "duplicate");
    assert.equal(missingItem.queueStatus, "ignored");
    assert.equal(db.listQueueJobs().length, 1);
    assert.equal(db.listWebhookEvents(10).filter((entry) => entry.queueStatus === "duplicate").length, 0);
  } finally {
    db.close();
  }
});

test("handleMondayWebhook enqueues item-created events for later processing", async () => {
  const { AutomationOrchestrator } = await orchestratorPromise;
  const db = createDb();
  try {
    const orchestrator = new AutomationOrchestrator(db, makeConfig(), {
      getItemContext: async (itemId: string) => makeItemContext(itemId)
    } as never, {
      run: async () => ({ decision: "noop", summary: "Noop" }),
      announceReviewApp: async () => ({ postedUpdate: false, updateSummary: "noop" }),
      cleanupWorktrees: async () => ({ reposScanned: 0, worktreesRemoved: 0, repoKeys: [] })
    } as never, {
      isConfigured: () => false
    } as never);

    const result = await orchestrator.handleMondayWebhook({
      event: {
        eventId: "evt-5",
        type: "create_item",
        pulseId: 99,
        boardId: 11
      }
    });

    assert.equal(result.queueStatus, "accepted");
    const queued = db.listQueueJobs();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].itemId, "99");
    assert.equal(queued[0].eventId, "evt-5");
  } finally {
    db.close();
  }
});


test("handleMondayWebhook generates a queue id when Monday omits one", async () => {
  const { AutomationOrchestrator } = await orchestratorPromise;
  const db = createDb();
  try {
    const orchestrator = new AutomationOrchestrator(db, makeConfig(), {
      getItemContext: async (itemId: string) => makeItemContext(itemId)
    } as never, {
      run: async () => ({ decision: "noop", summary: "Noop" }),
      announceReviewApp: async () => ({ postedUpdate: false, updateSummary: "noop" }),
      cleanupWorktrees: async () => ({ reposScanned: 0, worktreesRemoved: 0, repoKeys: [] })
    } as never, {
      isConfigured: () => false
    } as never);

    const result = await orchestrator.handleMondayWebhook({
      event: {
        type: "create_update",
        pulseId: 100,
        boardId: 11,
        columnId: "updates",
        value: {
          text: "Please review"
        }
      }
    });

    assert.equal(result.queueStatus, "accepted");
    assert.ok(result.event?.eventId);
    assert.equal(result.event?.itemId, "100");
    const queued = db.listQueueJobs();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].itemId, "100");
    assert.equal(queued[0].eventId.length > 0, true);
  } finally {
    db.close();
  }
});

function createDb(): AppDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-orchestrator-test-"));
  return new AppDb(path.join(dir, "data.sqlite"));
}

function makeConfig() {
  return {
    monday: {
      signingSecret: undefined,
      statusApprovedLabel: "Approved"
    },
    github: {
      owner: "acme",
      repo: "mobile",
      baseBranch: "main",
      workspaceRoot: path.join(os.tmpdir(), "auto-orchestrator-workspaces")
    },
    worker: {
      concurrency: 1,
      maxRetries: 1,
      retryDelaySeconds: 0
    },
    codeAgent: {
      command: undefined
    },
    heroku: {
      apiToken: undefined,
      pipelineId: undefined,
      teamId: undefined
    }
  } as const;
}

function makeItemContext(itemId: string) {
  return {
    itemId,
    boardId: "board-1",
    title: `Item ${itemId}`,
    boardName: "Board 1",
    boardDescription: "Board description",
    columnValues: [],
    thread: []
  };
}
