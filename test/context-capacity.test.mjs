import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/names.mjs";
import { estimateTextTokens } from "../src/core/lifecycle.mjs";

function acpConfig({
  capacityTokens = 65536,
  reserveTokens = 4096,
  hardRatio,
} = {}) {
  const cfg = config(1);
  cfg.backends[0] = {
    ...cfg.backends[0],
    type: "antigravity",
    cliProtocol: "acp",
  };
  cfg.agents[0].contextPolicy = {
    ...cfg.agents[0].contextPolicy,
    capacityTokens,
    reserveTokens,
    ...(hardRatio ? { hardRatio } : {}),
  };
  return cfg;
}

function acpFixture(t, options = {}) {
  const f = fixture(t, { ...options, cfg: options.cfg || acpConfig() });
  const factory = f.runtime.backendFactory;
  f.runtime.backendFactory = (...args) => ({
    ...factory(...args),
    config: { type: "antigravity", cliProtocol: "acp" },
  });
  return f;
}

test("fallback token estimate compresses ordinary ASCII and preserves UTF-16 and opaque runs", () => {
  const english = "The quick brown fox jumps over the lazy dog.";
  const json = JSON.stringify({
    enabled: true,
    user_name: "Alice",
    count: 123,
  });
  assert.ok(estimateTextTokens(english) < english.length);
  assert.ok(estimateTextTokens(json) < json.length);

  const nonAscii = "中文，。😀!?";
  assert.equal(estimateTextTokens(nonAscii), nonAscii.length);

  const opaque = "opaque_" + "Q".repeat(40);
  assert.equal(estimateTextTokens(opaque), opaque.length);
  const numberedOpaque = "token_123456789012345";
  assert.equal(estimateTextTokens(numberedOpaque), numberedOpaque.length);
});

test("ACP estimate tracks original UTF-16 characters and compacted tokens", (t) => {
  const f = acpFixture(t),
    ctx = {};
  const first = "bridge_schema: short_ascii 中文😀";
  const second = "opaque_" + "A".repeat(40);
  f.runtime.contexts.estimate(ctx, first);
  f.runtime.contexts.estimate(ctx, second);
  assert.equal(ctx.estimatedAdded, first.length + second.length);
  assert.equal(
    ctx.estimatedTokens,
    estimateTextTokens(first) + estimateTextTokens(second),
  );
});

test("ACP full tool catalog at 65536 tokens keeps a continuous session across turns", async (t) => {
  const cfg = acpConfig({ capacityTokens: 65536 });
  cfg.agents[0].tools = [...TOOL_NAMES];
  let calls = 0,
    toolCount = 0;
  const f = acpFixture(t, {
    cfg,
    run: async (p) => {
      calls++;
      toolCount = p.tools.length;
      p.saveSession(
        p.session || { id: "acp-full-catalog", backend: "antigravity" },
      );
    },
  });
  const scope = "group:20000",
    memory = f.store.bind("agent-0");
  for (let turn = 0; turn < 3; turn++) {
    await f.runtime.wake("agent-0", scope);
    const state = memory.state(scope);
    assert.equal(state.session?.id, "acp-full-catalog");
    assert.notEqual(state.lifecycle.reason, "capacity-guard");
    assert.equal(state.usage.source, "estimated");
  }
  assert.equal(calls, 3);
  assert.ok(toolCount > 8);
});

for (const [label, content] of [
  ["Chinese text", "界，🙂".repeat(2000)],
  ["opaque ASCII", "OpaqueIdentifier".repeat(500)],
])
  test(`ACP still retires for genuinely oversized ${label}`, async (t) => {
    const cfg = acpConfig({
      capacityTokens: 4096,
      reserveTokens: 1024,
      hardRatio: 0.8,
    });
    const f = acpFixture(t, {
      cfg,
      run: async (p) => {
        p.saveSession({ id: "oversized-acp", backend: "antigravity" });
        const ctx = f.runtime.running.get("agent-0|group:20000");
        f.runtime.contexts.estimate(ctx, content);
      },
    });
    await f.runtime.wake("agent-0", "group:20000");
    const state = f.store.bind("agent-0").state("group:20000");
    assert.equal(state.session, null);
    assert.equal(state.lifecycle.reason, "capacity-guard");
  });

test("ACP image allowance stays full and old estimated occupancy is never divided", async (t) => {
  const capacityTokens = 2000000;
  const f = acpFixture(t, {
    cfg: acpConfig({ capacityTokens }),
    run: async (p) => {
      const ctx = f.runtime.running.get("agent-0|group:20000");
      expectedTextTokens = ctx.estimatedTokens;
      ctx.estimatedImageTokens = 4096;
      p.saveSession({ id: "acp-image-budget", backend: "antigravity" });
    },
  });
  const memory = f.store.bind("agent-0"),
    scope = "group:20000";
  memory.setState(scope, {
    ...memory.state(scope),
    usage: {
      source: "estimated",
      contextTokens: 30000,
      capacityTokens,
      at: 0,
    },
  });
  let expectedTextTokens = 0;
  await f.runtime.wake("agent-0", scope);
  assert.equal(
    memory.state(scope).usage.contextTokens,
    30000 + expectedTextTokens + 4096,
  );
});

