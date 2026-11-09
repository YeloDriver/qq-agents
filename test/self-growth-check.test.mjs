import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, settle } from "./helpers.mjs";

const DAY = 86400000;

test("due candidates still reach a normal free-time turn between daily considerations", async (t) => {
  const prompts = [];
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      prompts.push(p.prompt);
    },
  });
  const now = Date.now();
  f.runtime.clock = () => new Date(now);
  const memory = f.store.bind("agent-0");
  memory.setState("@subject", {
    ...memory.state("@subject"),
    lastGrowthConsiderationAt: now - 1000,
    nextCheckAt: now - 1,
  });
  const source = memory.append({
    dedupe: "due-source",
    conversation: "group:20000",
    kind: "message.received",
    body: "独立的成长经历",
    senderId: "30000",
  });
  const candidate = memory.identity.propose(
    {
      body: "完整的合成 Self 修订",
      reason: "真实场景中的变化",
      scope: "interest",
      evidence: [source.id],
      expectedVersion: 1,
    },
    context(f.runtime),
    f.runtime.agent("agent-0").selfPolicy,
    now - DAY,
  );
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  assert(prompts[0].includes(candidate.id));
  assert.doesNotMatch(prompts[0], /growthConsideration=true/);
  assert.equal(memory.identity.current().version, 1);
});

function enabled() {
  const cfg = config(1),
    agent = cfg.agents[0];
  agent.subject.enabled = true;
  agent.subject.groups = ["20000"];
  agent.subject.intervalMs = 60000;
  agent.subject.maxChecksPerDay = 96;
  agent.behavior.preSleepWaitMs = 0;
  agent.contextPolicy.capacityTokens = 131072;
  return cfg;
}

test("growth consideration retries failed turns and is offered at most once per rolling day", async (t) => {
  const prompts = [];
  let now = Date.now(),
    fail = true;
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      prompts.push(p.prompt);
      if (fail) throw Error("fixture failure");
      p.saveSession({ id: `subject-${prompts.length}`, backend: "fixture" });
    },
  });
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  const advance = async (duration = 60001) => {
    now += duration;
    f.runtime.subject.tick();
    await settle(f.runtime);
  };

  f.runtime.subject.tick();
  await advance();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /growthConsideration=true/);
  assert.equal(m.state("@subject").lastGrowthConsiderationAt, undefined);

  fail = false;
  await advance();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /growthConsideration=true/);
  assert.equal(m.state("@subject").lastGrowthConsiderationAt, now);

  now += 60001;
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[2], /growthConsideration=true/);

  const recordedAt = m.state("@subject").lastGrowthConsiderationAt;
  now = recordedAt + DAY + 1;
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 4);
  assert.match(prompts[3], /growthConsideration=true/);
});

test("duplicate Self proposals reuse the active candidate after validating sources", (t) => {
  const { runtime, store } = fixture(t),
    memory = store.bind("agent-0"),
    first = memory.append({
      dedupe: "growth-evidence-1",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "独立经历一",
      occurredAt: "2026-10-01T00:00:00Z",
    }),
    second = memory.append({
      dedupe: "growth-evidence-2",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "独立经历二",
      occurredAt: "2026-10-02T00:00:00Z",
    }),
    counter = memory.append({
      dedupe: "growth-counter-1",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "相反观察",
      occurredAt: "2026-10-03T00:00:00Z",
    });
  const input = {
    body: "  更愿意主动延续共同话题。  ",
    reason: "多次经历支持这个变化",
    evidence: [first.id, second.id],
    counterEvidence: [counter.id],
    scope: "habit",
    expectedVersion: 1,
  };
  const original = memory.identity.propose(
    input,
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    100,
  );
  const duplicate = memory.identity.propose(
    {
      ...input,
      body: input.body.trim(),
      reason: "重试时理由不同不应重置候选",
      evidence: [...input.evidence].reverse(),
    },
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    200,
  );

  assert.deepEqual(duplicate, original);
  assert.equal(memory.identity.list("self_candidates").length, 1);
  assert.equal(
    duplicate.reviewAfter,
    100 + runtime.agent("agent-0").selfPolicy.majorDelayMs,
  );
  assert.equal(duplicate.revision, 1);

  const observed = memory.identity.review(
    {
      id: original.id,
      expectedRevision: original.revision,
      expectedVersion: original.baseVersion,
      action: "observe",
      reason: "继续观察",
    },
    { conversation: "@subject", turnStartedAt: 201 },
    runtime.agent("agent-0").selfPolicy,
    201,
  );
  const repeatedObserved = memory.identity.propose(
    input,
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    300,
  );
  assert.deepEqual(repeatedObserved, observed);
  assert.equal(repeatedObserved.reviewAfter, original.reviewAfter);
  assert.equal(repeatedObserved.revision, 2);
});

test("candidate deduplication includes counterevidence and preserves version conflicts", (t) => {
  const { runtime, store } = fixture(t),
    memory = store.bind("agent-0"),
    evidence = memory.append({
      dedupe: "growth-evidence",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "观察",
      occurredAt: "2026-10-01T00:00:00Z",
    }),
    counterA = memory.append({
      dedupe: "growth-counter-a",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "反例甲",
      occurredAt: "2026-10-02T00:00:00Z",
    }),
    counterB = memory.append({
      dedupe: "growth-counter-b",
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "反例乙",
      occurredAt: "2026-10-03T00:00:00Z",
    });
  const base = {
    body: "新的兴趣",
    reason: "记录变化",
    evidence: [evidence.id],
    scope: "interest",
    expectedVersion: 1,
  };
  const first = memory.identity.propose(
    { ...base, counterEvidence: [counterA.id] },
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    100,
  );
  const distinct = memory.identity.propose(
    { ...base, counterEvidence: [counterB.id] },
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    200,
  );
  assert.notEqual(distinct.id, first.id);

  memory.identity.adminEdit(
    { body: "更新后的 Self", reason: "test", expectedVersion: 1 },
    300,
  );
  assert.throws(
    () =>
      memory.identity.propose(
        { ...base, counterEvidence: [counterA.id] },
        context(runtime),
        runtime.agent("agent-0").selfPolicy,
        400,
      ),
    /SELF_VERSION_CONFLICT/,
  );
});
