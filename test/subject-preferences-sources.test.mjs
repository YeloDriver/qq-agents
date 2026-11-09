import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { subjectMaterials } from "../src/core/subject-materials.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";

test("reading references reject ordinary chat messages without creating a log", async (t) => {
  const { runtime, m, ctx } = setup(t);
  const message = m.append({
    dedupe: "not-a-reading",
    conversation: "private:30000",
    kind: "message.received",
    senderId: "30000",
    body: "只是聊天原文",
  });
  await assert.rejects(
    runtime.callTool(ctx, "subject_log", {
      did: "read",
      summary: "不能把聊天伪装成网页阅读",
      found: [{ title: "错误来源类型", sourceRecordId: message.id }],
    }),
    /SUBJECT_SOURCE_INVALID/,
  );
  assert.equal(
    m.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE agent_id=? AND kind='subject.log'",
      )
      .get(m.agentId).n,
    0,
  );
});

function setup(t) {
  const cfg = config(2),
    a = cfg.agents[0];
  a.subject.enabled = true;
  a.subject.users = ["30000"];
  a.subject.readTools = ["web_fetch"];
  a.tools.push(
    "web_fetch",
    "app_browse",
    "app_share_propose",
    "app_share_send",
    "app_read",
  );
  a.network.autonomous = true;
  a.apps = {
    ...a.apps,
    enabled: true,
    sharing: true,
    platforms: ["zhihu"],
    hours: { enabled: false },
  };
  const f = fixture(t, { cfg });
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [],
      perform: async () => ({
        items: [
          {
            title: "公开测试文章",
            url: "https://www.zhihu.com/question/123/answer/456",
            text: "合成的阅读正文",
          },
        ],
        coverage: "answer-text",
      }),
    },
    resolve: async (url) => ({ platform: "zhihu", url }),
  });
  return {
    ...f,
    m: f.store.bind("agent-0"),
    ctx: context(f.runtime, "agent-0", "@subject"),
  };
}

function preference(m, personId, body, revision) {
  const evidence = m.append({
    dedupe: "preference:" + body,
    conversation: "private:" + personId,
    kind: "message.received",
    senderId: personId,
    body,
  });
  return m.identity.savePersonItem(
    {
      personId,
      kind: "boundary",
      body,
      evidence: [evidence.id],
      ...(revision
        ? { id: revision.id, expectedRevision: revision.revision }
        : {}),
    },
    { writtenIn: "private:" + personId, now: Date.now() },
  );
}

test("free time carries complete current preferences for permitted private targets only", (t) => {
  const { runtime, m, ctx } = setup(t);
  const body = "欢迎有话题时主动找我，看到有关游戏的内容可以分享。".repeat(5);
  const item = preference(m, "30000", body);
  preference(m, "30001", "未获联系权限的另一个对象");
  const reach = subjectMaterials(runtime, ctx).reach;
  const target = reach.targets.find((x) => x.target === "private:30000");
  assert.equal(target.preferences[0].body, body);
  assert.equal(target.preferences[0].id, item.id);
  assert.equal(target.preferences[0].revision, 1);
  assert.deepEqual(target.preferences[0].evidence, item.evidence);
  assert.equal(target.preferences[0].fromPrivate, true);
  assert(!JSON.stringify(reach).includes("未获联系权限"));
  assert(ctx.privateRead.has(item.evidence[0]));
  assert.equal(m.identity.current().version, 1);
  assert.equal(m.identity.list("intentions").length, 0);
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  preference(m, "30000", "最近晚上不方便聊天", item);
  const next = subjectMaterials(runtime, ctx).reach.targets.find(
    (x) => x.target === target.target,
  );
  assert.equal(next.preferences[0].revision, 2);
  assert.equal(next.preferences[0].body, "最近晚上不方便聊天");
});

test("bounded preference presentation provides a continuation and filters restricted evidence", (t) => {
  const { runtime, m, ctx } = setup(t);
  for (let n = 0; n < 5; n++) preference(m, "30000", "相处偏好 " + n);
  const hidden = preference(m, "30000", "PRIVATE_PREFERENCE");
  const row = m.db
    .prepare("SELECT payload FROM events WHERE agent_id=? AND id=?")
    .get(m.agentId, hidden.evidence[0]);
  m.db
    .prepare("UPDATE events SET payload=? WHERE agent_id=? AND id=?")
    .run(
      JSON.stringify({ ...JSON.parse(row.payload), protectedOperations: true }),
      m.agentId,
      hidden.evidence[0],
    );
  const reach = subjectMaterials(runtime, ctx).reach;
  const target = reach.targets.find((x) => x.target === "private:30000");
  assert.equal(target.preferences.length, 3);
  assert.equal(target.morePreferences, 2);
  assert.deepEqual(target.preferencesRead, {
    tool: "person_items",
    personIds: ["30000"],
    kind: "boundary",
  });
  assert(!JSON.stringify(reach).includes("PRIVATE_PREFERENCE"));
  assert(!ctx.privateRead.has(hidden.evidence[0]));
  runtime.agent("agent-0").subject.users = [];
  assert.equal(subjectMaterials(runtime, ctx).reach.targets.length, 0);
});

