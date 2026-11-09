// @ts-check
import { execFileSync } from "node:child_process";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIMIT = 128 * 1024 * 1024;
/** Translate ACP into the existing supervisor's terminal protocol. The supervisor
 * still owns tool authorization, cancellation, session binding and send settlement.
 * @param {any} options @param {string} prompt
 * @param {(event: any) => void} emit @param {typeof crossSpawn} [launch]
 * @param {import("./session-contract.mjs").InputImage[]} [inputImages] */
export async function runAcp(
  options,
  prompt,
  emit,
  launch = crossSpawn,
  inputImages = [],
) {
  // Windows CLI installations expose .cmd shims. Use the argv-aware launcher
  // already used by headless instead of native spawn, which rejects those shims.
  const child = launch(
    options.command,
    [
      "--settings",
      options.settings,
      "acp",
      "--agent",
      "qq-agents",
      "--gemini-dir",
      options.profile,
      "--app-data-dir",
      "cli",
      "--include-default-customizations=false",
      "--disable-telemetry",
    ],
    {
      cwd: options.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let serial = 0,
    buffer = "",
    bytes = 0,
    closed = false;
  let activeSessionId = "",
    promptRequestId = 0,
    acceptingUsage = false;
  /** @type {{used: number, size: number} | undefined} */
  let contextUsage;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (
      process.platform === "win32" &&
      Number.isInteger(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        // A .cmd shim adds a wrapper; stopping only it would orphan the CLI.
        // Only this live, owned child may authorize termination of its tree.
        execFileSync(
          path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true, timeout: 10000 },
        );
        return;
      } catch {
        // Preserve the original fallback if Windows refuses tree termination.
      }
    }
    child.kill();
  };
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  const fail = () => {
    closed = true;
    acceptingUsage = false;
    for (const item of pending.values())
      item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
    pending.clear();
    stop();
  };
  child.once("error", fail);
  child.once("close", fail);
  child.stdin?.on("error", fail);
  child.stderr?.on("data", () => {}); // Provider diagnostics may contain private inputs.
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data) => {
    bytes += Buffer.byteLength(data);
    buffer += data;
    if (bytes > LIMIT) return fail();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== "2.0") throw Error();
        if (message.method && message.id !== undefined) {
          // Allow rules and the PreToolUse hook authorize bridge tools. Any
          // additional interactive permission or client filesystem request is denied.
          child.stdin?.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              ...(message.method === "session/request_permission"
                ? { result: { outcome: { outcome: "cancelled" } } }
                : {
                    error: {
                      code: -32601,
                      message: "Client capability unavailable",
                    },
                  }),
            }) + "\n",
          );
        } else if (message.method === "session/update") {
          const update = message.params?.update;
          if (
            acceptingUsage &&
            message.params?.sessionId === activeSessionId &&
            update?.sessionUpdate === "usage_update"
          )
            contextUsage =
              Number.isSafeInteger(update.used) &&
              update.used >= 0 &&
              Number.isSafeInteger(update.size) &&
              update.size > 0
                ? { used: update.used, size: update.size }
                : undefined;
        } else if (!message.method) {
          const item = pending.get(message.id);
          if (!item) throw Error();
          pending.delete(message.id);
          // Close the usage window in the parser: later frames in this same
          // stdout chunk must not replace the completed prompt's occupancy.
          if (message.id === promptRequestId) acceptingUsage = false;
          if (message.error) item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
          else if (message.result && typeof message.result === "object")
            item.resolve(message.result);
          else {
            item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
            fail();
          }
        }
      } catch {
        fail();
      }
    }
  });
  /** @param {string} method @param {any} params */
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      const id = ++serial;
      pending.set(id, { resolve, reject });
      if (method === "session/prompt") {
        promptRequestId = id;
        acceptingUsage = true;
        contextUsage = undefined;
      }
      child.stdin?.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const timer = setTimeout(fail, 660000);
  try {
    const init = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "qq-agents", version: "1" },
    });
    if (
      init.protocolVersion !== 1 ||
      init.agentCapabilities?.promptCapabilities?.image !== true ||
      (options.session && init.agentCapabilities?.loadSession !== true)
    )
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    const session = await request(
      options.session ? "session/load" : "session/new",
      {
        cwd: options.workspace,
        mcpServers: [
          {
            name: "qq-agents",
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./antigravity-mcp.mjs", import.meta.url)),
            ],
            env: ["QQ_AGY_ENDPOINT", "QQ_AGY_TOKEN"].map((name) => ({
              name,
              value: process.env[name] || "",
            })),
          },
        ],
        ...(options.session ? { sessionId: options.session } : {}),
      },
    );
    const id = options.session || session.sessionId;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || ""))
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    activeSessionId = id;
    if (options.model)
      await request("session/set_model", {
        sessionId: id,
        modelId: options.model,
      });
    if (options.effort)
      await request("session/set_config_option", {
        sessionId: id,
        configId: "thought_level",
        value: options.effort,
      });
    emit({ event: "init", conversation_id: id });
    const result = await request("session/prompt", {
      sessionId: id,
      prompt: [
        {
          type: "text",
          text: options.session
            ? "ACP session resumed: bridge tools are now exposed as mcp_qq-agents_<ToolName>. Use those exact native MCP names and their current schemas instead of call_mcp_tool. Authorization is still limited to the current bridge catalogue.\n\n" +
              prompt
            : prompt,
        },
        ...inputImages.flatMap((image) => [
          { type: "text", text: image.label },
          ...(image.data
            ? [{ type: "image", mimeType: image.mimeType, data: image.data }]
            : []),
        ]),
      ],
    });
    if (closed || result.stopReason !== "end_turn")
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    // Only session usage_update describes current occupancy. Prompt-result
    // usage sums inferences and must never substitute for missing telemetry.
    emit({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 0,
        state: "DONE",
        step_type: "agent_response",
        ...(contextUsage ? { usage: contextUsage } : {}),
      },
    });
    emit({
      event: "result",
      result: { conversation_id: id, status: "SUCCESS" },
    });
  } finally {
    clearTimeout(timer);
    child.stdin?.end();
    stop();
  }
}

async function main() {
  let input = "";
  for await (const part of process.stdin) {
    input += part;
    if (Buffer.byteLength(input) > LIMIT)
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
  }
  const message = JSON.parse(input);
  if (message.event !== "user" || typeof message.message?.content !== "string")
    throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
  await runAcp(
    JSON.parse(process.argv[2]),
    message.message.content,
    (event) => process.stdout.write(JSON.stringify(event) + "\n"),
    undefined,
    message.message.inputImages || [],
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("ANTIGRAVITY_PROTOCOL_ERROR\n");
    process.exitCode = 1;
  });
