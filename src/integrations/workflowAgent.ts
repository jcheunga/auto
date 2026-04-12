import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZodType, z } from "zod";
import { GitWorkspaceManager } from "./gitWorkspace";
import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";
import { runCommand } from "../lib/shell";
import {
  WorkflowAgentAnnouncementResult,
  WorkflowAgentContext,
  WorkflowAgentResult,
  WorkflowAgentReviewAppContext
} from "../types";

const workflowAgentResultSchema = z.object({
  decision: z.enum(["create_pr", "revise_pr", "reply_only", "noop", "error"]),
  summary: z.string().min(1),
  repository: z
    .object({
      owner: z.string().min(1).optional(),
      repo: z.string().min(1).optional(),
      baseBranch: z.string().min(1).optional(),
      branch: z.string().min(1).optional()
    })
    .optional(),
  pullRequest: z
    .object({
      number: z.number().int().positive().optional(),
      url: z.string().url().optional(),
      headSha: z.string().min(1).optional()
    })
    .optional(),
  reviewApp: z
    .object({
      url: z.string().url().nullable().optional()
    })
    .optional(),
  monday: z
    .object({
      postedUpdate: z.boolean().optional(),
      updateSummary: z.string().optional()
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const workflowAgentAnnouncementResultSchema = z.object({
  postedUpdate: z.boolean(),
  updateSummary: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export interface WorkflowAgent {
  run(context: WorkflowAgentContext): Promise<WorkflowAgentResult>;
  announceReviewApp(
    context: WorkflowAgentReviewAppContext
  ): Promise<WorkflowAgentAnnouncementResult>;
}

interface ClaudeWorkflowAgentConfig {
  command?: string;
  githubToken: string;
  gitWorkspaceRoot: string;
}

export class ClaudeWorkflowAgent implements WorkflowAgent {
  private readonly logger = appLogger.child({ component: "workflow-agent" });
  private readonly gitWorkspaceManager: GitWorkspaceManager;

  constructor(private readonly cfg: ClaudeWorkflowAgentConfig) {
    this.gitWorkspaceManager = new GitWorkspaceManager({
      rootDir: cfg.gitWorkspaceRoot,
      githubToken: cfg.githubToken
    });
  }

  async run(context: WorkflowAgentContext): Promise<WorkflowAgentResult> {
    const gitWorkspace = await this.gitWorkspaceManager.prepareWorkflowWorkspace(context);

    try {
      return await this.runAgentCommand({
        mode: "orchestrate",
        itemId: context.item.mondayItemId,
        payload: context,
        schema: workflowAgentResultSchema,
        promptBuilder: buildWorkflowPrompt,
        cwd: gitWorkspace.worktreeDir,
        extraEnv: {
          WORK_REPO_DIR: gitWorkspace.worktreeDir,
          WORK_REPO_OWNER: gitWorkspace.repository.owner,
          WORK_REPO_NAME: gitWorkspace.repository.repo,
          WORK_BASE_BRANCH: gitWorkspace.repository.baseBranch,
          WORK_BRANCH: gitWorkspace.repository.branch ?? "",
          WORK_SUGGESTED_BRANCH: context.suggestedBranch,
          GIT_ASKPASS: gitWorkspace.gitAskPassPath
        }
      });
    } finally {
      await gitWorkspace.cleanup();
    }
  }

  async announceReviewApp(
    context: WorkflowAgentReviewAppContext
  ): Promise<WorkflowAgentAnnouncementResult> {
    return this.runAgentCommand({
      mode: "review_app_followup",
      itemId: context.item.mondayItemId,
      payload: context,
      schema: workflowAgentAnnouncementResultSchema,
      promptBuilder: buildReviewAppAnnouncementPrompt
    });
  }

  private async runAgentCommand<TPayload extends object, TResult>(input: {
    mode: string;
    itemId: string;
    payload: TPayload;
    schema: ZodType<TResult>;
    promptBuilder: (payload: TPayload, contextFile: string, resultFile: string) => string;
    cwd?: string;
    extraEnv?: NodeJS.ProcessEnv;
  }): Promise<TResult> {
    if (!this.cfg.command) {
      throw new Error("CODE_AGENT_COMMAND is required for Claude-driven orchestration");
    }

    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-agent-"));
    const contextFile = path.join(sessionDir, "context.json");
    const resultFile = path.join(sessionDir, "result.json");
    const prompt = input.promptBuilder(input.payload, contextFile, resultFile);
    const startedAt = Date.now();

    try {
      await fs.writeFile(contextFile, JSON.stringify(input.payload, null, 2), "utf8");

      this.logger.info("Running workflow agent", {
        itemId: input.itemId,
        mode: input.mode,
        command: commandLabel(this.cfg.command),
        sessionDir,
        cwd: input.cwd ?? sessionDir
      });

      await runCommand(this.cfg.command, {
        cwd: input.cwd ?? sessionDir,
        env: {
          ...process.env,
          GITHUB_TOKEN: this.cfg.githubToken,
          GH_TOKEN: this.cfg.githubToken,
          GIT_TERMINAL_PROMPT: "0",
          AUTOMATION_MODE: input.mode,
          WORK_CONTEXT_FILE: contextFile,
          WORK_RESULT_FILE: resultFile,
          WORK_PROMPT: prompt,
          ...input.extraEnv
        }
      });

      const rawResult = await fs.readFile(resultFile, "utf8");
      const parsed = input.schema.parse(JSON.parse(rawResult));

      this.logger.info("Workflow agent completed", {
        itemId: input.itemId,
        mode: input.mode,
        durationMs: Date.now() - startedAt
      });

      return parsed;
    } catch (error) {
      this.logger.error("Workflow agent failed", {
        itemId: input.itemId,
        mode: input.mode,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  }
}

function buildWorkflowPrompt(
  context: WorkflowAgentContext,
  contextFile: string,
  resultFile: string
): string {
  return [
    "You are the workflow agent for a Monday -> GitHub automation.",
    "",
    "Primary goal:",
    "- Decide the correct next action for this Monday item based on the full context.",
    "- Perform the work directly using gh CLI and Monday MCP when needed.",
    "",
    "Operational rules:",
    "- Read the full context JSON from this file:",
    `  ${contextFile}`,
    "- The repository is already checked out in an isolated per-job git worktree.",
    "- Your current working directory is that isolated repository workspace.",
    "- The WORK_REPO_DIR environment variable also points to that repository path.",
    "- Use the derived suggested branch name when creating a fresh branch:",
    `  ${context.suggestedBranch}`,
    "- Board-level routing metadata and per-item directives have already been resolved.",
    "- Use gh CLI for repository, branch, commit, push, and PR operations.",
    "- Use Monday MCP for any Monday follow-up updates or clarifying replies.",
    "- Do not create or manage Heroku review apps in this step. The automation service handles review-app creation separately.",
    "- If a review app becomes available later, you may be called again to post that URL back to Monday.",
    "- Do not reuse or mutate any shared external checkout. Stay inside the isolated worktree for this job.",
    `- If you post to Monday, prefix the update with ${context.automationTag}.`,
    "- Prefer revising the existing tracked branch/PR when one already exists.",
    "- If no branch/PR exists yet, create one.",
    "- If the request is unclear, reply on Monday instead of guessing.",
    "- Do not print the final result to stdout only. You must write a JSON file.",
    "",
    "Write the final machine-readable result to this exact file path:",
    `  ${resultFile}`,
    "",
    "JSON schema:",
    JSON.stringify(
      {
        decision: "create_pr | revise_pr | reply_only | noop | error",
        summary: "short plain-English summary",
        repository: {
          owner: "string",
          repo: "string",
          baseBranch: "string",
          branch: "string"
        },
        pullRequest: {
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          headSha: "commit sha"
        },
        reviewApp: {
          url: "https://review-app.example.com"
        },
        monday: {
          postedUpdate: true,
          updateSummary: "what you posted to Monday"
        },
        metadata: {
          notes: "optional extra metadata"
        }
      },
      null,
      2
    ),
    "",
    "Only include fields that you know.",
    "Always write valid JSON to the result file, even for noop or error decisions.",
    "",
    "Current item summary:",
    `- Monday item: ${context.item.mondayItemId}`,
    `- Title: ${context.item.title}`,
    `- Board: ${context.item.boardId}`,
    `- Latest event type: ${context.event.type}`,
    `- Existing branch: ${context.existingWorkItem?.workBranch ?? "none"}`,
    `- Existing PR: ${context.existingWorkItem?.githubPrUrl ?? context.existingWorkItem?.githubPrNumber ?? "none"}`,
    `- Default repo: ${context.defaults.githubOwner}/${context.defaults.githubRepo}`,
    `- Default base branch: ${context.defaults.githubBaseBranch}`,
    `- Repo hint: ${context.hints.repoHint ?? "none"}`,
    `- Base branch hint: ${context.hints.baseBranchHint ?? "none"}`,
    `- Branch hint: ${context.hints.branchHint ?? "none"}`,
    `- Suggested branch: ${context.suggestedBranch}`,
    `- Board name: ${context.board.name ?? "none"}`,
    `- Board description: ${context.board.description ?? "none"}`,
    "",
    "Environment hints:",
    "- WORK_REPO_DIR: isolated repo workspace path",
    "- WORK_REPO_OWNER: resolved repository owner",
    "- WORK_REPO_NAME: resolved repository name",
    "- WORK_BASE_BRANCH: resolved base branch",
    "- WORK_BRANCH: existing tracked branch if any"
  ].join("\n");
}

function buildReviewAppAnnouncementPrompt(
  context: WorkflowAgentReviewAppContext,
  contextFile: string,
  resultFile: string
): string {
  return [
    "You are the Monday follow-up agent for a Monday -> GitHub -> Heroku automation.",
    "",
    "Primary goal:",
    "- Post the newly created Heroku review-app URL back to the Monday item.",
    "",
    "Operational rules:",
    "- Read the full context JSON from this file:",
    `  ${contextFile}`,
    "- Use Monday MCP to post a concise update that includes the review-app URL.",
    `- Prefix the Monday update with ${context.automationTag}.`,
    "- Mention the pull request URL if it is available.",
    "- Do not create or modify branches, pull requests, or Heroku apps in this step.",
    "- Do not guess: if you cannot post to Monday, write a failure result instead of pretending it succeeded.",
    "- Do not print the final result to stdout only. You must write a JSON file.",
    "",
    "Write the final machine-readable result to this exact file path:",
    `  ${resultFile}`,
    "",
    "JSON schema:",
    JSON.stringify(
      {
        postedUpdate: true,
        updateSummary: "short plain-English summary of the Monday reply",
        metadata: {
          notes: "optional extra metadata"
        }
      },
      null,
      2
    ),
    "",
    "Always write valid JSON to the result file.",
    "",
    "Current item summary:",
    `- Monday item: ${context.item.mondayItemId}`,
    `- Title: ${context.item.title}`,
    `- Board: ${context.item.boardId}`,
    `- Existing PR: ${context.pullRequest.url ?? context.pullRequest.number ?? "none"}`,
    `- Review app URL: ${context.reviewApp.url}`,
    `- Repository: ${context.repository.owner}/${context.repository.repo}`,
    `- Branch: ${context.repository.branch}`
  ].join("\n");
}

function commandLabel(command: string): string {
  const trimmed = command.trim();
  return trimmed.split(/\s+/, 1)[0] || "command";
}
