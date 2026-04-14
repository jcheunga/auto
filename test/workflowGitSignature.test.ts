import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { WorkflowAgentContext, WorkflowAgentReviewAppContext } from "../src/types";

process.env.MONDAY_API_TOKEN ??= "test-token";
process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_OWNER ??= "acme";
process.env.GITHUB_REPO ??= "mobile";
process.env.CODE_AGENT_COMMAND ??= "claude";

const modulesPromise = loadModules();

test("verifyMondaySignature validates HMAC signatures and handles missing secrets", async () => {
  const { verifyMondaySignature } = await modulesPromise;
  const rawBody = Buffer.from('{"hello":"world"}');
  const secret = "top-secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  assert.equal(verifyMondaySignature(rawBody, `sha256=${signature}`, secret), true);
  assert.equal(verifyMondaySignature(rawBody, signature, secret), true);
  assert.equal(verifyMondaySignature(rawBody, "sha256=deadbeef", secret), false);
  assert.equal(verifyMondaySignature(rawBody, undefined, secret), false);
  assert.equal(verifyMondaySignature(rawBody, undefined, undefined), true);
});

test("git workspace helpers derive repository targets and shell-safe paths", async () => {
  const {
    repositoryHttpsUrl,
    resolveRepositoryTarget,
    shellEscape,
    toPathSegment
  } = await modulesPromise;

  const context = makeWorkflowContext({
    existingWorkItem: {
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Existing item",
      description: "",
      status: "processing",
      workBranch: "feature/existing",
      githubOwner: "acme",
      githubRepo: "mobile",
      githubBaseBranch: "develop",
      githubPrNumber: null,
      githubPrUrl: null,
      githubPrHeadSha: null,
      herokuAppUrl: null,
      reviewAppAnnouncedAt: null,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    routing: {
      repoHint: "other/ignored",
      baseBranchHint: "main",
      branchHint: "feature/routing"
    },
    hints: {
      repoHint: "another/ignored",
      baseBranchHint: "release",
      branchHint: "feature/hint"
    },
    suggestedBranch: "monday-item-1"
  });

  const repository = resolveRepositoryTarget(context);
  assert.deepEqual(repository, {
    owner: "acme",
    repo: "mobile",
    baseBranch: "develop",
    branch: "feature/existing"
  });

  assert.equal(repositoryHttpsUrl("acme", "mobile"), "https://github.com/acme/mobile.git");
  assert.equal(toPathSegment("release/2026 + qa"), "release-2026-qa");
  assert.equal(toPathSegment("!!!"), "value");
  assert.equal(shellEscape("O'Reilly"), "'O'\\''Reilly'");
});

test("workflow prompt includes routing hints and worktree instructions", async () => {
  const { buildWorkflowPrompt } = await modulesPromise;
  const prompt = buildWorkflowPrompt(makeWorkflowContext(), "/tmp/context.json", "/tmp/result.json");

  assert.match(prompt, /isolated per-job git worktree/);
  assert.match(prompt, /WORK_REPO_DIR/);
  assert.match(prompt, /Suggested branch: monday-item-1/);
  assert.match(prompt, /write a JSON file/);
  assert.match(prompt, /\[automation\]/);
});

test("review app prompt asks for Monday follow-up without mutating repo state", async () => {
  const { buildReviewAppAnnouncementPrompt } = await modulesPromise;
  const prompt = buildReviewAppAnnouncementPrompt(makeReviewAppContext(), "/tmp/context.json", "/tmp/result.json");

  assert.match(prompt, /Monday follow-up agent/);
  assert.match(prompt, /review-app URL/);
  assert.match(prompt, /Do not create or modify branches/);
  assert.match(prompt, /\[automation\]/);
});

test("commandLabel extracts the executable name from a command string", async () => {
  const { commandLabel } = await modulesPromise;
  assert.equal(commandLabel("claude --dangerously-skip-permissions"), "claude");
  assert.equal(commandLabel("   git status   "), "git");
  assert.equal(commandLabel("   "), "command");
});

async function loadModules() {
  const [gitWorkspace, workflowAgent, signature] = await Promise.all([
    import("../src/integrations/gitWorkspace"),
    import("../src/integrations/workflowAgent"),
    import("../src/lib/signature")
  ]);

  return {
    repositoryHttpsUrl: gitWorkspace.repositoryHttpsUrl,
    resolveRepositoryTarget: gitWorkspace.resolveRepositoryTarget,
    shellEscape: gitWorkspace.shellEscape,
    toPathSegment: gitWorkspace.toPathSegment,
    buildWorkflowPrompt: workflowAgent.buildWorkflowPrompt,
    buildReviewAppAnnouncementPrompt: workflowAgent.buildReviewAppAnnouncementPrompt,
    commandLabel: workflowAgent.commandLabel,
    verifyMondaySignature: signature.verifyMondaySignature
  };
}

function makeWorkflowContext(overrides: Partial<WorkflowAgentContext> = {}): WorkflowAgentContext {
  return {
    item: {
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Fix login flow"
    },
    board: {
      name: "Mobile Board",
      description: "Board description"
    },
    event: {
      eventId: "event-1",
      type: "create_update",
      commentBody: "Please help",
      statusLabel: null,
      boardId: "board-1",
      columnId: null
    },
    existingWorkItem: null,
    thread: [],
    defaults: {
      githubOwner: "acme",
      githubRepo: "mobile",
      githubBaseBranch: "main"
    },
    routing: {},
    suggestedBranch: "monday-item-1",
    hints: {},
    automationTag: "[automation]",
    ...overrides
  };
}

function makeReviewAppContext(): WorkflowAgentReviewAppContext {
  return {
    item: {
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Fix login flow"
    },
    event: {
      eventId: "event-2",
      type: "create_update",
      commentBody: "Please help",
      statusLabel: null,
      boardId: "board-1",
      columnId: null
    },
    existingWorkItem: {
      mondayItemId: "item-1",
      boardId: "board-1",
      title: "Fix login flow",
      description: "",
      status: "pr_open",
      workBranch: "feature/login",
      githubOwner: "acme",
      githubRepo: "mobile",
      githubBaseBranch: "main",
      githubPrNumber: 42,
      githubPrUrl: "https://github.com/acme/mobile/pull/42",
      githubPrHeadSha: "abc123",
      herokuAppUrl: "https://example.herokuapp.com",
      reviewAppAnnouncedAt: null,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    thread: [],
    repository: {
      owner: "acme",
      repo: "mobile",
      baseBranch: "main",
      branch: "feature/login"
    },
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/mobile/pull/42",
      headSha: "abc123"
    },
    reviewApp: {
      url: "https://review.example.com"
    },
    automationTag: "[automation]"
  };
}