test("ACP measured usage takes priority over text and image estimates", async (t) => {
  const f = acpFixture(t, {
    run: async (p) => {
      const ctx = f.runtime.running.get("agent-0|group:20000");
      ctx.estimatedImageTokens = 8192;
      p.saveSession({ id: "acp-measured", backend: "antigravity" });
      p.onUsage({
        source: "measured",
        contextTokens: 1234,
        capacityTokens: 65536,
      });
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  const usage = f.store.bind("agent-0").state("group:20000").usage;
  assert.equal(usage.source, "measured");
  assert.equal(usage.contextTokens, 1234);
});

test("late usage from a finished turn cannot force the next turn to retire a reusable session", async (t) => {
  let previous,
    calls = 0;
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      calls++;
      p.saveSession(
        p.session || { id: "kept-after-late-usage", backend: "fixture" },
      );
      if (calls === 1) {
        previous = p;
        p.onUsage({
          source: "measured",
          contextTokens: 1000,
          capacityTokens: 100000,
        });
      }
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  previous.onUsage({
    source: "measured",
    contextTokens: 99000,
    capacityTokens: 100000,
  });
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(
    f.store.bind("agent-0").state("group:20000").session?.id,
    "kept-after-late-usage",
  );
});

for (const scope of ["group:20000", "private:30000", "@subject"])
  test(`${scope} retains measured capacity when a later usage report omits it`, async (t) => {
    const cfg = config(1);
    cfg.agents[0].subject.enabled = true;
    cfg.agents[0].subject.sessionMode = "continuous";
    let calls = 0,
      compactions = 0;
    const f = fixture(t, {
      cfg,
      run: async (p) => {
        calls++;
        p.saveSession(p.session || { id: "kept", backend: "fixture" });
        p.onUsage({
          source: "measured",
          contextTokens: calls === 1 ? 60387 : 62251,
          ...(calls === 1 ? { capacityTokens: 1000000 } : {}),
        });
      },
    });
    await f.runtime.wake("agent-0", scope);
    f.runtime.backends.get("agent-0").compact = async () => {
      compactions++;
      return { requiresReinitialize: true };
    };
    await f.runtime.wake("agent-0", scope);
    const state = f.store.bind("agent-0").state(scope);
    assert.equal(compactions, 0);
    assert.equal(state.session?.id, "kept");
    assert.equal(state.usage.capacityTokens, 1000000);
    assert.equal(state.lifecycle.status, "active");
  });

test("continuous free time uses the same pressure thresholds as a chat", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.sessionMode = "continuous";
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.saveSession({ id: "organizing", backend: "fixture" });
      p.onUsage({
        source: "measured",
        contextTokens: 76000,
        capacityTokens: 100000,
      });
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  const state = f.store.bind("agent-0").state("@subject");
  assert.equal(state.lifecycle.status, "organizing");
  assert.equal(state.session?.id, "organizing");
});

test("an unmeasured turn keeps capacity, but a smaller reported window takes effect", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      calls++;
      p.saveSession(p.session || { id: "kept", backend: "fixture" });
      if (calls !== 2)
        p.onUsage({
          source: "measured",
          contextTokens: 62000,
          capacityTokens: calls === 1 ? 1000000 : 65536,
        });
    },
  });
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0"),
    scope = "private:30000";
  await f.runtime.wake("agent-0", scope);
  now += 1000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(m.state(scope).usage.source, "estimated");
  assert.equal(m.state(scope).usage.capacityTokens, 1000000);
  assert.equal(m.state(scope).session?.id, "kept");
  now += 1000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(m.state(scope).session, null);
  assert.equal(m.state(scope).lifecycle.reason, "capacity-guard");
  assert.equal(m.state(scope).usage, null);
});

test("free time retains its normal idle and hard pressure retirement guards", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  let tokens = 76000,
    now = Date.now();
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.saveSession({ id: "subject-context", backend: "fixture" });
      p.onUsage({
        source: "measured",
        contextTokens: tokens,
        capacityTokens: 100000,
      });
    },
  });
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  await f.runtime.wake("agent-0", "@subject");
  now += cfg.agents[0].contextPolicy.idleMs + 1;
  f.runtime.contexts.tick();
  assert.equal(m.state("@subject").lifecycle.reason, "idle-after-pressure");
  tokens = 90000;
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(m.state("@subject").lifecycle.reason, "capacity-guard");
});
