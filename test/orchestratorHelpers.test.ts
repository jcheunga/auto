import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItem, WorkflowAgentResult } from "../src/types";

process.env.MONDAY_API_TOKEN ??= "test-token";
process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_OWNER ??= "acme";
process.env.GITHUB_REPO ??= "mobile";

const orchestratorPromise = import("../src/orchestrator");

test("formatErrorForMonday prefers permission-like lines and truncates long messages", async () => {
  const { formatErrorForMonday } = await orchestratorPromise;
  const message = [
    "fatal: failed to push some refs",
    "remote: Permission denied to access repository",
    "  requested URL returned error: 403  ",
    "extra detail that should not matter"
  ].join("\n");

  assert.equal(formatErrorForMonday(message), "remote: Permission denied to access repository");

  const longLine = `${"a".repeat(400)} end`;
  assert.ok(formatErrorForMonday(longLine).length <= 300);
});

test("deriveStatusFromWorkflowResult maps workflow decisions to work item status", async () => {
  const { deriveStatusFromWorkflowResult } = await orchestratorPromise;
  const current = makeWorkItem({ status: "new" });

  assert.equal(
    deriveStatusFromWorkflowResult(current, {
      decision: "error",
      summary: "boom"
    }),
    "error"
  );

  assert.equal(
    deriveStatusFromWorkflowResult(current, {
      decision: "create_pr",
      summary: "Created PR",
      pullRequest: { number: 12, url: "https://example.com/pull/12" }
    }),
    "pr_open"
  );

  assert.equal(
    deriveStatusFromWorkflowResult(current, {
      decision: "create_pr",
      summary: "Still working",
      repository: { owner: "acme", repo: "mobile", baseBranch: "main", branch: "feature/x" }
    }),
    "processing"
  );

  assert.equal(
    deriveStatusFromWorkflowResult(makeWorkItem({ status: "error" }), {
      decision: "reply_only",
      summary: "Replied"
    }),
    "new"
  );
});

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    mondayItemId: "item-1",
    boardId: "board-1",
    title: "Fix login",
    description: "",
    status: "new",
    workBranch: null,
    githubOwner: null,
    githubRepo: null,
    githubBaseBranch: null,
    githubPrNumber: null,
    githubPrUrl: null,
    githubPrHeadSha: null,
    herokuAppUrl: null,
    reviewAppAnnouncedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
