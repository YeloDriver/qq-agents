import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { localFileSymlinkSkip } from "../scripts/verify.mjs";
// Captured at load: some tests stub process.platform while their hooks run.
const windows = process.platform === "win32";
// Only the explicit local runner may mark a named link scenario unavailable.
export function fileSymlinkTest(t, fn, name = "file symbolic links") {
  return t.test(
    name,
    {
      skip: localFileSymlinkSkip({ platform: windows ? "win32" : "other" })
        ? "Windows EPERM confirmed by verify:local preflight; not exercised locally"
        : false,
    },
    fn,
  );
}
// Node's Fetch implementation rejects these ports even on loopback.
const fetchBlockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
export async function listenForFetch(app) {
  let port;
  for (let attempt = 0; attempt < 8; attempt++) {
    port = await app.listen();
    if (port > 0 && !fetchBlockedPorts.has(port)) return port;
    if (attempt === 7) {
      await app.close();
      throw new Error("test listener must use a fetch-compatible port");
    }
    await new Promise((resolve) => app.server.close(resolve));
  }
}
const leftovers = new Set();
process.once("exit", () => {
  for (const root of leftovers)
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: the OS temp directory is cleaned eventually.
    }
});
export function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-unified-test-"));
  // This hook runs before hooks registered later close the stores inside
  // root. Windows cannot delete open files, and a throw here would skip those
  // hooks and leave timers running, so retry at exit there instead.
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (!windows) throw error;
      leftovers.add(root);
    }
  });
  return root;
}
export function config(n = 3) {
  return validateConfig({
    version: 1,
    mode: "live",
    globalPaused: false,
    connections: Array.from({ length: n }, (_, i) => ({
      id: "qq-" + i,
      label: "Fixture " + i,
      accountId: String(10000 + i),
      httpUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      enabled: true,
    })),
    backends: [{ id: "fixture", type: "codex", label: "Fixture" }],
    agents: Array.from({ length: n }, (_, i) => ({
      id: "agent-" + i,
      name: "角色" + i,
      connectionId: "qq-" + i,
      backendId: "fixture",
      paused: false,
      allow: { groups: ["20000", "20001"], users: ["30000"] },
      wake: { participation: 1, cooldownMs: 0 },
      // Timing is tested with fake clocks; unrelated fixtures must not wait for typing.
      behavior: { typing: { enabled: false } },
      tools: [
        "memory_search",
        "memory_read",
        "conversation_read",
        "diary_write",
        "diary_revise",
        "qq_send",
        "qq_mark_read",
        "qq_set_silence",
      ],
      // Most fixtures exercise explicit, restricted permissions. Product
      // defaults are covered independently in capability-defaults.test.mjs.
      network: { autonomous: false },
      apps: { enabled: false, sharing: false, platforms: [] },
      files: { enabled: false },
      github: { enabled: false },
      scheduler: { enabled: false },
      voice: { tts: { enabled: false } },
      crossGroup: { enabled: false },
      operations: { enabled: false },
    })),
  });
}
export const raw = (id = 1, extra = {}) => ({
  post_type: "message",
  self_id: 10000,
  message_type: "group",
  group_id: 20000,
  user_id: 30000,
  message_id: id,
  time: 1800000000,
  message: [{ type: "text", data: { text: "约定下周见" } }],
  sender: { nickname: "Fixture" },
  ...extra,
});
export class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
    this.failure = null;
  }
  async connect() {
    this.connected = true;
  }
  close() {
    this.connected = false;
  }
  async send(conversation, segments) {
    this.sent.push({ conversation, segments });
    if (this.failure) throw Error(this.failure);
    return { messageId: String(40000 + this.sent.length) };
  }
}
export function fixture(t, { run = async () => {}, cfg = config() } = {}) {
  const root = temp(t),
    store = new MemoryStore(path.join(root, "memory.sqlite")),
    configStore = new ConfigStore(path.join(root, "config.json"), cfg);
  const backends = [];
  const runtime = new Runtime({
    memory: store,
    configStore,
    backendFactory: () => {
      const b = { run, cancel: async () => {}, close: async () => {} };
      backends.push(b);
      return b;
    },
    transportFactory: () => new FakeTransport(),
  });
  for (const c of cfg.connections)
    runtime.transports.set(c.id, new FakeTransport());
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  return { root, store, configStore, runtime, backends };
}
export async function settle(runtime) {
  await Promise.allSettled([...runtime.jobs]);
}
export function context(
  runtime,
  agentId = "agent-0",
  conversation = "group:20000",
) {
  return runtime.makeContext(agentId, conversation);
}
export function disclosureApproval(ctx, pending = ctx.disclosureRequest) {
  return {
    approvalId: pending.approvalId,
    agentId: ctx.agentId,
    conversation: ctx.conversation,
    ids: pending.records,
    ...(pending.requestId ? { requestId: pending.requestId } : {}),
  };
}
