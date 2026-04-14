import crypto from "node:crypto";
import { AppConfig } from "./config";
import { AppDb } from "./db";
import { HerokuClient } from "./integrations/heroku";
import { MondayClient } from "./integrations/monday";
import { WorkflowAgent } from "./integrations/workflowAgent";
import {
  isColumnChangeEvent,
  isCommentEvent,
  isItemCreatedEvent,
  MondayNormalizedEvent,
  normalizeMondayWebhook
} from "./lib/mondayEvents";
import {
  deriveSuggestedBranch,
  mergeRoutingDirectives,
  parseRepoHint,
  parseRoutingDirectives,
  resolveColumnRouting,
  stripRoutingDirectives
} from "./lib/routing";
import { appLogger } from "./lib/appLogger";
import { serializeError } from "./lib/logger";
import {
  EventQueueJob,
  QueuedMondayEvent,
  WorkItem,
  WorkflowAgentContext,
  WorkflowAgentResult,
  WorkStatus
} from "./types";

interface WebhookResult {
  challenge?: string;
  queueStatus?: "accepted" | "duplicate" | "ignored";
  event?: {
    eventId: string | null;
    itemId: string | null;
    eventType: string;
  };
}

const AUTOMATION_TAG = "[automation]";

export class AutomationOrchestrator {
  private activeWorkers = 0;
  private readonly activeItemIds = new Set<string>();
  private isRunning = false;
  private pumpTimer: NodeJS.Timeout | null = null;
  private readonly logger = appLogger.child({ component: "orchestrator" });

  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly monday: MondayClient,
    private readonly workflowAgent: WorkflowAgent,
    private readonly heroku: HerokuClient
  ) {}

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.recordAction({
      actionType: "worker.started",
      message: "Automation worker started"
    });
    this.schedulePump(0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.recordAction({
      actionType: "worker.stopped",
      message: "Automation worker stopped"
    });
  }

  async handleMondayWebhook(payload: unknown): Promise<WebhookResult> {
    const normalized = normalizeMondayWebhook(payload);
    if (normalized.challenge) {
      this.logger.info("Received Monday webhook challenge");
      return { challenge: normalized.challenge };
    }

    if (!normalized.event) {
      this.logger.warn("Ignoring webhook without normalized event");
      return { queueStatus: "ignored" };
    }

    if (isAutomationCommentEvent(normalized.event)) {
      this.logger.info("Ignoring automation-authored webhook event", {
        eventId: normalized.event.eventId ?? null,
        itemId: normalized.event.itemId ?? null,
        eventType: normalized.event.type
      });
      return {
        queueStatus: "ignored",
        event: {
          eventId: normalized.event.eventId,
          itemId: normalized.event.itemId,
          eventType: normalized.event.type
        }
      };
    }

    const queueEvent = toQueuedEvent(normalized.event);
    if (!queueEvent) {
      this.logger.warn("Ignoring webhook without item id", {
        eventId: normalized.event.eventId ?? null,
        eventType: normalized.event.type
      });
      return {
        queueStatus: "ignored",
        event: {
          eventId: normalized.event.eventId,
          itemId: normalized.event.itemId,
          eventType: normalized.event.type
        }
      };
    }

    const inserted = this.db.enqueueEvent(queueEvent);
    if (inserted) {
      this.recordAction({
        actionType: "webhook.enqueued",
        itemId: queueEvent.itemId,
        eventId: queueEvent.eventId,
        message: `Accepted webhook event ${queueEvent.type}`,
        metadata: {
          eventType: queueEvent.type
        }
      });
      this.schedulePump(0);
      return {
        queueStatus: "accepted",
        event: {
          eventId: queueEvent.eventId,
          itemId: queueEvent.itemId,
          eventType: queueEvent.type
        }
      };
    }

    this.recordAction({
      level: "warn",
      actionType: "webhook.duplicate",
      itemId: queueEvent.itemId,
      eventId: queueEvent.eventId,
      message: `Duplicate webhook event ignored (${queueEvent.type})`
    });

    return {
      queueStatus: "duplicate",
      event: {
        eventId: queueEvent.eventId,
        itemId: queueEvent.itemId,
        eventType: queueEvent.type
      }
    };
  }

  getRuntimeStats(): {
    running: boolean;
    activeWorkers: number;
    lockedItemIds: string[];
  } {
    return {
      running: this.isRunning,
      activeWorkers: this.activeWorkers,
      lockedItemIds: Array.from(this.activeItemIds).sort()
    };
  }

  private schedulePump(delayMs: number): void {
    if (!this.isRunning || this.pumpTimer) {
      return;
    }

    this.logger.debug("Scheduling worker pump", {
      delayMs,
      activeWorkers: this.activeWorkers,
      lockedItemCount: this.activeItemIds.size
    });

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pumpQueue();
    }, delayMs);
  }

  private async pumpQueue(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.debug("Worker pump tick", {
      activeWorkers: this.activeWorkers,
      workerConcurrency: this.config.worker.concurrency,
      lockedItemIds: Array.from(this.activeItemIds).sort()
    });

    while (this.activeWorkers < this.config.worker.concurrency) {
      const nextJob = this.db.claimNextEventJob(Array.from(this.activeItemIds));
      if (!nextJob) {
        this.logger.debug("No queue job available for claim", {
          activeWorkers: this.activeWorkers
        });
        break;
      }

      this.activeWorkers += 1;
      this.activeItemIds.add(nextJob.itemId);
      this.logger.info("Claimed queue job", {
        jobId: nextJob.id,
        eventId: nextJob.eventId,
        itemId: nextJob.itemId,
        eventType: nextJob.payload.type,
        attempts: nextJob.attempts,
        activeWorkers: this.activeWorkers
      });

      void this.processJob(nextJob).finally(() => {
        this.activeWorkers -= 1;
        this.activeItemIds.delete(nextJob.itemId);
        this.logger.info("Released queue job lock", {
          jobId: nextJob.id,
          eventId: nextJob.eventId,
          itemId: nextJob.itemId,
          activeWorkers: this.activeWorkers
        });
        this.schedulePump(0);
      });
    }

    this.schedulePump(this.activeWorkers > 0 ? 250 : 1000);
  }

  private async processJob(job: EventQueueJob): Promise<void> {
    this.recordAction({
      actionType: "job.started",
      itemId: job.itemId,
      eventId: job.eventId,
      message: `Worker picked event ${job.payload.type}`,
      metadata: {
        attempts: job.attempts
      }
    });

    try {
      await this.processEvent(job.payload);
      this.db.completeEventJob(job.id);
      this.recordAction({
        actionType: "job.completed",
        itemId: job.itemId,
        eventId: job.eventId,
        message: `Event ${job.payload.type} completed`,
        metadata: {
          attempts: job.attempts
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = this.db.failOrRetryEventJob(
        job.id,
        message,
        this.config.worker.maxRetries,
        this.config.worker.retryDelaySeconds
      );

      if (outcome === "failed") {
        this.recordAction({
          level: "error",
          actionType: "job.failed",
          itemId: job.itemId,
          eventId: job.eventId,
          message,
          metadata: {
            attempts: job.attempts
          }
        });
        await this.safeMondayUpdate(
          job.itemId,
          `${AUTOMATION_TAG} Event processing failed after retries. Check the dashboard/logs for details.\nLast error: ${formatErrorForMonday(
            message
          )}`
        );
      } else {
        this.recordAction({
          level: "warn",
          actionType: "job.retry",
          itemId: job.itemId,
          eventId: job.eventId,
          message,
          metadata: {
            attempts: job.attempts
          }
        });
      }
    }
  }

  private async processEvent(event: QueuedMondayEvent): Promise<void> {
    if (!event.itemId) {
      this.logger.warn("Skipping queue event without item id", {
        eventId: event.eventId,
        eventType: event.type
      });
      return;
    }

    this.logger.info("Dispatching queued event", {
      eventId: event.eventId,
      itemId: event.itemId,
      eventType: event.type,
      boardId: event.boardId,
      columnId: event.columnId
    });

    if (isItemCreatedEvent(event.type)) {
      await this.ensureWorkItemExists(event.itemId);
      return;
    }

    if (isCommentEvent(event.type)) {
      if (event.commentBody) {
        await this.handleTaskUpdate(event);
      } else {
        this.logger.warn("Ignoring comment event without body", {
          eventId: event.eventId,
          itemId: event.itemId,
          eventType: event.type
        });
      }
      return;
    }

    if (isColumnChangeEvent(event.type)) {
      await this.handleColumnChange(event);
      return;
    }

    this.logger.debug("No handler registered for queued event", {
      eventId: event.eventId,
      itemId: event.itemId,
      eventType: event.type
    });
  }

  private async handleTaskUpdate(event: QueuedMondayEvent): Promise<void> {
    if (!event.commentBody) {
      return;
    }

    if (event.commentBody.includes(AUTOMATION_TAG)) {
      this.logger.info("Ignoring automation-authored task update", {
        itemId: event.itemId
      });
      return;
    }

    const mondayContext = await this.monday.getItemContext(event.itemId);
    const existing = this.db.getWorkItem(event.itemId);
    const boardRouting = parseRoutingDirectives(
      [mondayContext.boardName, mondayContext.boardDescription].filter(Boolean).join("\n")
    );
    const columnRouting = resolveColumnRouting(
      boardRouting,
      mondayContext.columnValues,
      { statusLabel: event.statusLabel }
    );
    const commentRouting = parseRoutingDirectives(event.commentBody);
    const routingHint = mergeRoutingDirectives(boardRouting, columnRouting, commentRouting);
    const cleanedPrompt = stripRoutingDirectives(event.commentBody);
    const suggestedBranch = deriveSuggestedBranch({
      title: mondayContext.title,
      itemId: event.itemId,
      boardName: mondayContext.boardName,
      repoHint: routingHint.repoHint
    });
    const resolvedRepo = resolveRepositoryDefaults(routingHint, this.config);

    if (!existing) {
      this.db.createWorkItem({
        mondayItemId: event.itemId,
        boardId: mondayContext.boardId,
        title: mondayContext.title,
        description: cleanedPrompt,
        status: "new"
      });
    } else {
      this.db.updateWorkItem(event.itemId, {
        title: mondayContext.title,
        description: cleanedPrompt
      });
    }

    const routedWorkItem = this.db.updateWorkItem(event.itemId, {
      status: "processing",
      lastError: null,
      githubOwner: resolvedRepo.owner,
      githubRepo: resolvedRepo.repo,
      githubBaseBranch: resolvedRepo.baseBranch
    });

    const agentContext: WorkflowAgentContext = {
      item: {
        mondayItemId: event.itemId,
        boardId: mondayContext.boardId,
        title: mondayContext.title
      },
      board: {
        name: mondayContext.boardName,
        description: mondayContext.boardDescription
      },
      event: {
        eventId: event.eventId,
        type: event.type,
        commentBody: event.commentBody,
        statusLabel: event.statusLabel,
        boardId: event.boardId,
        columnId: event.columnId
      },
      existingWorkItem: routedWorkItem,
      thread: mondayContext.thread,
      defaults: {
        githubOwner: resolvedRepo.owner,
        githubRepo: resolvedRepo.repo,
        githubBaseBranch: resolvedRepo.baseBranch
      },
      routing: routingHint,
      suggestedBranch,
      hints: routingHint,
      automationTag: AUTOMATION_TAG
    };

    this.recordAction({
      actionType: "item.agent.started",
      itemId: event.itemId,
      eventId: event.eventId,
      message: "Delegating workflow decision to Claude",
      metadata: {
        eventType: event.type,
        existingBranch: agentContext.existingWorkItem?.workBranch,
        existingPrNumber: agentContext.existingWorkItem?.githubPrNumber,
        repoHint: routingHint.repoHint,
        baseBranchHint: routingHint.baseBranchHint,
        branchHint: routingHint.branchHint,
        suggestedBranch,
        boardName: mondayContext.boardName,
        threadEntries: mondayContext.thread.length
      }
    });

    try {
      const result = await this.workflowAgent.run(agentContext);
      let updatedWorkItem = this.applyWorkflowAgentResult(
        event.itemId,
        mondayContext.title,
        cleanedPrompt,
        result
      );

      updatedWorkItem = await this.ensureReviewAppLifecycle(agentContext, updatedWorkItem);

      this.recordAction({
        actionType: "item.agent.completed",
        itemId: event.itemId,
        eventId: event.eventId,
        message: result.summary,
        metadata: {
          decision: result.decision,
          repository: result.repository,
          pullRequest: result.pullRequest,
          reviewApp: result.reviewApp,
          monday: result.monday,
          metadata: result.metadata
        }
      });

      if (result.decision === "error") {
        throw new Error(result.summary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateWorkItem(event.itemId, {
        status: "error",
        lastError: message
      });
      this.recordAction({
        level: "error",
        actionType: "item.agent.failed",
        itemId: event.itemId,
        eventId: event.eventId,
        message,
        metadata: serializeError(error)
      });
      throw error;
    }
  }

  private applyWorkflowAgentResult(
    itemId: string,
    title: string,
    description: string,
    result: WorkflowAgentResult
  ): WorkItem {
    const current = this.db.getWorkItem(itemId);
    if (!current) {
      throw new Error(`Work item ${itemId} not found while applying workflow agent result`);
    }

    return this.db.updateWorkItem(itemId, {
      title,
      description,
      status: deriveStatusFromWorkflowResult(current, result),
      workBranch: result.repository?.branch ?? current.workBranch,
      githubOwner: result.repository?.owner ?? current.githubOwner ?? this.config.github.owner,
      githubRepo: result.repository?.repo ?? current.githubRepo ?? this.config.github.repo,
      githubBaseBranch:
        result.repository?.baseBranch ??
        current.githubBaseBranch ??
        this.config.github.baseBranch,
      githubPrNumber: result.pullRequest?.number ?? current.githubPrNumber,
      githubPrUrl: result.pullRequest?.url ?? current.githubPrUrl,
      githubPrHeadSha: result.pullRequest?.headSha ?? current.githubPrHeadSha,
      herokuAppUrl:
        result.reviewApp?.url !== undefined ? result.reviewApp.url ?? null : current.herokuAppUrl,
      reviewAppAnnouncedAt:
        result.reviewApp?.url && result.monday?.postedUpdate
          ? new Date().toISOString()
          : current.reviewAppAnnouncedAt,
      lastError: result.decision === "error" ? result.summary : null
    });
  }

  private async ensureReviewAppLifecycle(
    agentContext: WorkflowAgentContext,
    workItem: WorkItem
  ): Promise<WorkItem> {
    let updatedWorkItem = workItem;

    if (
      !updatedWorkItem.herokuAppUrl &&
      updatedWorkItem.githubPrNumber &&
      updatedWorkItem.workBranch &&
      updatedWorkItem.githubOwner &&
      updatedWorkItem.githubRepo
    ) {
      if (!this.heroku.isConfigured()) {
        this.recordAction({
          level: "warn",
          actionType: "item.review_app.skipped",
          itemId: updatedWorkItem.mondayItemId,
          eventId: agentContext.event.eventId,
          message: "Review app creation skipped because Heroku is not configured",
          metadata: {
            githubOwner: updatedWorkItem.githubOwner,
            githubRepo: updatedWorkItem.githubRepo,
            branch: updatedWorkItem.workBranch,
            prNumber: updatedWorkItem.githubPrNumber
          }
        });
      } else {
        this.recordAction({
          actionType: "item.review_app.creating",
          itemId: updatedWorkItem.mondayItemId,
          eventId: agentContext.event.eventId,
          message: "Creating Heroku review app",
          metadata: {
            githubOwner: updatedWorkItem.githubOwner,
            githubRepo: updatedWorkItem.githubRepo,
            branch: updatedWorkItem.workBranch,
            prNumber: updatedWorkItem.githubPrNumber
          }
        });

        const reviewAppUrl = await this.heroku.createReviewApp({
          branch: updatedWorkItem.workBranch,
          pullRequestNumber: updatedWorkItem.githubPrNumber,
          sourceRepoUrl: `https://github.com/${updatedWorkItem.githubOwner}/${updatedWorkItem.githubRepo}`
        });

        if (reviewAppUrl) {
          updatedWorkItem = this.db.updateWorkItem(updatedWorkItem.mondayItemId, {
            herokuAppUrl: reviewAppUrl,
            reviewAppAnnouncedAt: null
          });
          this.recordAction({
            actionType: "item.review_app.created",
            itemId: updatedWorkItem.mondayItemId,
            eventId: agentContext.event.eventId,
            message: "Heroku review app created",
            metadata: {
              reviewAppUrl
            }
          });
        } else {
          this.recordAction({
            level: "warn",
            actionType: "item.review_app.unavailable",
            itemId: updatedWorkItem.mondayItemId,
            eventId: agentContext.event.eventId,
            message: "Heroku review app was requested but no URL was resolved",
            metadata: {
              githubOwner: updatedWorkItem.githubOwner,
              githubRepo: updatedWorkItem.githubRepo,
              branch: updatedWorkItem.workBranch,
              prNumber: updatedWorkItem.githubPrNumber
            }
          });
        }
      }
    }

    if (!updatedWorkItem.herokuAppUrl || updatedWorkItem.reviewAppAnnouncedAt) {
      return updatedWorkItem;
    }

    const repository = resolveRepositoryForAnnouncement(updatedWorkItem, this.config);
    if (!repository || !updatedWorkItem.workBranch) {
      return updatedWorkItem;
    }

    this.recordAction({
      actionType: "item.review_app.announcing",
      itemId: updatedWorkItem.mondayItemId,
      eventId: agentContext.event.eventId,
      message: "Delegating Monday review-app update to Claude",
      metadata: {
        reviewAppUrl: updatedWorkItem.herokuAppUrl,
        prUrl: updatedWorkItem.githubPrUrl,
        branch: updatedWorkItem.workBranch
      }
    });

    const announcement = await this.workflowAgent.announceReviewApp({
      item: agentContext.item,
      event: agentContext.event,
      existingWorkItem: updatedWorkItem,
      thread: agentContext.thread,
      repository: {
        ...repository,
        branch: updatedWorkItem.workBranch
      },
      pullRequest: {
        number: updatedWorkItem.githubPrNumber,
        url: updatedWorkItem.githubPrUrl,
        headSha: updatedWorkItem.githubPrHeadSha
      },
      reviewApp: {
        url: updatedWorkItem.herokuAppUrl
      },
      automationTag: agentContext.automationTag
    });

    if (!announcement.postedUpdate) {
      throw new Error(
        `Workflow agent did not post the review app update to Monday: ${announcement.updateSummary}`
      );
    }

    updatedWorkItem = this.db.updateWorkItem(updatedWorkItem.mondayItemId, {
      reviewAppAnnouncedAt: new Date().toISOString()
    });

    this.recordAction({
      actionType: "item.review_app.announced",
      itemId: updatedWorkItem.mondayItemId,
      eventId: agentContext.event.eventId,
      message: announcement.updateSummary,
      metadata: {
        reviewAppUrl: updatedWorkItem.herokuAppUrl,
        ...announcement.metadata
      }
    });

    return updatedWorkItem;
  }

  private async ensureWorkItemExists(itemId: string): Promise<void> {
    const existing = this.db.getWorkItem(itemId);
    if (existing) {
      return;
    }

    const basics = await this.monday.getItemBasics(itemId);
    this.db.createWorkItem({
      mondayItemId: itemId,
      boardId: basics.boardId,
      title: basics.title,
      description: "",
      status: "new"
    });

    this.recordAction({
      actionType: "item.created",
      itemId,
      message: "Item created and waiting for first update prompt"
    });
  }

  private async handleColumnChange(event: QueuedMondayEvent): Promise<void> {
    if (!event.itemId) {
      return;
    }

    const workItem = this.db.getWorkItem(event.itemId);
    if (!workItem?.githubPrNumber) {
      this.logger.debug("Ignoring column change because no PR exists yet", {
        itemId: event.itemId,
        eventId: event.eventId,
        statusLabel: event.statusLabel
      });
      return;
    }

    const approvedLabel = this.config.monday.statusApprovedLabel.toLowerCase();
    const incomingLabel = event.statusLabel?.toLowerCase() ?? "";
    const isApproved = incomingLabel === approvedLabel;

    if (!isApproved) {
      this.logger.debug("Ignoring non-approved column change", {
        itemId: event.itemId,
        eventId: event.eventId,
        statusLabel: event.statusLabel
      });
      return;
    }

    if (workItem.status === "ready_to_merge") {
      this.logger.info("Ignoring approved status because item is already ready to merge", {
        itemId: event.itemId,
        eventId: event.eventId
      });
      return;
    }

    this.db.updateWorkItem(event.itemId, {
      status: "ready_to_merge",
      lastError: null
    });
    this.recordAction({
      actionType: "item.ready_to_merge",
      itemId: event.itemId,
      eventId: event.eventId,
      message: "Status moved to approved and is ready for manual merge",
      metadata: {
        statusLabel: event.statusLabel
      }
    });

    const prUrl = workItem.githubPrUrl ?? `PR #${workItem.githubPrNumber}`;
    await this.monday.postUpdate(
      event.itemId,
      `${AUTOMATION_TAG} Status is approved. Please merge manually after final checks: ${prUrl}`
    );
  }

  private async safeMondayUpdate(itemId: string, body: string): Promise<void> {
    try {
      await this.monday.postUpdate(itemId, body);
    } catch (error) {
      this.logger.error("Failed to post Monday update", {
        itemId,
        ...serializeError(error)
      });
    }
  }

  private recordAction(input: {
    level?: "info" | "warn" | "error";
    actionType: string;
    itemId?: string | null;
    eventId?: string | null;
    message: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db.logAction(input);

    const level = input.level ?? "info";
    const fields = {
      actionType: input.actionType,
      itemId: input.itemId ?? null,
      eventId: input.eventId ?? null,
      metadata: input.metadata ?? {}
    };

    if (level === "error") {
      this.logger.error(input.message, fields);
      return;
    }
    if (level === "warn") {
      this.logger.warn(input.message, fields);
      return;
    }
    this.logger.info(input.message, fields);
  }
}

function toQueuedEvent(event: MondayNormalizedEvent): QueuedMondayEvent | null {
  if (!event.itemId) {
    return null;
  }

  return {
    eventId: event.eventId ?? crypto.randomUUID(),
    type: event.type,
    itemId: event.itemId,
    boardId: event.boardId,
    columnId: event.columnId,
    statusLabel: event.statusLabel,
    commentBody: event.commentBody
  };
}

function isAutomationCommentEvent(event: MondayNormalizedEvent): boolean {
  return isCommentEvent(event.type) && Boolean(event.commentBody?.includes(AUTOMATION_TAG));
}

export function formatErrorForMonday(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferredLine =
    lines.find((line) => /write access|permission|forbidden|unauthorized|not granted/i.test(line)) ??
    lines.find((line) => /requested url returned error/i.test(line)) ??
    lines.at(-1) ??
    "See dashboard logs";

  return preferredLine.replace(/\s+/g, " ").slice(0, 300);
}

export function deriveStatusFromWorkflowResult(
  current: WorkItem,
  result: WorkflowAgentResult
): WorkStatus {
  if (result.decision === "error") {
    return "error";
  }

  if (result.decision === "create_pr" || result.decision === "revise_pr") {
    if (result.pullRequest?.number || result.pullRequest?.url) {
      return "pr_open";
    }
    if (result.repository?.branch || current.workBranch) {
      return "processing";
    }
    return current.status === "error" ? "processing" : current.status;
  }

  if (result.decision === "reply_only" || result.decision === "noop") {
    return current.status === "error" ? "new" : current.status;
  }

  return current.status;
}

function resolveRepositoryDefaults(
  routing: { repoHint?: string; baseBranchHint?: string; branchHint?: string },
  config: AppConfig
): { owner: string; repo: string; baseBranch: string } {
  const repo = parseRepoHint(routing.repoHint);
  return {
    owner: repo?.owner ?? config.github.owner,
    repo: repo?.repo ?? config.github.repo,
    baseBranch: routing.baseBranchHint ?? config.github.baseBranch
  };
}

function parseRoutingHint(taskUpdate: string): {
  repoHint?: string;
  baseBranchHint?: string;
} {
  const lines = taskUpdate.split(/\r?\n/);
  const result: { repoHint?: string; baseBranchHint?: string } = {};

  for (const line of lines) {
    const trimmed = line.trim();
    const repoMatch = trimmed.match(/^(?:@repo|repo:)\s+(.+)$/i);
    if (repoMatch?.[1]) {
      result.repoHint = repoMatch[1].trim();
      continue;
    }

    const branchMatch = trimmed.match(/^(?:@base|base:|branch:)\s+(.+)$/i);
    if (branchMatch?.[1]) {
      result.baseBranchHint = branchMatch[1].trim();
    }
  }

  return result;
}


function resolveRepositoryForAnnouncement(
  item: WorkItem,
  config: AppConfig
): { owner: string; repo: string; baseBranch: string } | null {
  const owner = item.githubOwner ?? config.github.owner;
  const repo = item.githubRepo ?? config.github.repo;
  const baseBranch = item.githubBaseBranch ?? config.github.baseBranch;

  if (!owner || !repo || !baseBranch) {
    return null;
  }

  return { owner, repo, baseBranch };
}

export function describeWorkItem(item: WorkItem): string {
  return `Item ${item.mondayItemId} (${item.status})`;
}
