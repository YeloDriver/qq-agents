import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { config, fixture, context, FakeTransport } from "./helpers.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { mcpEntrySpecs, scopedCatalog } from "../src/tools/catalog.mjs";
import { identityAnchors, stableInstructions } from "../src/core/prompts.mjs";

test("QQ delivery and style rules reach both chat scopes without worked examples or subject send instructions", async (t) => {
  for (const type of ["codex", "dsh"]) {
    const cfg = config(1),
      captured = [];
    cfg.backends[0].type = type;
    cfg.agents[0].subject.enabled = true;
    cfg.agents[0].contextPolicy.capacityTokens = 65536;
    const { runtime } = fixture(t, {
      cfg,
      run: async (p) => captured.push(p),
    });
    for (const scope of ["private:30000", "group:20000", "@subject"])
      await runtime.wake("agent-0", scope);
    assert.equal(captured.length, 3);
    for (const p of captured.slice(0, 2)) {
      assert.match(p.instructions, /简单闲聊不用列表、教程或总结升华/);
      assert.match(p.instructions, /专业问题、复杂推理或明确要求可以充分展开/);
      assert.match(p.instructions, /不脑补动机/);
      assert.match(p.instructions, /保留自然的主谓和必要衔接/);
      assert.match(p.instructions, /不机械添加助词/);
      assert.match(p.instructions, /仍可只说“嗯”“晚安”/);
      assert.match(p.instructions, /疑问和感叹正常使用问号、感叹号/);
      assert.doesNotMatch(
        p.instructions,
        /自然口语\/过度精简正误对照|以下占位情境|对方.*；过度精简/,
      );
      assert.match(p.instructions, /【QQ 投递协议】决定在当前 QQ 聊天回复时/);
      assert.match(
        p.instructions,
        /本回合已启用的 qq_send 或 qq_send_burst 投递正文/,
      );
      assert.match(p.instructions, /自然表达规则用于工具参数中的正文/);
      assert.match(p.instructions, /仍可选择不回复/);
      assert(
        p.instructions.indexOf("【QQ 投递协议】") <
          p.instructions.indexOf("当前 self v"),
      );
      assert.match(
        p.instructions,
        /能力和工具是否可用以当前工具目录与实际结果为准/,
      );
      assert.match(p.instructions, /普通 assistant 文本不会/);
      assert.match(p.instructions, /暂停、权限、限额和幂等账本/);
      assert.deepEqual(
        p.tools.find((tool) => tool.name === "qq_send"),
        toolSpecs(["qq_send"])[0],
      );
      if (type === "dsh") {
        assert.match(p.instructions, /bridge_tools/);
        assert.match(p.instructions, /bridge_call/);
        assert.match(p.instructions, /发现结果不是授权/);
      } else assert.match(p.instructions, /参数以 schema 为准/);
    }
    const subject = captured[2];
    assert.doesNotMatch(subject.instructions, /客观自然准则|QQ 投递协议/);
    assert.match(subject.instructions, /subject_log/);
    assert(!subject.tools.some((tool) => tool.name === "qq_send"));
  }
});

test("QQ style is absent from protected work and other internal instruction scopes", (t) => {
  const { runtime, store } = fixture(t, { cfg: config(1) });
  const a = runtime.agent("agent-0"),
    self = store.bind(a.id).identity.current();
  for (const scope of [
    "@subject",
    "@work",
    "@work:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "@operations",
    "privateish:30000",
    "",
  ]) {
    const contract = runtime.contexts.instructionContract(a, scope, self, [
      "framework_read",
    ]);
    assert.doesNotMatch(contract.instructions, /客观自然准则|QQ 投递协议/);
    assert.match(contract.instructions, /deployment_info、diagnostics_read/);
    assert.match(contract.instructions, /参数以 schema 为准/);
  }
});

