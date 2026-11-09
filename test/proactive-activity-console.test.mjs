import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, listenForFetch } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function consoleFixture(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token, allowLive: true }),
    port = await listenForFetch(app);
  t.after(() => app.close());
  const api = async (route) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "x-admin-token": token },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...f, api };
}

function saveDelivery(memory, requestId, status, at, appShare = false) {
  memory.reserveDelivery(requestId, "group:20000", {
    type: appShare ? "app-share" : "message",
  });
  if (status !== "pending") memory.completeDelivery(requestId, status);
  const iso = new Date(at).toISOString();
  memory.db
    .prepare(
      "UPDATE deliveries SET created_at=?,updated_at=? WHERE agent_id=? AND request_id=?",
    )
    .run(iso, iso, memory.agentId, requestId);
  memory.append({
    dedupe: `send:${requestId}:pending`,
    connectionId: "qq-0",
    conversation: "group:20000",
    direction: "out",
    kind: "message.send-attempt",
    status: "pending",
    payload: {
      requestId,
      ...(appShare ? { appShare: { recordId: "app-record" } } : {}),
    },
  });
}

test("mind activity uses recent records and delivery receipts for send outcomes", async (t) => {
  const f = await consoleFixture(t),
    now = Date.now(),
    day = 86400000,
    memory = f.store.bind("agent-0");
  f.runtime.clock = () => new Date(now);

  memory.identity.put("model_turns", {
    id: "recent-read",
    conversation: "group:20000",
    startedAt: now - 3 * 3600000,
    status: "completed-no-send",
    toolCalls: [
      { name: "web_fetch", ok: true },
      { name: "app_browse", ok: true },
      { name: "app_read", ok: false, code: "APP_SOURCE_EXPIRED" },
    ],
  });
  memory.identity.put("model_turns", {
    id: "old-read",
    conversation: "group:20000",
    startedAt: now - 8 * day,
    status: "completed-no-send",
    toolCalls: [{ name: "web_fetch", ok: true }],
  });
  memory.identity.put("model_turns", {
    id: "completed-without-send-attempt",
    conversation: "group:20000",
    startedAt: now - 3600000,
    status: "completed-no-send",
    sentAt: now - 3600000,
    toolCalls: [],
  });
  memory.identity.put("model_turns", {
    id: "future-read",
    conversation: "group:20000",
    startedAt: now + 3600000,
    status: "completed-no-send",
    toolCalls: [{ name: "app_read", ok: true }],
  });
  f.store.bind("agent-1").identity.put("model_turns", {
    id: "another-agent-read",
    conversation: "group:20000",
    startedAt: now - 3600000,
    status: "completed-no-send",
    toolCalls: [{ name: "web_fetch", ok: true }],
  });
  memory.identity.put("model_turns", {
    id: "preflight-rejected-active-intent",
    conversation: "group:20000",
    startedAt: now - 4 * 3600000,
    status: "completed-no-send",
    activeIntent: "new-intent",
    toolCalls: [
      {
        name: "qq_send",
        ok: false,
        code: "INTENT_READ_CHECKPOINT_NOT_ALLOWED",
      },
    ],
  });
  memory.identity.put("model_turns", {
    id: "preflight-rejected-reason-intent",
    conversation: "group:20000",
    startedAt: now - 3 * 3600000,
    status: "completed-no-send",
    reason: [{ reason: "intent", intentId: "new-intent" }],
    toolCalls: [
      {
        name: "app_share_send",
        ok: false,
        code: "INTENT_READ_CHECKPOINT_NOT_ALLOWED",
      },
    ],
  });
  memory.identity.put("model_turns", {
    id: "outbox-failed-send",
    conversation: "group:20000",
    startedAt: now - 180000,
    endedAt: now - 120000,
    status: "completed-no-send",
    activeIntent: "rejected",
    toolCalls: [{ name: "qq_send", ok: false, code: "DELIVERY_FAILED" }],
  });
  memory.identity.put("model_turns", {
    id: "future-preflight-rejection",
    conversation: "group:20000",
    startedAt: now + 3600000,
    status: "completed-no-send",
    activeIntent: "new-intent",
    toolCalls: [
      {
        name: "qq_send",
        ok: false,
        code: "INTENT_READ_CHECKPOINT_NOT_ALLOWED",
      },
    ],
  });
  f.store.bind("agent-1").identity.put("model_turns", {
    id: "another-agent-preflight-rejection",
    conversation: "group:20000",
    startedAt: now - 3600000,
    status: "completed-no-send",
    activeIntent: "another-agent-intent",
    toolCalls: [
      {
        name: "qq_send",
        ok: false,
        code: "INTENT_READ_CHECKPOINT_NOT_ALLOWED",
      },
    ],
  });

  memory.identity.put("self_candidates", {
    id: "recent-candidate",
    createdAt: now - 2 * 3600000,
    reviewAfter: now - 3600000,
    status: "accepted",
    reviews: [{ action: "accept", at: now - 1800000 }],
  });
  memory.identity.put("self_candidates", {
    id: "old-candidate-recently-reviewed",
    createdAt: now - 9 * day,
    reviewAfter: now - 8 * day,
    status: "observing",
    reviews: [{ action: "observe", at: now - 2 * day }],
  });
  memory.identity.put("self_candidates", {
    id: "future-candidate",
    createdAt: now + 3600000,
    reviewAfter: now + 2 * 3600000,
    status: "pending",
    reviews: [{ action: "observe", at: now + 3 * 3600000 }],
  });
  f.store.bind("agent-1").identity.put("self_candidates", {
    id: "another-agent-candidate",
    createdAt: now - 3600000,
    reviewAfter: now - 1800000,
    status: "pending",
    reviews: [{ action: "observe", at: now - 900000 }],
  });

  memory.identity.put("intentions", {
    id: "new-intent",
    createdAt: now - 3 * 3600000,
    status: "cancelled",
    appShare: { recordId: "app-record" },
    history: [
      { status: "waiting", at: now - 3 * 3600000 },
      { status: "deferred", at: now - 2 * 3600000 },
      { status: "cancelled", at: now - 3600000 },
    ],
  });
  memory.identity.put("intentions", {
    id: "old-intent-recently-deferred",
    createdAt: now - 10 * day,
    status: "deferred",
    history: [
      { status: "waiting", at: now - 10 * day },
      { status: "deferred", at: now - 2 * day },
    ],
  });
  memory.identity.put("intentions", {
    id: "completed-no-send-sentAt-only",
    createdAt: now - 2 * 3600000,
    status: "completed",
    sentAt: now - 3600000,
    history: [{ status: "completed", at: now - 3600000 }],
  });
  memory.identity.put("intentions", {
    id: "future-intent",
    createdAt: now + 3600000,
    status: "waiting",
    history: [{ status: "waiting", at: now + 3600000 }],
  });
  f.store.bind("agent-1").identity.put("intentions", {
    id: "another-agent-intent",
    createdAt: now - 3600000,
    status: "cancelled",
    history: [{ status: "cancelled", at: now - 1800000 }],
  });
  memory.identity.put("intentions", {
    id: "rejected",
    createdAt: now - 3 * day,
    status: "failed",
    history: [
      { status: "waiting", at: now - 3 * day },
      { status: "failed", at: now - 120000 },
    ],
  });

  for (const [id, status, appShare = false, at = now - 120000] of [
    ["intent:confirmed", "sent"],
    ["intent:rejected", "failed"],
    ["intent:unknown", "unknown"],
    ["intent:pending", "pending"],
    ["app:confirmed", "sent", true],
    ["app:pending", "pending", true],
    ["app:unknown", "unknown", true],
    ["app:future-confirmed", "sent", true, now + 3600000],
    ["intent:old-confirmed", "sent", false, now - 8 * day],
  ])
    saveDelivery(memory, id, status, at, appShare);
  saveDelivery(
    f.store.bind("agent-1"),
    "app:another-agent-confirmed",
    "sent",
    now - 120000,
    true,
  );

  const data = await f.api("/api/mind?agentId=agent-0");
  assert.deepEqual(data.initiativeActivity.day.self, {
    proposed: 1,
    due: 1,
    reviewed: 1,
  });
  assert.deepEqual(data.initiativeActivity.week.self, {
    proposed: 1,
    due: 1,
    reviewed: 2,
  });
  assert.equal(data.initiativeActivity.day.reading.successful, 2);
  assert.equal(data.initiativeActivity.week.reading.successful, 2);
  assert.equal(data.initiativeActivity.day.sharing.proposed, 1);
  assert.equal(data.initiativeActivity.day.sharing.confirmed, 1);
  assert.equal(data.initiativeActivity.day.sharing.pending, 1);
  assert.equal(data.initiativeActivity.day.sharing.unknown, 1);
  assert.equal(data.initiativeActivity.day.intents.created, 2);
  assert.equal(data.initiativeActivity.day.intents.waiting, 1);
  assert.equal(data.initiativeActivity.day.intents.deferred, 1);
  assert.equal(data.initiativeActivity.day.intents.cancelled, 1);
  assert.equal(data.initiativeActivity.week.intents.deferred, 2);
  assert.equal(data.initiativeActivity.day.intents.confirmedSent, 1);
  assert.equal(data.initiativeActivity.day.intents.sendRejected, 2);
  assert.equal(data.initiativeActivity.day.intents.deliveryFailed, 1);
  assert.equal(data.initiativeActivity.day.intents.pending, 1);
  assert.equal(data.initiativeActivity.day.intents.unknown, 1);
});

