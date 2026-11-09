import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { temp } from "./helpers.mjs";
import { antigravityHookAllowed } from "../src/backends/antigravity-guard.mjs";
import { runAcp } from "../src/backends/antigravity-acp.mjs";
import { AntigravityMedia } from "../src/backends/antigravity-media.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { colorGrid } from "../scripts/fixtures/antigravity-media.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const options = {
  command: "synthetic",
  settings: "settings.json",
  workspace: process.cwd(),
  profile: "profile",
  model: "synthetic",
  effort: "low",
};
function fake(
  overrides = {},
  { beforePrompt = [], duringPrompt = [], afterPrompt = [] } = {},
) {
  const calls = [],
    replies = [];
  let killed = false;
  const writeLines = (child, lines) => {
    child.stdout.write(
      lines
        .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
        .join("\n") + "\n",
    );
  };
  const launch = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      return true;
    };
    child.stdin = new Writable({
      write(data, encoding, callback) {
        const msg = JSON.parse(String(data));
        if (!msg.method) {
          replies.push(msg);
          callback();
          return;
        }
        calls.push(msg);
        const defaults = {
          initialize: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true },
            },
          },
          "session/new": { sessionId: id },
          "session/load": {},
          "session/set_model": {},
          "session/set_config_option": {},
          "session/prompt": {
            stopReason: "end_turn",
            usage: { inputTokens: 999999 },
          },
        };
        const result = Object.hasOwn(overrides, msg.method)
          ? overrides[msg.method]
          : defaults[msg.method];
        queueMicrotask(() => {
          if (msg.method === "session/prompt") {
            const reply =
              typeof result === "string"
                ? result
                : JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    ...(result.error ? result : { result }),
                  });
            writeLines(child, [
              {
                jsonrpc: "2.0",
                id: "permission",
                method: "session/request_permission",
                params: {
                  options: [{ optionId: "allow", kind: "allow_once" }],
                },
              },
              {
                jsonrpc: "2.0",
                id: "file",
                method: "fs/read_text_file",
                params: { path: "private" },
              },
              ...duringPrompt,
              reply,
              ...afterPrompt,
            ]);
          } else if (msg.method === "session/set_config_option") {
            writeLines(child, [
              ...beforePrompt,
              {
                jsonrpc: "2.0",
                id: msg.id,
                ...(result.error ? result : { result }),
              },
            ]);
          } else {
            writeLines(child, [
              typeof result === "string"
                ? result
                : JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    ...(result.error ? result : { result }),
                  }),
            ]);
          }
        });
        callback();
      },
    });
    return child;
  };
  return { launch, calls, replies, killed: () => killed };
}
function usageUpdate(sessionId, used, size) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "usage_update", used, size },
    },
  };
}
test("ACP preserves the terminal contract, refuses client capabilities, and avoids cumulative occupancy", async () => {
  const f = fake(),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.equal(events[0].conversation_id, id);
  assert.equal(events.at(-1).result.status, "SUCCESS");
  assert.equal(events[1].step_update.usage, undefined);
  assert.deepEqual(f.calls.at(-1).params.prompt, [
    { type: "text", text: "synthetic prompt" },
  ]);
  assert.deepEqual(f.replies[0].result, { outcome: { outcome: "cancelled" } });
  assert.equal(f.replies[1].error.code, -32601);
  assert(f.killed());
});
test("ACP uses the last valid current-session usage update received during prompt", async () => {
  const otherSession = "22222222-2222-4222-8222-222222222222",
    f = fake(
      {},
      {
        beforePrompt: [usageUpdate(id, 100, 1000)],
        duringPrompt: [
          usageUpdate(id, 200, 1000),
          usageUpdate(otherSession, 900, 1000),
          usageUpdate(id, 230, 1000),
        ],
        // Kept in the same stdout write after the prompt response to exercise
        // notifications buffered behind the terminal response.
        afterPrompt: [usageUpdate(id, 999, 1000)],
      },
    ),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.deepEqual(
    events.find((e) => e.event === "step_update").step_update.usage,
    { used: 230, size: 1000 },
  );
});
test("ACP clears a valid usage update when the latest prompt update is null", async () => {
  const f = fake(
      {},
      {
        duringPrompt: [usageUpdate(id, 230, 1000), usageUpdate(id, null, 1000)],
      },
    ),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.equal(
    events.find((e) => e.event === "step_update").step_update.usage,
    undefined,
  );
});
test("ACP accepts zero usage as a measured value", async () => {
  const f = fake({}, { duringPrompt: [usageUpdate(id, 0, 1000)] }),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.deepEqual(
    events.find((e) => e.event === "step_update").step_update.usage,
    { used: 0, size: 1000 },
  );
});
test("ACP keeps usage above the reported window so the capacity guard can see it", async () => {
  const f = fake({}, { duringPrompt: [usageUpdate(id, 1200, 1000)] }),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.deepEqual(
    events.find((e) => e.event === "step_update").step_update.usage,
    { used: 1200, size: 1000 },
  );
});
for (const [name, used, size] of [
  ["negative used", -1, 1000],
  ["negative size", 1, -1],
  ["fractional used", 0.5, 1000],
  ["fractional size", 1, 1000.5],
  ["unsafe used", Number.MAX_SAFE_INTEGER + 1, 1000],
  ["unsafe size", 1, Number.MAX_SAFE_INTEGER + 1],
  ["string used", "10", 1000],
  ["string size", 1, "1000"],
  ["null used", null, 1000],
  ["null size", 1, null],
  ["zero size", 1, 0],
])
  test(`ACP ignores ${name} usage updates`, async () => {
    const f = fake({}, { duringPrompt: [usageUpdate(id, used, size)] }),
      events = [];
    await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
    assert.equal(
      events.find((e) => e.event === "step_update").step_update.usage,
      undefined,
    );
  });