test("a chat with the previous style-free instruction digest rebuilds before adopting the new style", async (t) => {
  const cfg = config(1),
    captured = [];
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "style-fixture", backend: "fixture" });
    },
  });
  const scope = "private:30000";
  await runtime.wake("agent-0", scope);
  const a = runtime.agent("agent-0"),
    memory = store.bind(a.id),
    self = memory.identity.current(),
    identity = identityAnchors(runtime.config, a);
  // Omitting the scope recreates the exact pre-style fixed instruction text.
  const previous = stableInstructions(
    a,
    self,
    false,
    memory.identity.anchors(a),
    {
      backendType: "codex",
      toolNames: runtime.toolsFor(a, scope),
      identity: {
        self: identity.self,
        administrators: identity.administrators,
      },
      dynamicPeers: true,
    },
  );
  assert.doesNotMatch(previous, /客观自然准则/);
  const previousHash = createHash("sha256").update(previous).digest("hex");
  memory.setState(scope, {
    ...memory.state(scope),
    loadedInstructionsHash: previousHash,
  });
  runtime.contexts.upgradeInstructions(a, self);
  assert.equal(memory.state(scope).loadedInstructionsHash, previousHash);
  await runtime.wake(a.id, scope);
  assert.equal(captured[1].session, null);
  assert.match(captured[1].instructions, /客观自然准则/);
  assert.equal(memory.identity.current().version, self.version);
  const history = memory.identity.list("session_history");
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, "identity-or-protocol-change");
});

test("chat delivery rules replace the previous worked examples with one safe session retirement", async (t) => {
  const cfg = config(1),
    captured = [];
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: `delivery-${captured.length}`, backend: "fixture" });
    },
  });
  const scope = "private:30000",
    memory = store.bind("agent-0");
  await runtime.wake("agent-0", scope);
  const originalSelf = memory.identity.current(),
    previousStyle = [
      "【自然口语/过度精简正误对照】",
      "日常口语保留自然的主谓和必要衔接，把话说完整，不压成电报式片段，也不机械添加助词。该短时仍可只说“嗯”“晚安”；短消息末尾没有必要就不加句号，疑问和感叹正常使用问号、感叹号。以下占位情境只演示完整自然的表达，不是固定话术，也不要求每次加长回复：",
      "对方说明天降温：自然“那明天出门多穿点，别冻着了”；过度精简“降温，多穿”",
      "对方下雨时没带伞：自然“那你先找个地方躲一下，等雨小了再走”；过度精简“找地躲雨，雨小再走”",
      "对方说忙完了：自然“忙完了？那现在能歇会儿了”；过度精简“忙完？可歇”",
      "对方说面煮得太软：自然“下次早点捞出来试试，应该会好一点”；过度精简“煮软，下次早捞”",
    ].join("\n"),
    previous = captured[0].instructions
      .replace(/【QQ 投递协议】[^\n]+\n\n/, "")
      .replace(/日常口语保留[^\n]+/, previousStyle),
    previousHash = createHash("sha256").update(previous).digest("hex");
  assert.doesNotMatch(previous, /QQ 投递协议/);
  assert.match(previous, /自然口语\/过度精简正误对照/);
  memory.setState(scope, {
    ...memory.state(scope),
    loadedInstructionsHash: previousHash,
  });
  runtime.contexts.upgradeInstructions(runtime.agent("agent-0"), originalSelf);
  assert.equal(memory.state(scope).loadedInstructionsHash, previousHash);
  await runtime.wake("agent-0", scope);
  assert.equal(captured[1].session, null);
  assert.match(captured[1].instructions, /QQ 投递协议/);
  assert.doesNotMatch(captured[1].instructions, /正误对照|对方.*；过度精简/);
  await runtime.wake("agent-0", scope);
  assert.equal(captured[2].session.id, "delivery-2");
  assert.deepEqual(memory.identity.current(), originalSelf);
  const history = memory.identity.list("session_history");
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, "identity-or-protocol-change");
});

