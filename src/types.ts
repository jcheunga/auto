export type WorkStatus =
  | "new"
  | "processing"
  | "pr_open"
  | "ready_to_merge"
  | "awaiting_changes"
  | "error";

export interface WorkItem {
  mondayItemId: string;
  boardId: string;
  title: string;
  description: string;
  status: WorkStatus;
  workBranch: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBaseBranch: string | null;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  githubPrHeadSha: string | null;
  herokuAppUrl: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemUpdate {
  title?: string;
  description?: string;
  status?: WorkStatus;
  workBranch?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubBaseBranch?: string | null;
  githubPrNumber?: number | null;
  githubPrUrl?: string | null;
  githubPrHeadSha?: string | null;
  herokuAppUrl?: string | null;
  lastError?: string | null;
}

export interface QueuedMondayEvent {
  eventId: string;
  type: string;
  itemId: string;
  boardId: string | null;
  columnId: string | null;
  statusLabel: string | null;
  commentBody: string | null;
}

export interface EventQueueJob {
  id: number;
  eventId: string;
  itemId: string;
  attempts: number;
  payload: QueuedMondayEvent;
}

export interface WebhookEventLog {
  id: number;
  source: string;
  eventId: string | null;
  itemId: string | null;
  eventType: string | null;
  signatureValid: boolean | null;
  queueStatus: "accepted" | "duplicate" | "ignored" | "invalid_signature" | "error";
  httpStatus: number;
  payloadJson: string;
  createdAt: string;
}

export interface ActionLogEntry {
  id: number;
  level: "info" | "warn" | "error";
  actionType: string;
  itemId: string | null;
  eventId: string | null;
  message: string;
  metadataJson: string | null;
  createdAt: string;
}

export interface MondayThreadEntry {
  id: string;
  kind: "update" | "reply";
  parentUpdateId: string | null;
  body: string;
  textBody: string;
  createdAt: string | null;
  creatorId: string | null;
  creatorName: string | null;
}

export interface WorkflowAgentContext {
  item: {
    mondayItemId: string;
    boardId: string;
    title: string;
  };
  event: {
    eventId: string;
    type: string;
    commentBody: string;
    statusLabel: string | null;
    boardId: string | null;
    columnId: string | null;
  };
  existingWorkItem: WorkItem | null;
  thread: MondayThreadEntry[];
  defaults: {
    githubOwner: string;
    githubRepo: string;
    githubBaseBranch: string;
  };
  hints: {
    repoHint?: string;
    baseBranchHint?: string;
  };
  automationTag: string;
}

export type WorkflowAgentDecision =
  | "create_pr"
  | "revise_pr"
  | "reply_only"
  | "noop"
  | "error";

export interface WorkflowAgentResult {
  decision: WorkflowAgentDecision;
  summary: string;
  repository?: {
    owner?: string;
    repo?: string;
    baseBranch?: string;
    branch?: string;
  };
  pullRequest?: {
    number?: number;
    url?: string;
    headSha?: string;
  };
  reviewApp?: {
    url?: string | null;
  };
  monday?: {
    postedUpdate?: boolean;
    updateSummary?: string;
  };
  metadata?: Record<string, unknown>;
}