test("ACP leaves usage absent when every update is from another session or outside prompt", async () => {
  const otherSession = "33333333-3333-4333-8333-333333333333",
    f = fake(
      {},
      {
        beforePrompt: [usageUpdate(id, 100, 1000)],
        duringPrompt: [usageUpdate(otherSession, 200, 1000)],
        afterPrompt: [usageUpdate(id, 300, 1000)],
      },
    ),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.equal(
    events.find((e) => e.event === "step_update").step_update.usage,
    undefined,
  );
});
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH" || error.code === "EINVAL") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !processAlive(pid);
}

async function cleanupOwnedFixture(pid) {
  if (!Number.isSafeInteger(pid) || !processAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The fixture may exit between the liveness check and the signal.
  }
  await waitForProcessExit(pid);
}

async function exerciseWindowsCmd(t, mode) {
  const root = temp(t),
    workspace = path.join(root, "workspace with spaces"),
    cliDirectory = path.join(root, "fake cli with spaces"),
    settings = path.join(workspace, "settings with spaces.json"),
    profile = path.join(workspace, "profile with spaces"),
    command = path.join(cliDirectory, "fake agent.cmd"),
    record = path.join(root, "fixture record.json"),
    fixturePath = fileURLToPath(
      new URL("./fixtures/antigravity-acp-cli.mjs", import.meta.url),
    );
  let fixturePid;
  t.after(async () => {
    if (!Number.isSafeInteger(fixturePid) && fs.existsSync(record))
      fixturePid = JSON.parse(fs.readFileSync(record, "utf8")).fixturePid;
    await cleanupOwnedFixture(fixturePid);
  });
  assert(workspace.includes(" "));
  assert(settings.includes(" "));
  assert(profile.includes(" "));
  assert(command.includes(" "));
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.mkdirSync(profile);
  fs.writeFileSync(settings, "{}\n");
  fs.writeFileSync(
    command,
    `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
  );

  const envNames = [
      "QQ_AGENTS_ACP_FIXTURE_RECORD",
      "QQ_AGENTS_ACP_FIXTURE_MODE",
      "QQ_AGENTS_ACP_FIXTURE_HOLD_MS",
    ],
    previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.QQ_AGENTS_ACP_FIXTURE_RECORD = record;
  process.env.QQ_AGENTS_ACP_FIXTURE_MODE = mode;
  process.env.QQ_AGENTS_ACP_FIXTURE_HOLD_MS = "30000";
  const events = [];
  try {
    const run = runAcp(
      { ...options, command, settings, workspace, profile },
      "synthetic prompt",
      (event) => events.push(event),
    );
    if (mode === "protocol-failure")
      await assert.rejects(run, /^Error: ANTIGRAVITY_PROTOCOL_ERROR$/);
    else await run;
  } finally {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const result = JSON.parse(fs.readFileSync(record, "utf8"));
  fixturePid = result.fixturePid;
  assert(Number.isSafeInteger(fixturePid));
  assert.equal(result.mode, mode);
  assert.deepEqual(result.argv, [
    "--settings",
    settings,
    "acp",
    "--agent",
    "qq-agents",
    "--gemini-dir",
    profile,
    "--app-data-dir",
    "cli",
    "--include-default-customizations=false",
    "--disable-telemetry",
  ]);
  assert.deepEqual(result.methods, [
    "initialize",
    "session/new",
    "session/set_model",
    "session/set_config_option",
    "session/prompt",
  ]);
  assert.equal(result.requests[1].params.cwd, workspace);
  assert.equal(result.requests[2].params.modelId, options.model);
  assert.equal(result.requests[3].params.value, options.effort);
  assert.deepEqual(result.requests.at(-1).params.prompt, [
    { type: "text", text: "synthetic prompt" },
  ]);
  assert.deepEqual(result.serverReplies, [
    { id: "permission", result: { outcome: { outcome: "cancelled" } } },
    {
      id: "file",
      error: { code: -32601, message: "Client capability unavailable" },
    },
  ]);
  if (mode === "success") {
    assert.equal(events[0].conversation_id, id);
    assert.equal(events.at(-1).result.status, "SUCCESS");
  } else {
    assert(!events.some((event) => event.event === "result"));
    assert.equal(await waitForProcessExit(fixturePid), true);
  }
  assert.equal(await waitForProcessExit(fixturePid), true);
}

test(
  "ACP cleans up the Windows cmd CLI tree after success and protocol failure",
  { skip: process.platform !== "win32" && "Windows cmd entry point" },
  async (t) => {
    await t.test("normal terminal", (subtest) =>
      exerciseWindowsCmd(subtest, "success"),
    );
    await t.test("protocol failure", (subtest) =>
      exerciseWindowsCmd(subtest, "protocol-failure"),
    );
  },
);
test("ACP resumes only the supplied session and sets the configured model and effort", async () => {
  const f = fake();
  await runAcp({ ...options, session: id }, "next", () => {}, f.launch);
  assert.equal(f.calls[1].method, "session/load");
  assert.equal(f.calls[1].params.sessionId, id);
  assert.equal(f.calls[2].params.modelId, "synthetic");
  assert.equal(f.calls[3].params.value, "low");
});
for (const [name, overrides] of Object.entries({
  missingVision: { initialize: { protocolVersion: 1, agentCapabilities: {} } },
  malformed: { "session/prompt": "not json" },
  missingResult: { "session/prompt": '{"jsonrpc":"2.0","id":5,"result":null}' },
  cancelled: { "session/prompt": { stopReason: "cancelled" } },
  refusedModel: {
    "session/set_model": {
      error: { code: -1, message: "private provider detail" },
    },
  },
}))
  test(`ACP fails closed for ${name} without a success terminal`, async () => {
    const f = fake(overrides),
      events = [];
    await assert.rejects(
      runAcp(options, "prompt", (e) => events.push(e), f.launch),
      /^Error: ANTIGRAVITY_PROTOCOL_ERROR$/,
    );
    assert(!events.some((e) => e.event === "result"));
    assert(f.killed());
  });
test("ACP image blocks retain pixels and frame metadata without granting native paths", () => {
  const media = new AntigravityMedia(undefined, true);
  const content = [
    { type: "text", text: '{"sampled":true,"frame":2}' },
    {
      type: "image",
      mimeType: "image/png",
      data: colorGrid(["blue", "red", "yellow", "green"]).toString("base64"),
    },
  ];
  const result = media.result({ content });
  assert.deepEqual(result.content, content);
  assert.deepEqual(media.catalog(), []);
  assert.equal(media.directory, null);
  assert.throws(
    () => media.result({ content, [mediaLease]: () => false }),
    /ANTIGRAVITY_TURN_INACTIVE/,
  );
  assert.throws(
    () => media.result({ content: [...Array(11)].map(() => content[1]) }),
    /ANTIGRAVITY_MEDIA_LIMIT/,
  );
  assert.throws(
    () =>
      media.result({ content: [{ ...content[1], mimeType: "image/jpeg" }] }),
    /ANTIGRAVITY_MEDIA_FORMAT/,
  );
  media.close();
  assert.throws(() => media.result({ content }), /ANTIGRAVITY_TURN_INACTIVE/);
});
test("ACP is opt-in and cannot be assigned to unrelated backends", () => {
  const config = {
    version: 1,
    mode: "isolated",
    agents: [],
    connections: [],
    backends: [{ id: "probe", type: "antigravity", label: "Probe" }],
  };
  assert.equal(validateConfig(config).backends[0].cliProtocol, undefined);
  assert.equal(
    validateConfig({
      ...config,
      backends: [{ ...config.backends[0], cliProtocol: "acp" }],
    }).backends[0].cliProtocol,
    "acp",
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      backends: [{ ...config.backends[0], type: "codex", cliProtocol: "acp" }],
    }),
  );
});

test("ACP native MCP aliases require exact server, tool and active catalogue", () => {
  const input = { toolCall: { name: "mcp_qq-agents_probe_image", args: {} } };
  const catalogue = {
    tools: [{ name: "probe_image" }],
    images: [],
    nativeMcp: true,
  };
  assert.equal(antigravityHookAllowed(input, catalogue), true);
  for (const denied of [
    { ...catalogue, nativeMcp: false },
    { ...catalogue, tools: [] },
  ])
    assert.equal(antigravityHookAllowed(input, denied), false);
  for (const name of [
    "mcp_other_probe_image",
    "mcp_qq-agents_probe_image_extra",
    "read_file",
    "run_command",
  ])
    assert.equal(
      antigravityHookAllowed({ toolCall: { name, args: {} } }, catalogue),
      false,
    );
});

test("ACP prompt includes labelled images directly without filesystem reads", async () => {
  const f = fake();
  await runAcp(options, "look", () => {}, f.launch, [
    {
      eventId: "fixture",
      index: 0,
      label: "picture",
      mimeType: "image/png",
      data: "cGl4ZWxz",
    },
  ]);
  assert.deepEqual(f.calls.at(-1).params.prompt, [
    { type: "text", text: "look" },
    { type: "text", text: "picture" },
    { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
  ]);
});