test("reading logs retain actual App source references and report expiry without sending", async (t) => {
  const { runtime, m, ctx } = setup(t);
  const source = (
    await runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    })
  ).items[0];
  await runtime.callTool(ctx, "subject_log", {
    did: "read",
    summary: "读了一篇公开文章",
    found: [{ title: source.title, sourceRecordId: source.recordId }],
  });
  const material = subjectMaterials(runtime, ctx);
  assert.equal(material.lastLogs[0].found[0].sourceRecordId, source.recordId);
  assert.equal(material.lastLogs[0].found[0].sourceKind, "app");
  assert.equal(material.lastLogs[0].found[0].sourceStatus, "available");
  assert.equal(material.explore.webRead, true);
  assert(!JSON.stringify(material.lastLogs).includes("合成的阅读正文"));
  assert.equal(m.identity.list("intentions").length, 0);
  runtime.clock = () => new Date(Date.parse(source.fetchedAt) + 86400000);
  assert.equal(
    subjectMaterials(runtime, ctx).lastLogs[0].found[0].sourceStatus,
    "expired",
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});

test("source links cannot borrow another role's records or conceal restricted reading", async (t) => {
  const { runtime, m, ctx } = setup(t);
  const foreign = runtime.apps.record(context(runtime, "agent-1", "@subject"), {
    ok: true,
    title: "FOREIGN_TITLE",
    origin: "app-browser",
    platform: "zhihu",
  });
  const before = m.identity.list("model_turns").length;
  await assert.rejects(
    runtime.callTool(ctx, "subject_log", {
      did: "read",
      summary: "不可借用",
      found: [{ title: "FOREIGN_TITLE", sourceRecordId: foreign.recordId }],
    }),
    /RECORD_NOT_FOUND/,
  );
  const privateSource = runtime.apps.record(ctx, {
    ok: true,
    title: "PRIVATE_SOURCE",
    origin: "app-browser",
    platform: "zhihu",
    protectedOperations: true,
  });
  await assert.rejects(
    runtime.callTool(ctx, "subject_log", {
      did: "read",
      summary: "不可解除保护",
      found: [
        { title: "PRIVATE_SOURCE", sourceRecordId: privateSource.recordId },
      ],
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(m.identity.list("model_turns").length, before);
  assert.equal(
    m.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE agent_id=? AND kind='subject.log'",
      )
      .get(m.agentId).n,
    0,
  );
});

test("legacy missing and newly restricted references are withheld rather than invented", (t) => {
  const { runtime, m, ctx } = setup(t);
  const restricted = runtime.apps.record(ctx, {
    origin: "app-browser",
    platform: "zhihu",
    protectedOperations: true,
  });
  m.append({
    dedupe: "legacy-source-log",
    conversation: "@subject",
    kind: "subject.log",
    payload: {
      did: "read",
      summary: "旧日志",
      found: [
        { title: "PRIVATE_TITLE", sourceRecordId: restricted.recordId },
        { title: "MISSING_TITLE", sourceRecordId: "missing-fixture-source" },
        { title: "没有来源的旧标题" },
      ],
    },
  });
  const found = subjectMaterials(runtime, ctx).lastLogs[0].found;
  assert.deepEqual(found[0], { sourceStatus: "restricted" });
  assert.deepEqual(found[1], { sourceStatus: "unavailable" });
  assert.deepEqual(found[2], { title: "没有来源的旧标题" });
  assert(!JSON.stringify(found).includes("PRIVATE_TITLE"));
  assert(!ctx.privateRead.has(restricted.recordId));
});

test("ordinary webpage logs carry their reading reference into a normal contact intention", async (t) => {
  const { runtime, m, ctx } = setup(t);
  const page = m.append({
    dedupe: "web-source",
    conversation: "@subject",
    kind: "external.read",
    payload: {
      tool: "web_fetch",
      request: { url: "https://example.com/article" },
      truncated: true,
    },
    body: "合成网页读取结果",
  });
  await runtime.callTool(ctx, "subject_log", {
    did: "read",
    summary: "读到一个有趣观点",
    found: [{ title: "公开网页", sourceRecordId: page.id }],
  });
  const source = subjectMaterials(runtime, ctx).lastLogs[0].found[0];
  assert.equal(source.sourceKind, "web");
  assert.equal(source.readingScope, "truncated-web-result");
  const intention = await runtime.callTool(ctx, "intent_create", {
    topic: "网页里的一点新发现",
    target: "private:30000",
    evidence: [source.sourceRecordId],
    reason: "与对方关心的事有关",
    background: "只读到部分网页内容",
    expiresAt: runtime.now() + 3600000,
  });
  assert.deepEqual(intention.evidence, [page.id]);
  assert.equal(intention.status, "waiting");
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