test("Self and own accounts stay fixed while peer accounts refresh without rebuilding", async (t) => {
  const cfg = config(2),
    captured = [];
  // This tests session continuity, independently of estimated capacity guards.
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  cfg.agents[0].persona = "我喜欢倾听，也会开玩笑。";
  cfg.agents[0].appearance = "固定形象";
  cfg.agents[0].ownerIds = ["30000"];
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  store
    .bind("agent-0")
    .identity.adminEdit(
      { body: "我最近更喜欢读书。", reason: "管理员调整", expectedVersion: 1 },
      runtime.now(),
    );
  await runtime.wake("agent-0", "group:20000");
  for (const p of captured) {
    assert.match(p.instructions, /10000/);
    assert.doesNotMatch(p.instructions, /10001/);
    assert.match(p.prompt, /10001/);
    assert.match(p.instructions, /30000/);
    assert.match(p.instructions, /senderId/);
  }
  assert.match(captured[1].instructions, /self v2/);
  assert.equal(captured[1].session, null);
  assert.equal(store.bind("agent-0").identity.history().length, 2);
  const next = structuredClone(runtime.config);
  next.connections[1].accountId = "10009";
  await runtime.changeConfig(next, runtime.configStore.revision);
  // changeConfig closes transports; restore only the local fake connection.
  runtime.transports.set("qq-0", new FakeTransport());
  await runtime.wake("agent-0", "group:20000");
  assert.match(captured[2].prompt, /10009/);
  assert.doesNotMatch(captured[2].prompt, /10001/);
  assert.equal(captured[2].instructions, captured[1].instructions);
  assert.equal(captured[2].session.id, "fixture");
});

test("Codex receives no capability secret while DSH receives only its scoped bridge-entry contract", async (t) => {
  for (const type of ["codex", "dsh"]) {
    const cfg = config(1);
    cfg.backends[0].type = type;
    const captured = [];
    const { runtime } = fixture(t, { cfg, run: async (p) => captured.push(p) });
    await runtime.wake("agent-0", "group:20000");
    const p = captured[0];
    assert(
      !p.tools.find((t) => t.name === "qq_send").inputSchema.properties.context,
    );
    if (type === "codex") assert.doesNotMatch(p.prompt, /context=/);
    else {
      assert.match(p.prompt, /context=[A-Za-z0-9_-]+/);
      assert.match(p.instructions, /bridge_tools/);
      assert.match(p.instructions, /bridge_call/);
    }
  }
});

test("subject continuation has a fresh clock without chat acknowledgements, waits, or duplicate Self", async (t) => {
  const cfg = config(1),
    a = cfg.agents[0],
    captured = [];
  a.persona = "独特的稳定性格";
  a.subject.enabled = true;
  a.tools.push("qq_wait_for_messages", "qq_set_wake_config");
  const { runtime } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "subject-fixture", backend: "fixture" });
    },
  });
  let now = Date.parse("2030-04-08T09:00:00Z");
  runtime.clock = () => new Date(now);
  await runtime.wake(a.id, "@subject");
  now += 86400000;
  await runtime.wake(a.id, "@subject");
  for (const p of captured) {
    assert.doesNotMatch(p.instructions, /qq_mark_read|qq_wait_for_messages/);
    assert.doesNotMatch(p.prompt, /潜水前观察/);
    assert(!p.tools.some((t) => t.name === "qq_send"));
  }
  assert.match(captured[1].prompt, /2030-04-09T09:00:00.000Z/);
  assert(captured[1].prompt.includes(String(now)));
  assert.match(captured[1].prompt, /Asia\/Shanghai/);
  assert.doesNotMatch(captured[1].prompt, /独特的稳定性格/);
});

