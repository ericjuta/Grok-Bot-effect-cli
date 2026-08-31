import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist/cli/grok-bot.mjs");
const ansiEscape = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/u;

before(async () => {
  await execFileAsync(process.execPath, [path.join(repoRoot, "scripts/build-cli.mjs")], {
    cwd: repoRoot,
  });
});

async function failedRun(args) {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.fail("CLI invocation unexpectedly succeeded");
  } catch (error) {
    assert.equal(error.code, 1);
    return error;
  }
}

test("Effect CLI parse errors leave protocol stdout empty", async () => {
  const failure = await failedRun(["--timeout-ms", "not-an-integer", "mcp", "--stdio"]);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /not a integer/);
  assert.doesNotMatch(failure.stderr, ansiEscape);
  assert.doesNotMatch(failure.stderr, /FiberFailure|at file:|node:internal/);
});

test("redirected and NO_COLOR help output contains no ANSI escapes", async () => {
  const redirectedEnv = { ...process.env };
  delete redirectedEnv.NO_COLOR;
  for (const env of [redirectedEnv, { ...redirectedEnv, NO_COLOR: "1" }]) {
    const result = await execFileAsync(process.execPath, [cliPath, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    assert.match(result.stdout, /USAGE/);
    assert.doesNotMatch(result.stdout, ansiEscape);
    assert.equal(result.stderr, "");
  }
});

test("root and command groups reject missing subcommands without protocol stdout", async () => {
  for (const args of [[], ["agent"], ["chat"], ["provider"], ["attachment"]]) {
    const failure = await failedRun(args);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /missing subcommand/);
    assert.doesNotMatch(failure.stderr, /FiberFailure|at file:|node:internal/);
  }
});

test("malformed gateway headers are never reflected by compiled CLI failures", async () => {
  const cases = [
    { flag: "--token", value: "opaque\nDO_NOT_REFLECT_TOKEN" },
    { flag: "--request-id", value: "request\nDO_NOT_REFLECT_REQUEST" },
    { flag: "--traceparent", value: "trace\nDO_NOT_REFLECT_TRACE" },
  ];

  for (const item of cases) {
    const failure = await failedRun([
      "--url",
      "http://127.0.0.1:1",
      item.flag,
      item.value,
      "service",
      "list-agents",
    ]);
    assert.equal(failure.stderr, "");
    const envelope = JSON.parse(failure.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "CLI_CONFIG");
    assert.match(envelope.error.message, /request header is invalid/);
    assert.doesNotMatch(failure.stdout, /DO_NOT_REFLECT/);
    assert.doesNotMatch(failure.stdout, /FiberFailure|node:internal/);
  }
});

test("one-shot JSON parse failures do not reflect malformed credential text", async () => {
  const failure = await failedRun([
    "service",
    "list-agents",
    "--json",
    '{"token":DO_NOT_REFLECT_ONESHOT}',
  ]);
  assert.equal(failure.stderr, "");
  const envelope = JSON.parse(failure.stdout);
  assert.equal(envelope.error.code, "INVALID_INPUT");
  assert.match(envelope.error.message, /^Invalid JSON from --json\.$/);
  assert.doesNotMatch(failure.stdout, /DO_NOT_REFLECT_ONESHOT/);
});

test("RPC parse failures do not reflect malformed credential text", async () => {
  const child = spawn(process.execPath, [cliPath, "rpc", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const ready = JSON.parse((await lines.next()).value);
  assert.equal(ready.type, "ready");

  child.stdin.write('{"token":DO_NOT_REFLECT_RPC}\n');
  const rejectedLine = (await lines.next()).value;
  const rejected = JSON.parse(rejectedLine);
  assert.equal(rejected.type, "protocol-error");
  assert.equal(rejected.error.code, "INVALID_PROTOCOL");
  assert.doesNotMatch(rejectedLine, /DO_NOT_REFLECT_RPC/);

  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  reader.close();
});

test("a closed RPC stdout is handled without an uncaught EPIPE stack", async () => {
  const child = spawn(process.execPath, [cliPath, "rpc", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.destroy();
  child.stdin.end();

  const result = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, null);
  assert.ok(result.code === 0 || result.code === 1);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|node:events|node:internal|FiberFailure/);
  assert.ok(stderr === "" || /^rpc: INTERNAL: Unable to write RPC stdout: write EPIPE\n$/.test(stderr));
});
