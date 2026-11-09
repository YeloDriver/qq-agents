import fs from "node:fs";

const recordPath = process.env.QQ_AGENTS_ACP_FIXTURE_RECORD;
if (!recordPath) process.exit(2);
const mode = process.env.QQ_AGENTS_ACP_FIXTURE_MODE || "success";
const holdMs = Number.parseInt(
  process.env.QQ_AGENTS_ACP_FIXTURE_HOLD_MS || "30000",
  10,
);

let buffer = "";
let promptId;
let recordedResult;
const requests = [];
const serverReplies = [];
const serverRequestIds = new Set(["permission", "file"]);

function saveRecord() {
  fs.writeFileSync(recordPath, JSON.stringify(recordedResult));
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function finishPrompt() {
  if (promptId === undefined || serverReplies.length !== serverRequestIds.size)
    return;
  // runAcp kills its child after receiving the terminal result, so persist the
  // observed argv and permission decisions before sending that result.
  recordedResult = {
    argv: process.argv.slice(2),
    fixturePid: process.pid,
    methods: requests.map((request) => request.method),
    mode,
    requests,
    serverReplies,
    stdinEnded: false,
  };
  saveRecord();
  if (mode === "protocol-failure") send({ id: promptId, result: null });
  else send({ id: promptId, result: { stopReason: "end_turn" } });
  promptId = undefined;
}

function receive(message) {
  if (message.method) {
    requests.push(message);
    const results = {
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
      },
      "session/new": { sessionId: "11111111-1111-4111-8111-111111111111" },
      "session/load": {},
      "session/set_model": {},
      "session/set_config_option": {},
    };
    if (message.method === "session/prompt") {
      promptId = message.id;
      send({
        id: "permission",
        method: "session/request_permission",
        params: { options: [{ optionId: "allow", kind: "allow_once" }] },
      });
      send({
        id: "file",
        method: "fs/read_text_file",
        params: { path: "private" },
      });
      return;
    }
    if (Object.hasOwn(results, message.method))
      send({ id: message.id, result: results[message.method] });
    else
      send({
        id: message.id,
        error: { code: -32601, message: "Unsupported fixture request" },
      });
    return;
  }

  if (serverRequestIds.has(message.id)) {
    serverReplies.push({
      id: message.id,
      ...(message.result !== undefined
        ? { result: message.result }
        : { error: message.error }),
    });
    finishPrompt();
  }
}

recordedResult = {
  argv: process.argv.slice(2),
  fixturePid: process.pid,
  methods: [],
  mode,
  requests,
  serverReplies,
  stdinEnded: false,
};
saveRecord();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) receive(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (recordedResult) {
    recordedResult.stdinEnded = true;
    saveRecord();
  }
  // runAcp normally stops the .cmd tree after the response; this timer keeps
  // the owned CLI alive after EOF long enough to expose orphaned descendants.
  setTimeout(() => process.exit(0), holdMs);
});
