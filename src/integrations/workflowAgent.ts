import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";
import { runCommand } from "../lib/shell";
import { WorkflowAgentContext, WorkflowAgentResult } from "../types";

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

export interface WorkflowAgent {
  run(context: WorkflowAgentContext): Promise<WorkflowAgentResult>;
}

interface ClaudeWorkflowAgentConfig {
  command?: string;
  githubToken: string;
}

export class ClaudeWorkflowAgent implements WorkflowAgent {
  private readonly logger = appLogger.child({ component: "workflow-agent" });

  constructor(private readonly cfg: ClaudeWorkflowAgentConfig) {}

  async run(context: WorkflowAgentContext): Promise<WorkflowAgentResult> {
    if (!this.cfg.command) {
      throw new Error("CODE_AGENT_COMMAND is required for Claude-driven orchestration");
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-agent-"));
    const contextFile = path.join(workspace, "context.json");
    const resultFile = path.join(workspace, "result.json");
    const prompt = buildWorkflowPrompt(context, contextFile, resultFile);
    const startedAt = Date.now();

    try {
      await fs.writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");

      this.logger.info("Running workflow agent", {
        itemId: context.item.mondayItemId,
        command: commandLabel(this.cfg.command),
        workspace
      });

      await runCommand(this.cfg.command, {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_TOKEN: this.cfg.githubToken,
          GH_TOKEN: this.cfg.githubToken,
          GIT_TERMINAL_PROMPT: "0",
          AUTOMATION_MODE: "orchestrate",
          WORK_CONTEXT_FILE: contextFile,
          WORK_RESULT_FILE: resultFile,
          WORK_PROMPT: prompt
        }
      });

      const rawResult = await fs.readFile(resultFile, "utf8");
      const parsed = workflowAgentResultSchema.parse(JSON.parse(rawResult));

      this.logger.info("Workflow agent completed", {
        itemId: context.item.mondayItemId,
        decision: parsed.decision,
        durationMs: Date.now() - startedAt
      });

      return parsed;
    } catch (error) {
      this.logger.error("Workflow agent failed", {
        itemId: context.item.mondayItemId,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
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
    "- Use gh CLI for repository, branch, commit, push, and PR operations.",
    "- Use Monday MCP for any Monday follow-up updates or clarifying replies.",
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
    `- Base branch hint: ${context.hints.baseBranchHint ?? "none"}`
  ].join("\n");
}

function commandLabel(command: string): string {
  const trimmed = command.trim();
  return trimmed.split(/\s+/, 1)[0] || "command";
}
