export interface MondayNormalizedEvent {
  eventId: string | null;
  type: string;
  itemId: string | null;
  boardId: string | null;
  columnId: string | null;
  statusLabel: string | null;
  commentBody: string | null;
  raw: unknown;
}

export interface MondayWebhookEnvelope {
  challenge?: string;
  event?: MondayNormalizedEvent;
}

export function normalizeMondayWebhook(payload: unknown): MondayWebhookEnvelope {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const asRecord = payload as Record<string, unknown>;
  const challenge = readString(asRecord, ["challenge"]);
  if (challenge) {
    return { challenge };
  }

  const rawEvent = (asRecord.event as Record<string, unknown> | undefined) ?? asRecord;
  const type =
    readString(rawEvent, ["type"]) ??
    readString(rawEvent, ["trigger", "outputFields", "eventType"]) ??
    "unknown";

  const value = readRecord(rawEvent, ["value"]);
  const statusLabel =
    readString(value, ["label", "text"]) ??
    readString(value, ["label"]) ??
    readString(value, ["text"]);

  const event: MondayNormalizedEvent = {
    eventId:
      readString(rawEvent, ["eventId"]) ??
      readString(rawEvent, ["event_id"]) ??
      readString(rawEvent, ["id"]) ??
      readString(rawEvent, ["triggerUuid"]) ??
      readString(rawEvent, ["trigger_uuid"]) ??
      readString(rawEvent, ["subscriptionId"]) ??
      readString(rawEvent, ["subscription_id"]) ??
      null,
    type,
    itemId:
      readString(rawEvent, ["pulseId"]) ??
      readString(rawEvent, ["pulse_id"]) ??
      readString(rawEvent, ["itemId"]) ??
      readString(rawEvent, ["item_id"]) ??
      readString(rawEvent, ["parentItemId"]) ??
      null,
    boardId:
      readString(rawEvent, ["boardId"]) ??
      readString(rawEvent, ["board_id"]) ??
      readString(rawEvent, ["board", "id"]) ??
      null,
    columnId:
      readString(rawEvent, ["columnId"]) ??
      readString(rawEvent, ["column_id"]) ??
      null,
    statusLabel,
    commentBody:
      readString(value, ["body"]) ??
      readString(value, ["text"]) ??
      readString(rawEvent, ["textBody"]) ??
      readString(rawEvent, ["text_body"]) ??
      null,
    raw: payload
  };

  return { event };
}

export function isItemCreatedEvent(eventType: string): boolean {
  return ["create_pulse", "create_item", "item_created"].includes(eventType);
}

export function isCommentEvent(eventType: string): boolean {
  return ["create_update", "new_update", "item_comment"].includes(eventType);
}

export function isColumnChangeEvent(eventType: string): boolean {
  return ["change_column_value", "update_column_value", "column_value_changed"].includes(
    eventType
  );
}

function readString(obj: Record<string, unknown> | undefined, path: string[]): string | null {
  if (!obj) {
    return null;
  }
  let cursor: unknown = obj;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null) {
    return null;
  }
  return String(cursor);
}

function readRecord(
  obj: Record<string, unknown> | undefined,
  path: string[]
): Record<string, unknown> | undefined {
  if (!obj) {
    return undefined;
  }
  let cursor: unknown = obj;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (!cursor || typeof cursor !== "object") {
    return undefined;
  }
  return cursor as Record<string, unknown>;
}
