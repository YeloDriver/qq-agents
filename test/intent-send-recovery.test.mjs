import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { timedDeliveryFailure } from "../src/core/message-timing-runtime.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

const requestId = "same-model-request";

function configured() {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.groups = ["20000"];
  return cfg;
}

function deliveryIds(memory) {
  return memory.db
    .prepare(
      "SELECT request_id FROM deliveries WHERE agent_id=? AND conversation=? ORDER BY request_id",
    )
    .all("agent-0", "group:20000")
    .map(({ request_id }) => request_id);
}

async function selectedIntentTurn(t, afterBlocked = async () => {}) {
  let f,
    item,
    blocked,
    blockedDeliveryIds,
    blockedSendCount,
    retry,
    calls = 0;
  f = fixture(t, {
    cfg: configured(),
    run: async (p) => {
      if (calls++) return;
      const current = f.store
        .bind("agent-0")
        .identity.get("intentions", item.id);
      await p.callTool("intent_decide", {
        id: item.id,
        expectedRevision: current.revision,
        action: "send",
        reason: "fixture intent",
      });
      try {
        blocked = await p.callTool("qq_send", {
          requestId,
          text: "synthetic proactive message",
          readThroughSeq: 0,
        });
      } catch (error) {
        blocked = safeToolFailure(error);
      }
      blockedDeliveryIds = deliveryIds(f.store.bind("agent-0"));
      blockedSendCount = f.runtime.transports.get("qq-0").sent.length;
      await afterBlocked(f, item);
      try {
        retry = await p.callTool("qq_send", {
          requestId,
          text: "synthetic proactive message",
        });
      } catch (error) {
        retry = safeToolFailure(error);
      }
    },
  });
  const ctx = context(f.runtime);
  item = f.runtime.subject.create(ctx, {
    topic: "synthetic proactive send",
    target: "group:20000",
    reason: "fixture intent",
    background: "",
    evidence: [],
    expiresAt: f.runtime.now() + 3600000,
    expectsResponse: false,
  });
  item = f.runtime.subject.transition(
    ctx.agentId,
    item,
    "handedoff",
    "fixture handoff",
  );
  await f.runtime.wake("agent-0", "group:20000", {
    reasons: [{ reason: "intent", intentId: item.id }],
  });
  return { f, item, blocked, blockedDeliveryIds, blockedSendCount, retry };
}

function assertCheckpointRejection(blocked) {
  assert.equal(blocked.code, "INTENT_READ_CHECKPOINT_NOT_ALLOWED");
  assert.match(blocked.hint, /this call sent nothing/i);
  assert.match(blocked.hint, /same requestId/);
  assert.match(blocked.hint, /pending or unknown/i);
}

test("selected intent retries once with the same requestId and leaves the read watermark unchanged", async (t) => {
  const { f, item, blocked, blockedDeliveryIds, blockedSendCount, retry } =
    await selectedIntentTurn(t);
  const memory = f.store.bind("agent-0");
  assertCheckpointRejection(blocked);
  assert.deepEqual(blockedDeliveryIds, []);
  assert.equal(blockedSendCount, 0);
  assert.equal(retry.status, "sent", JSON.stringify(retry));
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  assert.equal(memory.delivery("intent:" + item.id).status, "sent");
  const deliveryId = retry.requestId;
  assert.equal(typeof deliveryId, "string");
  assert.equal(retry.draft.items[0].requestId, deliveryId);
  assert.equal(memory.delivery(deliveryId).status, "sent");
  assert.deepEqual(deliveryIds(memory), [deliveryId]);
  assert.equal(memory.state("group:20000").readThroughSeq || 0, 0);
  assert.deepEqual(
    memory.state("group:20000").readCheckpointReceipts || {},
    {},
  );
  assert.equal(memory.state("@subject").contacts.length, 1);
});

const staleCases = [
  [
    "new input",
    async (f) => {
      await f.runtime.ingest("qq-0", raw(1));
    },
    "INTENT_STALE_REFRESH_REQUIRED",
  ],
  [
    "revoked target permission",
    async (f) => {
      f.runtime.agent("agent-0").subject.groups = [];
    },
    "INTENT_NO_LONGER_ALLOWED",
  ],
  [
    "role pause",
    async (f) => {
      f.runtime.agent("agent-0").paused = true;
    },
    "AGENT_PAUSED_OR_EXPIRED",
  ],
  [
    "expired intent",
    async (f, item) => {
      const memory = f.store.bind("agent-0");
      const current = memory.identity.get("intentions", item.id);
      memory.identity.put("intentions", {
        ...current,
        expiresAt: f.runtime.now() - 1,
      });
    },
    "INTENT_NO_LONGER_ALLOWED",
  ],
  [
    "contact cooldown",
    async (f) => {
      const memory = f.store.bind("agent-0");
      const state = memory.state("@subject");
      memory.setState("@subject", {
        ...state,
        lastContactAt: f.runtime.now(),
      });
    },
    "PROACTIVE_COOLDOWN",
  ],
];

for (const [name, change, expected] of staleCases) {
  test("same-requestId retry rechecks " + name, async (t) => {
    const { f, item, blocked, blockedDeliveryIds, blockedSendCount, retry } =
      await selectedIntentTurn(t, change);
    const memory = f.store.bind("agent-0");
    assertCheckpointRejection(blocked);
    assert.deepEqual(blockedDeliveryIds, []);
    assert.equal(blockedSendCount, 0);
    assert.equal(retry.code, expected, JSON.stringify(retry));
    assert.equal(memory.delivery("intent:" + item.id), undefined);
    assert.deepEqual(deliveryIds(memory), []);
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
    assert.equal(memory.state("group:20000").readThroughSeq || 0, 0);
    assert.equal(memory.state("@subject").contacts?.length || 0, 0);
  });
}

test("intent checkpoint rejection is measured as a policy block", () => {
  assert.equal(
    timedDeliveryFailure(new Error("INTENT_READ_CHECKPOINT_NOT_ALLOWED")),
    "policy-blocked",
  );
});
