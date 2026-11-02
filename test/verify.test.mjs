import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fileSymlinkVariable,
  localFileSymlinkSkip,
  parseArguments,
  preflight,
  runVerification,
  verificationEnvironment,
  verificationSteps,
  verifyModeVariable,
} from "../scripts/verify.mjs";
import { fileSymlinkTest } from "./helpers.mjs";

function simulatedPreflight({
  mode = "strict",
  platform = "win32",
  env = {},
  fileError,
  hardlinkError,
  commandError,
  writeError,
  nodeVersion = "24.0.0",
} = {}) {
  const calls = [],
    root = path.join(os.tmpdir(), "qq-agents-verify-fixture"),
    filesystem = {
      mkdtempSync: () => root,
      writeFileSync() {
        if (writeError)
          throw Object.assign(new Error("private path"), { code: writeError });
      },
      mkdirSync() {},
      linkSync() {
        if (hardlinkError)
          throw Object.assign(new Error("private path"), {
            code: hardlinkError,
          });
      },
      symlinkSync(target, link, type) {
        calls.push({ type });
        if (type === "file" && fileError)
          throw Object.assign(new Error("private path"), { code: fileError });
      },
      lstatSync: () => ({ nlink: 2, isSymbolicLink: () => true }),
      rmSync(target, options) {
        calls.push({ cleanup: target, options });
      },
    };
  const result = preflight({
    mode,
    platform,
    env,
    nodeVersion,
    filesystem,
    command(tool, args, options) {
      calls.push({ tool, args, options });
      if (tool === commandError)
        throw Object.assign(new Error("private path"), { code: "EPERM" });
    },
  });
  return { ...result, calls };
}

test("local preflight permits only Windows file-symlink EPERM and probes other prerequisites", () => {
  const result = simulatedPreflight({ mode: "local", fileError: "EPERM" });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.filter((check) => check.localOnly),
    [{ name: "file-symlinks", ok: false, code: "EPERM", localOnly: true }],
  );
  assert.deepEqual(
    result.calls.filter((call) => call.type).map((call) => call.type),
    ["junction", "file"],
  );
  assert.equal(result.calls.filter((call) => call.tool === "git").length, 3);
  assert.equal(result.calls.filter((call) => call.tool === "ffmpeg").length, 1);
  assert.equal(
    result.calls.filter((call) => call.tool === "ffprobe").length,
    1,
  );
  assert.equal(result.calls.filter((call) => call.cleanup).length, 1);
  assert(!JSON.stringify(result.checks).includes("private path"));
});

test("permission errors outside file symlinks and non-EPERM errors remain failures", () => {
  for (const options of [
    { mode: "strict", fileError: "EPERM" },
    { mode: "local", platform: "linux", fileError: "EPERM" },
    { mode: "local", fileError: "EACCES" },
    { mode: "local", fileError: "ENOENT" },
    { mode: "local", hardlinkError: "EPERM" },
    { mode: "local", commandError: "git" },
    { mode: "local", commandError: "ffprobe" },
  ])
    assert.equal(
      simulatedPreflight(options).ok,
      false,
      JSON.stringify(options),
    );
});

test("unusable temporary files stop dependent probes and are cleaned up", () => {
  const result = simulatedPreflight({ mode: "local", writeError: "EACCES" });
  assert.equal(result.ok, false);
  assert.equal(
    result.calls.filter((call) => call.type || call.tool === "git").length,
    0,
  );
  assert.equal(result.calls.filter((call) => call.cleanup).length, 1);
  assert.equal(
    result.checks.find((check) => check.name === "temporary-files").code,
    "EACCES",
  );
});

test("unsupported or invalid Node versions fail preflight", () => {
  for (const nodeVersion of ["22.0.0", "invalid"])
    assert.equal(simulatedPreflight({ nodeVersion }).ok, false);
});

test("Git probes discard inherited repository and configuration overrides", () => {
  const result = simulatedPreflight({
    env: {
      PATH: "fixture-path",
      GIT_DIR: "existing-repository",
      GIT_WORK_TREE: "existing-worktree",
      git_object_directory: "existing-objects",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: "existing-config",
    },
  });
  const gitCalls = result.calls.filter((call) => call.tool === "git");
  for (const call of gitCalls) {
    assert.equal(call.options.env.GIT_DIR, undefined);
    assert.equal(call.options.env.GIT_WORK_TREE, undefined);
    assert.equal(call.options.env.git_object_directory, undefined);
    assert.equal(call.options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, "NUL");
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(call.options.env.PATH, "fixture-path");
  }
});