test("scoped discovery hides forbidden tools and never grants execution, including stale catalogues", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  const { runtime } = fixture(t, { cfg }),
    chat = context(runtime),
    subject = context(runtime, "agent-0", "@subject");
  assert.deepEqual(
    mcpEntrySpecs().map((x) => x.name),
    ["bridge_tools", "bridge_call"],
  );
  const schema = scopedCatalog(runtime, chat, { names: ["qq_send"] });
  assert(!schema.tools[0].inputSchema.properties.context);
  assert.throws(
    () => scopedCatalog(runtime, subject, { names: ["qq_send"] }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(subject, "qq_send", { requestId: "no-send", text: "x" }),
    /TOOL_DISABLED/,
  );
  await runtime.pause("all", true);
  assert.throws(() => scopedCatalog(runtime, chat, {}), /PAUSED/);
});

test("legacy platform readers cannot bypass App configuration even with a stale allowedTools set", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push(
    "social_search",
    "social_read",
    "social_comments",
    "app_search",
  );
  const { runtime } = fixture(t, { cfg });
  const ctx = context(runtime);
  ctx.allowedTools = ["social_search"];
  let calls = 0;
  runtime.social = {
    perform: async () => {
      calls++;
      return {};
    },
  };
  assert(
    !runtime
      .toolsFor(runtime.agent("agent-0"), ctx.conversation)
      .includes("social_search"),
  );
  await assert.rejects(
    runtime.callTool(ctx, "social_search", {
      platform: "bilibili",
      query: "x",
    }),
    /TOOL_DISABLED/,
  );
  assert.equal(calls, 0);
});

test("catalogue respects scheduler and App feature switches and administrator source", (t) => {
  const cfg = config(1),
    a = cfg.agents[0];
  a.ownerIds = ["30000"];
  a.tools.push(
    "qq_schedule_create",
    "app_search",
    "app_capabilities",
    "app_share_send",
  );
  const { runtime } = fixture(t, { cfg });
  assert(!runtime.toolsFor(a, "private:30000").includes("qq_schedule_create"));
  a.scheduler.enabled = true;
  assert(runtime.toolsFor(a, "private:30000").includes("qq_schedule_create"));
  assert(!runtime.toolsFor(a, "group:20000").includes("qq_schedule_create"));
  assert(!runtime.toolsFor(a, "private:30000").includes("app_search"));
  a.apps.enabled = true;
  a.apps.sharing = false;
  assert(runtime.toolsFor(a, "private:30000").includes("app_search"));
  assert(!runtime.toolsFor(a, "private:30000").includes("app_share_send"));
  assert(
    toolSpecs(runtime.toolsFor(a, "private:30000")).every(
      (t) => !t.name.startsWith("social_"),
    ),
  );
});

test("chat and idle time both ask for views that hold under pushback and change only with a reason", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, { enabled: true, groups: ["20000"] });
  const captured = [];
  const { runtime } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "@subject");
  assert.equal(captured.length, 2);
  for (const p of captured) {
    assert.match(p.instructions, /分清事实和喜好/);
    assert.match(p.instructions, /别人反对不等于你错了/);
    assert.match(p.instructions, /之前为什么那么想/);
  }
});

test("reaction expression advice is chat-only and requires an offered reaction tool", async () => {
  const { stableInstructions } = await import("../src/core/prompts.mjs");
  const a = config(1).agents[0],
    self = { version: 1, body: "平时说话简短" };
  const without = stableInstructions(
    a,
    self,
    false,
    {},
    { toolNames: ["qq_send"] },
  );
  const withReaction = stableInstructions(
    a,
    self,
    false,
    {},
    { toolNames: ["qq_send", "qq_react"] },
  );
  const subject = stableInstructions(
    a,
    self,
    true,
    {},
    { toolNames: ["qq_react"] },
  );
  assert.doesNotMatch(without, /有时贴个表情就够了/);
  assert.match(withReaction, /有时贴个表情就够了/);
  assert.doesNotMatch(subject, /有时贴个表情就够了/);
});

