import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { toolSpecs } from "../src/tools/specs.mjs";
import { draftDefinitions } from "../src/tools/qq-drafts.mjs";

test("native MCP accepts CLI summaries across draft actions without weakening business validation", async (t) => {
  const tools = toolSpecs(["qq_draft"]);
  const original = structuredClone(tools);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-mcp-token");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/catalog") return res.end(JSON.stringify({ tools }));
    if (req.url === "/lease") return res.end(JSON.stringify({ alive: true }));
    assert.equal(req.url, "/call");
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    calls.push(call);
    const parsed = draftDefinitions.qq_draft[1].safeParse(call.arguments);
    res.end(
      JSON.stringify({
        ...(parsed.success ? {} : { isError: true }),
        content: [
          {
            type: "text",
            text: parsed.success
              ? "synthetic-confirmed"
              : "INVALID_TOOL_ARGUMENTS",
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "synthetic-acp", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("../src/backends/antigravity-mcp.mjs", import.meta.url),
      ),
    ],
    env: {
      ...process.env,
      QQ_AGY_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
      QQ_AGY_TOKEN: "synthetic-mcp-token",
    },
    stderr: "pipe",
  });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const validate = new AjvJsonSchemaValidator().getValidator(
    listed.tools[0].inputSchema,
  );
  const ref = {
    draftId: "11111111-1111-4111-8111-111111111111",
    expectedVersion: 1,
  };
  const inputs = [
    { action: "list" },
    { action: "read", draftId: ref.draftId },
    {
      action: "revise",
      ...ref,
      position: 0,
      input: { text: "synthetic reply" },
    },
    { action: "discard", ...ref },
    { action: "prepare", ...ref },
    {
      action: "continue",
      ...ref,
      inputReview: { token: "a".repeat(64), decision: "continue" },
    },
  ];
  for (const input of inputs) {
    assert.equal(validate(input).valid, true);
    const args = { ...input, toolSummary: "Handle this saved draft" };
    assert.equal(validate(args).valid, true, input.action);
    const result = await client.callTool({ name: "qq_draft", arguments: args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls.at(-1), { name: "qq_draft", arguments: input });
  }
  const continuation = inputs.at(-1);
  for (const args of [
    { ...continuation, unexpected: true, toolSummary: "synthetic" },
    { ...continuation, expectedVersion: "1", toolSummary: "synthetic" },
    {
      ...continuation,
      inputReview: { ...continuation.inputReview, toolSummary: "nested" },
      toolSummary: "synthetic",
    },
    {
      ...inputs[2],
      input: { text: "synthetic", toolSummary: "nested" },
      toolSummary: "synthetic",
    },
  ]) {
    assert.equal(validate(args).valid, false);
    const result = await client.callTool({ name: "qq_draft", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(Object.hasOwn(calls.at(-1).arguments, "toolSummary"), false);
  }
  assert.equal(validate({ action: "list", toolSummary: 123 }).valid, false);
  const legacy = await client.callTool({
    name: "qq_draft",
    arguments: { action: "list" },
  });
  assert.notEqual(legacy.isError, true);
  assert.deepEqual(calls.at(-1).arguments, { action: "list" });
  assert.deepEqual(tools, original);
});

test("the bridge MCP helper exits after losing its lease even when stdin remains open", async (t) => {
  let leases = 0;
  const ready = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-lease-token");
    if (req.url === "/lease") {
      leases++;
      if (leases >= 2) ready.resolve();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ alive: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../src/backends/antigravity-mcp.mjs", import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        QQ_AGY_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        QQ_AGY_TOKEN: "synthetic-lease-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (data) => {
    diagnostic += data;
  });
  t.after(() => {
    child.kill();
    server.closeAllConnections();
    server.close();
  });
  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(Error("MCP_LEASE_TEST_TIMEOUT")),
      15000,
    );
    timer.unref();
  });
  await Promise.race([ready.promise, deadline]);
  assert.equal(child.exitCode, null, diagnostic);
  assert.equal(child.stdin.destroyed, false);
  const exited = once(child, "exit");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const [code] = await Promise.race([exited, deadline]);
  assert.equal(code, 0, diagnostic);
  assert(leases >= 2);
});