test("tool chips separate safe failure codes and escape untrusted values", () => {
  const source = fs.readFileSync(
      new URL("../public/mind-ui.js", import.meta.url),
      "utf8",
    ),
    esc = (value) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[character],
      ),
    calls = [
      { name: "read_tool", ok: false, code: "APP_SOURCE_EXPIRED" },
      { name: "read_tool", ok: false, code: "APP_SOURCE_EXPIRED" },
      { name: "read_tool", ok: false, code: "APP_READ_DENIED" },
      { name: '<img src=x onerror="x">', ok: false, code: "APP_READ_DENIED" },
      { name: "read_tool", ok: false, code: '<img src=x onerror="x">' },
    ],
    sandbox = { esc, agentForm: { groups: [] } },
    rendered = vm.runInNewContext(
      `${source}\n({markup: toolCallsMarkup(${JSON.stringify(calls)}), oldMarkup: initiativeActivityMarkup(undefined, "self")})`,
      sandbox,
    );
  assert.equal(rendered.oldMarkup, "");
  const { markup } = rendered;
  assert.equal((markup.match(/class="mind-chip is-failed"/g) || []).length, 4);
  assert.match(markup, /APP_SOURCE_EXPIRED/);
  assert.match(markup, /APP_READ_DENIED/);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
});