test("chat tone protocol rebuilds an old stable contract once without editing Self", async (t) => {
  const { createHash } = await import("node:crypto");
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  cfg.agents[0].persona = "喜欢慢慢说话。\n\n说话样本：\n嗯，刚看到";
  const captured = [];
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "tone-fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  const mem = store.bind("agent-0"),
    state = mem.state("group:20000");
  assert.match(captured[0].instructions, /Self 的说话样本/);
  assert.match(captured[0].instructions, /闲聊通常一两句/);
  assert.match(captured[0].instructions, /不必每条都以问题结尾/);
  const old = captured[0].instructions
    .split("\n")
    .filter((line) => !line.startsWith("QQ 聊天按当前 Self"))
    .join("\n");
  mem.setState("group:20000", {
    ...state,
    loadedInstructionsHash: createHash("sha256").update(old).digest("hex"),
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "group:20000");
  assert.equal(captured[1].session, null);
  assert.equal(captured[2].session.id, "tone-fixture");
  assert.equal(mem.identity.history().length, 1);
  const current = mem.identity.current();
  mem.identity.initialize(
    { ...runtime.agent("agent-0"), persona: "新模板\n\n说话样本：另外的句子" },
    runtime.now(),
  );
  assert.deepEqual(mem.identity.current(), current);
});

test("positive silence and derived familiarity update the protocol once without rewriting Self", async (t) => {
  const { createHash } = await import("node:crypto");
  const cfg = config(1),
    captured = [];
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "silence-fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  const instruction = captured[0].instructions;
  assert.match(instruction, /不回、简短接一句、让话题自然结束/);
  assert.match(instruction, /已读不回也很自然/);
  assert.match(instruction, /不通过假装没看见或故意记错/);
  assert.match(instruction, /不改变权限、白名单、冷却或预算/);
  const memory = store.bind("agent-0"),
    state = memory.state("group:20000"),
    self = memory.identity.current();
  const old = instruction.replace(
    /人物卡和空闲素材里的 interaction[^\n]*/g,
    "旧聊天协议",
  );
  memory.setState("group:20000", {
    ...state,
    loadedInstructionsHash: createHash("sha256").update(old).digest("hex"),
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "group:20000");
  assert.equal(captured[1].session, null);
  assert.equal(captured[2].session.id, "silence-fixture");
  assert.deepEqual(memory.identity.current(), self);
});

test("silence follows reaction configuration and the currently offered read tool", async (t) => {
  const { stableInstructions } = await import("../src/core/prompts.mjs");
  const { runtime } = fixture(t),
    agent = runtime.agent("agent-0"),
    self = { version: 1, body: "测试人格" };
  agent.tools.push("qq_react");
  for (const setting of [undefined, false, true]) {
    if (setting === undefined) delete agent.behavior.actions.react;
    else agent.behavior.actions.react = setting;
    const names = runtime.toolsFor(agent, "group:20000");
    const instructions = stableInstructions(
      agent,
      self,
      false,
      {},
      { toolNames: names },
    );
    assert.equal(names.includes("qq_react"), setting === true);
    if (setting === true) {
      assert.match(instructions, /不回、只贴表情、简短接一句、让话题自然结束/);
      assert.match(instructions, /有时贴个表情就够了/);
    } else {
      assert.match(instructions, /不回、简短接一句、让话题自然结束/);
      assert.doesNotMatch(instructions, /只贴表情|有时贴个表情/);
    }
    assert.doesNotMatch(instructions, /只贴表情包|发个表情包/);
  }
  const noRead = stableInstructions(
    agent,
    self,
    false,
    {},
    { toolNames: ["qq_react"] },
  );
  assert.doesNotMatch(noRead, /读完后可以用 qq_mark_read/);
  const withRead = stableInstructions(
    agent,
    self,
    false,
    {},
    { toolNames: ["qq_mark_read"] },
  );
  assert.match(withRead, /读完后可以用 qq_mark_read/);
});