test("CI rejects local mode before filesystem or command probes", () => {
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    const result = preflight({
      mode: "local",
      env,
      filesystem: {
        mkdtempSync() {
          assert.fail("CI must reject local mode before a filesystem probe");
        },
      },
      command() {
        assert.fail("CI must reject local mode before a command probe");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks[0].code, "CI_REQUIRES_STRICT");
  }
});

test("strict failure and diagnostic-only mode never start the verification suite", () => {
  const logs = [];
  assert.equal(
    runVerification({
      inspect: () => simulatedPreflight({ fileError: "EPERM" }),
      step() {
        assert.fail("strict preflight failure must not run any check");
      },
      log: (line) => logs.push(line),
    }),
    1,
  );
  assert(logs.some((line) => line.includes("未执行全量验证")));
  assert.equal(
    runVerification({
      mode: "local",
      preflightOnly: true,
      env: {},
      platform: "win32",
      inspect: () => simulatedPreflight({ mode: "local", fileError: "EPERM" }),
      step() {
        assert.fail("diagnostic mode must not run any check");
      },
      log() {},
    }),
    0,
  );
});

test("local validation retains all seven steps and reports its remaining coverage", () => {
  const steps = [],
    logs = [];
  const status = runVerification({
    mode: "local",
    platform: "win32",
    env: {},
    inspect: () => simulatedPreflight({ mode: "local", fileError: "EPERM" }),
    step(name, env) {
      steps.push(name);
      assert.equal(env[verifyModeVariable], "local");
      assert.equal(env[fileSymlinkVariable], "EPERM");
      return 0;
    },
    log: (line) => logs.push(line),
  });
  assert.equal(status, 0);
  assert.deepEqual(steps, verificationSteps);
  assert.match(logs.at(-1), /本机验证通过（按本机覆盖范围）/);
  assert(logs.some((line) => line.includes("文件符号链接子测试未运行")));
});

test("validation stops at a failed check and never reports completion", () => {
  const steps = [],
    logs = [];
  const status = runVerification({
    env: {},
    inspect: () => simulatedPreflight(),
    step(name) {
      steps.push(name);
      return name === "typecheck" ? 2 : 0;
    },
    log: (line) => logs.push(line),
  });
  assert.equal(status, 2);
  assert.deepEqual(steps, ["check", "lint", "typecheck"]);
  assert(!logs.some((line) => line.includes("验证通过")));
});

test("strict and successful local probes remove forged or stale skip markers", () => {
  const env = {
    [verifyModeVariable]: "local",
    [fileSymlinkVariable]: "EPERM",
    qq_agents_verify_mode: "local",
    Qq_Agents_Verify_Mode: "local",
    qq_agents_verify_file_symlink: "EPERM",
    Qq_Agents_Verify_File_Symlink: "EPERM",
    PATH: "fixture-path",
  };
  for (const options of [
    { mode: "strict", platform: "win32", checks: [] },
    {
      mode: "local",
      platform: "win32",
      checks: [{ name: "file-symlinks", ok: true }],
    },
    { mode: "local", platform: "linux", checks: [] },
  ]) {
    const childEnv = verificationEnvironment({ ...options, env });
    assert.equal(childEnv[verifyModeVariable], undefined);
    assert.equal(childEnv[fileSymlinkVariable], undefined);
    assert.equal(
      Object.keys(childEnv).filter((name) =>
        [verifyModeVariable, fileSymlinkVariable].includes(name.toUpperCase()),
      ).length,
      0,
    );
    assert.equal(childEnv.PATH, env.PATH);
  }
  assert.equal(env[verifyModeVariable], "local");
});

test("confirmed local permission results replace all marker aliases with canonical names", () => {
  const childEnv = verificationEnvironment({
    mode: "local",
    platform: "win32",
    env: {
      qq_agents_verify_mode: "strict",
      Qq_Agents_Verify_File_Symlink: "EACCES",
    },
    checks: [
      { name: "file-symlinks", ok: false, code: "EPERM", localOnly: true },
    ],
  });
  assert.deepEqual(childEnv, {
    [verifyModeVariable]: "local",
    [fileSymlinkVariable]: "EPERM",
  });
});

test(
  "Windows child processes cannot inherit mixed-case stale skip markers",
  { skip: process.platform !== "win32" },
  () => {
    const module = new URL("../scripts/verify.mjs", import.meta.url).href;
    const source = `import { localFileSymlinkSkip } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify({
  mode: process.env.QQ_AGENTS_VERIFY_MODE ?? null,
  symlink: process.env.QQ_AGENTS_VERIFY_FILE_SYMLINK ?? null,
  skip: localFileSymlinkSkip(),
}));`;
    const env = {
      ...process.env,
      qq_agents_verify_mode: "local",
      Qq_Agents_Verify_Mode: "local",
      qq_agents_verify_file_symlink: "EPERM",
      Qq_Agents_Verify_File_Symlink: "EPERM",
    };
    for (const options of [
      { mode: "strict", checks: [] },
      { mode: "local", checks: [{ name: "file-symlinks", ok: true }] },
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", source],
        {
          env: verificationEnvironment({ ...options, platform: "win32", env }),
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        mode: null,
        symlink: null,
        skip: false,
      });
    }
  },
);

test("skip eligibility is restricted to local Windows permission results outside CI", () => {
  const env = {
    [verifyModeVariable]: "local",
    [fileSymlinkVariable]: "EPERM",
  };
  assert.equal(localFileSymlinkSkip({ env, platform: "win32" }), true);
  for (const options of [
    { env, platform: "linux" },
    { env: { ...env, CI: "true" }, platform: "win32" },
    { env: { ...env, GITHUB_ACTIONS: "true" }, platform: "win32" },
    { env: { ...env, [verifyModeVariable]: "strict" }, platform: "win32" },
    { env: { ...env, [fileSymlinkVariable]: "EACCES" }, platform: "win32" },
  ])
    assert.equal(localFileSymlinkSkip(options), false);
});

test("file-symlink helper creates a named child and preserves its callback", async (t) => {
  const saved = Object.fromEntries(
    [verifyModeVariable, fileSymlinkVariable, "CI", "GITHUB_ACTIONS"].map(
      (name) => [name, process.env[name]],
    ),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env[verifyModeVariable] = "local";
  process.env[fileSymlinkVariable] = "EPERM";
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  const callback = () => {},
    children = [];
  await fileSymlinkTest(
    {
      test(name, options, fn) {
        children.push({ name, options, fn });
      },
    },
    callback,
    "linked payload refusal",
  );
  assert.equal(children.length, 1);
  assert.equal(children[0].name, "linked payload refusal");
  assert.equal(children[0].fn, callback);
  if (process.platform === "win32")
    assert.match(children[0].options.skip, /EPERM confirmed/);
  else assert.equal(children[0].options.skip, false);
});

test("CLI diagnostic parsing is explicit and conflicting modes are rejected", () => {
  assert.deepEqual(parseArguments([]), {
    mode: "strict",
    preflightOnly: false,
  });
  assert.deepEqual(parseArguments(["--preflight", "local"]), {
    mode: "local",
    preflightOnly: true,
  });
  assert.deepEqual(parseArguments(["--local"]), {
    mode: "local",
    preflightOnly: false,
  });
  assert.throws(
    () => parseArguments(["--local", "strict"]),
    /VERIFY_ARGUMENT_INVALID/,
  );
  assert.throws(
    () => parseArguments(["--skip-tests"]),
    /VERIFY_ARGUMENT_INVALID/,
  );
});

test("the executable entry point refuses local mode on CI without running the suite", () => {
  const script = fileURLToPath(
    new URL("../scripts/verify.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script, "--preflight", "local"], {
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CI_REQUIRES_STRICT/);
  assert.match(result.stdout, /未执行全量验证/);
});

test("the executable entry point reports a stable argument error", () => {
  const script = fileURLToPath(
    new URL("../scripts/verify.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script, "--unknown"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "VERIFY_ARGUMENT_INVALID");
});
