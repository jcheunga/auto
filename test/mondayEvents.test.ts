import test from "node:test";
import assert from "node:assert/strict";
import {
  isColumnChangeEvent,
  isCommentEvent,
  isItemCreatedEvent,
  normalizeMondayWebhook
} from "../src/lib/mondayEvents";

test("normalizeMondayWebhook surfaces challenge payloads", () => {
  const result = normalizeMondayWebhook({ challenge: "abc123" });
  assert.deepEqual(result, { challenge: "abc123" });
});

test("normalizeMondayWebhook extracts nested event data and replay markers", () => {
  const result = normalizeMondayWebhook({
    event: {
      __replayEventId: "replay-1",
      type: "create_update",
      pulseId: 123,
      boardId: 456,
      columnId: "status",
      value: {
        label: {
          text: "Approved"
        },
        body: "<p>Ship it</p>"
      },
      textBody: "Ship it"
    }
  });

  assert.ok(result.event);
  assert.equal(result.event?.eventId, "replay-1");
  assert.equal(result.event?.type, "create_update");
  assert.equal(result.event?.itemId, "123");
  assert.equal(result.event?.boardId, "456");
  assert.equal(result.event?.columnId, "status");
  assert.equal(result.event?.statusLabel, "Approved");
  assert.equal(result.event?.commentBody, "Ship it");
});

test("normalizeMondayWebhook falls back to top-level event shape and preserves raw payload", () => {
  const payload = {
    type: "change_column_value",
    itemId: 99,
    board: { id: 22 },
    value: { text: "In progress" }
  };

  const result = normalizeMondayWebhook(payload);
  assert.equal(result.event?.itemId, "99");
  assert.equal(result.event?.boardId, "22");
  assert.equal(result.event?.statusLabel, "In progress");
  assert.equal(result.event?.raw, payload);
});

test("event type helpers recognize supported Monday events", () => {
  assert.equal(isItemCreatedEvent("create_item"), true);
  assert.equal(isItemCreatedEvent("something_else"), false);
  assert.equal(isCommentEvent("new_update"), true);
  assert.equal(isCommentEvent("foo"), false);
  assert.equal(isColumnChangeEvent("column_value_changed"), true);
  assert.equal(isColumnChangeEvent("bar"), false);
});
