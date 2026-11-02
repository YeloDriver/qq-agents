import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

export const verifyModeVariable = "QQ_AGENTS_VERIFY_MODE";
export const fileSymlinkVariable = "QQ_AGENTS_VERIFY_FILE_SYMLINK";
export const verificationSteps = [
  "check",
  "lint",
  "typecheck",
  "defaults:check",
  "test",
  "format:check",
  "privacy-scan",
];

export function isCI(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS);
}

export function localFileSymlinkSkip({
  env = process.env,
  platform = process.platform,
} = {}) {
  return (
    platform === "win32" &&
    !isCI(env) &&
    env[verifyModeVariable] === "local" &&
    env[fileSymlinkVariable] === "EPERM"
  );
}

function errorCode(error) {
  if (
    ["VERIFY_MODE_INVALID", "VERIFY_ARGUMENT_INVALID"].includes(error?.message)
  )
    return error.message;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "")
    ? error.code
    : "PROBE_FAILED";
}

function probeCommand(command, args, options) {
  const result = crossSpawn.sync(command, args, {
    ...options,
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Object.assign(new Error("COMMAND_FAILED"), {
      code: "COMMAND_FAILED",
    });
}

export function preflight({
  mode = "strict",
  platform = process.platform,
  env = process.env,
  nodeVersion = process.versions.node,
  filesystem = fs,
  command = probeCommand,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  if (!["strict", "local"].includes(mode))
    throw new Error("VERIFY_MODE_INVALID");
  if (mode === "local" && isCI(env))
    return {
      ok: false,
      checks: [{ name: "local-mode", ok: false, code: "CI_REQUIRES_STRICT" }],
    };
  const checks = [];
  const probe = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, code: errorCode(error) });
    }
  };
  probe("node", () => {
    const major = Number(nodeVersion.split(".")[0]);
    if (!Number.isInteger(major) || major < 24)
      throw Object.assign(new Error("NODE_VERSION_UNSUPPORTED"), {
        code: "NODE_VERSION_UNSUPPORTED",
      });
  });
  let root;
  probe("temporary-files", () => {
    root = filesystem.mkdtempSync(
      path.join(temporaryDirectory, "qq-agents-verify-"),
    );
    filesystem.writeFileSync(path.join(root, "source"), "verification probe");
  });
  if (
    root &&
    checks.some((check) => check.name === "temporary-files" && check.ok)
  ) {
    probe("hardlinks", () => {
      const link = path.join(root, "hardlink");
      filesystem.linkSync(path.join(root, "source"), link);
      if (filesystem.lstatSync(link).nlink < 2)
        throw Object.assign(new Error("HARDLINK_UNAVAILABLE"), {
          code: "HARDLINK_UNAVAILABLE",
        });
    });
    probe("directory-links", () => {
      const target = path.join(root, "directory"),
        link = path.join(root, "directory-link");
      filesystem.mkdirSync(target);
      // Windows junctions cover directory escapes without granting file-link rights.
      filesystem.symlinkSync(
        target,
        link,
        platform === "win32" ? "junction" : "dir",
      );
      if (!filesystem.lstatSync(link).isSymbolicLink())
        throw Object.assign(new Error("DIRECTORY_LINK_UNAVAILABLE"), {
          code: "DIRECTORY_LINK_UNAVAILABLE",
        });
    });
    probe("file-symlinks", () => {
      const link = path.join(root, "file-link");
      filesystem.symlinkSync(path.join(root, "source"), link, "file");
      if (!filesystem.lstatSync(link).isSymbolicLink())
        throw Object.assign(new Error("FILE_SYMLINK_UNAVAILABLE"), {
          code: "FILE_SYMLINK_UNAVAILABLE",
        });
    });
    probe("git", () => {
      // Probe only a disposable repository; inherited Git overrides could target real data.
      const gitEnv = Object.fromEntries(
        Object.entries(env).filter(
          ([name]) => !name.toUpperCase().startsWith("GIT_"),
        ),
      );
      gitEnv.GIT_CONFIG_NOSYSTEM = "1";
      gitEnv.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
      const repository = path.join(root, "repository"),
        options = { env: gitEnv };
      command("git", ["--version"], options);
      command("git", ["init", "--quiet", repository], options);
      command(
        "git",
        [
          "-C",
          repository,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "core.hooksPath=",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "fixture",
        ],
        options,
      );
    });
  }
  if (root)
    probe("temporary-cleanup", () => {
      const resolved = path.resolve(root);
      if (
        path.dirname(resolved) !== path.resolve(temporaryDirectory) ||
        !path.basename(resolved).startsWith("qq-agents-verify-")
      )
        throw Object.assign(new Error("TEMPORARY_PATH_INVALID"), {
          code: "TEMPORARY_PATH_INVALID",
        });
      filesystem.rmSync(resolved, { recursive: true, force: true });
    });
  for (const tool of ["ffmpeg", "ffprobe"])
    probe(tool, () => command(tool, ["-version"], { env }));
  for (const check of checks)
    if (
      mode === "local" &&
      platform === "win32" &&
      check.name === "file-symlinks" &&
      check.code === "EPERM"
    )
      check.localOnly = true;
  return {
    ok: checks.every((check) => check.ok || check.localOnly),
    checks,
  };
}

