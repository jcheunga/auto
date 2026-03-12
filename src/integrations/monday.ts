import { appLogger } from "../lib/appLogger";
import { serializeError } from "../lib/logger";
import { MondayThreadEntry } from "../types";

interface MondayGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

interface MondayBasicItemQueryData {
  items: Array<{
    id: string;
    name: string;
    board: { id: string };
  }>;
}

interface MondayItemContextQueryData {
  items: Array<{
    id: string;
    name: string;
    board: { id: string };
    updates: Array<{
      id: string;
      body: string | null;
      text_body: string | null;
      created_at: string | null;
      creator: {
        id: string | null;
        name: string | null;
      } | null;
      replies: Array<{
        id: string;
        body: string | null;
        text_body: string | null;
        created_at: string | null;
        creator: {
          id: string | null;
          name: string | null;
        } | null;
      }>;
    }>;
  }>;
}

export interface MondayItemBasics {
  itemId: string;
  boardId: string;
  title: string;
}

export interface MondayItemContext extends MondayItemBasics {
  thread: MondayThreadEntry[];
}

export class MondayClient {
  private readonly logger = appLogger.child({ component: "monday" });

  constructor(
    private readonly apiToken: string,
    private readonly apiUrl: string
  ) {}

  async getItemBasics(itemId: string): Promise<MondayItemBasics> {
    this.logger.info("Fetching Monday item basics", { itemId });

    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          board {
            id
          }
        }
      }
    `;

    const result = await this.graphql<MondayBasicItemQueryData>(query, { itemId });
    const item = result.items[0];
    if (!item) {
      this.logger.warn("Monday item not found", { itemId });
      throw new Error(`Monday item ${itemId} not found`);
    }

    this.logger.info("Fetched Monday item basics", {
      itemId,
      boardId: item.board.id,
      title: item.name
    });

    return {
      itemId: item.id,
      boardId: item.board.id,
      title: item.name
    };
  }

  async postUpdate(itemId: string, body: string): Promise<void> {
    this.logger.info("Posting Monday update", {
      itemId,
      bodyLength: body.length
    });

    const query = `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
    `;

    await this.graphql(query, { itemId, body });
    this.logger.info("Posted Monday update", { itemId });
  }

  async getItemContext(itemId: string, updatesLimit = 50): Promise<MondayItemContext> {
    this.logger.info("Fetching Monday item context", {
      itemId,
      updatesLimit
    });

    const query = `
      query ($itemId: [ID!], $updatesLimit: Int!) {
        items(ids: $itemId) {
          id
          name
          board {
            id
          }
          updates(limit: $updatesLimit) {
            id
            body
            text_body
            created_at
            creator {
              id
              name
            }
            replies {
              id
              body
              text_body
              created_at
              creator {
                id
                name
              }
            }
          }
        }
      }
    `;

    const result = await this.graphql<MondayItemContextQueryData>(query, {
      itemId: [itemId],
      updatesLimit
    });

    const item = result.items[0];
    if (!item) {
      this.logger.warn("Monday item context not found", { itemId });
      throw new Error(`Monday item ${itemId} not found`);
    }

    const thread = item.updates.flatMap<MondayThreadEntry>((update) => {
      const updateEntry: MondayThreadEntry = {
        id: update.id,
        kind: "update",
        parentUpdateId: null,
        body: update.body ?? "",
        textBody: update.text_body ?? stripHtml(update.body ?? ""),
        createdAt: update.created_at,
        creatorId: update.creator?.id ?? null,
        creatorName: update.creator?.name ?? null
      };

      const replyEntries = update.replies.map<MondayThreadEntry>((reply) => ({
        id: reply.id,
        kind: "reply",
        parentUpdateId: update.id,
        body: reply.body ?? "",
        textBody: reply.text_body ?? stripHtml(reply.body ?? ""),
        createdAt: reply.created_at,
        creatorId: reply.creator?.id ?? null,
        creatorName: reply.creator?.name ?? null
      }));

      return [updateEntry, ...replyEntries];
    });

    thread.sort(compareThreadEntries);

    this.logger.info("Fetched Monday item context", {
      itemId,
      boardId: item.board.id,
      title: item.name,
      threadEntries: thread.length
    });

    return {
      itemId: item.id,
      boardId: item.board.id,
      title: item.name,
      thread
    };
  }

  private async graphql<TData>(query: string, variables?: Record<string, unknown>): Promise<TData> {
    const operation = inferOperationName(query);
    const startedAt = Date.now();

    this.logger.debug("Calling Monday GraphQL API", {
      operation,
      variableKeys: Object.keys(variables ?? {})
    });

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: this.apiToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Monday API request failed (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as MondayGraphqlResponse<TData>;
      if (payload.errors?.length) {
        throw new Error(`Monday API error: ${payload.errors.map((x) => x.message).join("; ")}`);
      }
      if (!payload.data) {
        throw new Error("Monday API returned no data");
      }

      this.logger.debug("Monday GraphQL call completed", {
        operation,
        durationMs: Date.now() - startedAt
      });

      return payload.data;
    } catch (error) {
      this.logger.error("Monday GraphQL call failed", {
        operation,
        durationMs: Date.now() - startedAt,
        ...serializeError(error)
      });
      throw error;
    }
  }
}

function inferOperationName(query: string): string {
  const match = query.match(/\b(query|mutation)\s*(\w+)?/i);
  if (match?.[2]) {
    return match[2];
  }
  if (match?.[1]) {
    return match[1].toLowerCase();
  }
  return "graphql";
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function compareThreadEntries(a: MondayThreadEntry, b: MondayThreadEntry): number {
  if (!a.createdAt && !b.createdAt) {
    return a.id.localeCompare(b.id);
  }
  if (!a.createdAt) {
    return -1;
  }
  if (!b.createdAt) {
    return 1;
  }
  return a.createdAt.localeCompare(b.createdAt);
}