export function verificationEnvironment({ mode, platform, env, checks }) {
  // Windows resolves environment names without case; remove aliases before setting owned markers.
  const ownedVariables = [verifyModeVariable, fileSymlinkVariable];
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !ownedVariables.includes(name.toUpperCase()),
    ),
  );
  if (
    mode === "local" &&
    platform === "win32" &&
    !isCI(env) &&
    checks.some(
      (check) =>
        check.name === "file-symlinks" &&
        check.code === "EPERM" &&
        check.localOnly,
    )
  ) {
    childEnv[verifyModeVariable] = "local";
    childEnv[fileSymlinkVariable] = "EPERM";
  }
  return childEnv;
}

function runStep(step, env) {
  // npm_execpath avoids the Windows .cmd wrapper when npm launched this script.
  const command = env.npm_execpath ? process.execPath : "npm",
    args = env.npm_execpath ? [env.npm_execpath, "run", step] : ["run", step];
  const result = crossSpawn.sync(command, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return result.error ? 1 : (result.status ?? 1);
}

export function runVerification({
  mode = "strict",
  preflightOnly = false,
  platform = process.platform,
  env = process.env,
  inspect = preflight,
  step = runStep,
  log = console.log,
} = {}) {
  const result = inspect({ mode, platform, env });
  log(`验证预检：${mode === "local" ? "本机" : "严格"}模式`);
  for (const check of result.checks)
    log(
      `${check.ok ? "通过" : check.localOnly ? "本机限制" : "失败"} ${check.name}${check.code ? ` (${check.code})` : ""}`,
    );
  if (!result.ok) {
    log("预检未通过，未执行全量验证。");
    if (
      result.checks.some(
        (check) => check.name === "file-symlinks" && check.code === "EPERM",
      )
    )
      log(
        "文件符号链接缺少权限；本机可使用 npm run verify:local，严格验证需要具备相应权限。",
      );
    return 1;
  }
  const childEnv = verificationEnvironment({
    mode,
    platform,
    env,
    checks: result.checks,
  });
  const limited = localFileSymlinkSkip({ platform, env: childEnv });
  if (limited)
    log("本机模式将明确标记文件符号链接子测试未运行，其余检查全部保留。");
  if (preflightOnly) {
    log("仅完成环境预检，未执行全量验证。");
    return 0;
  }
  for (const name of verificationSteps) {
    const status = step(name, childEnv);
    if (status !== 0) {
      log(`验证失败：${name}`);
      return status;
    }
  }
  log(limited ? "本机验证通过（按本机覆盖范围）。" : "完整验证通过。");
  return 0;
}

export function parseArguments(args) {
  let mode = "strict",
    selectedMode,
    preflightOnly = false;
  for (const arg of args)
    if (arg === "--preflight") preflightOnly = true;
    else if (["--local", "local", "strict"].includes(arg)) {
      const nextMode = arg === "strict" ? "strict" : "local";
      if (selectedMode && selectedMode !== nextMode)
        throw new Error("VERIFY_ARGUMENT_INVALID");
      selectedMode = mode = nextMode;
    } else throw new Error("VERIFY_ARGUMENT_INVALID");
  return { mode, preflightOnly };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runVerification(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(errorCode(error));
    process.exitCode = 1;
  }
}
