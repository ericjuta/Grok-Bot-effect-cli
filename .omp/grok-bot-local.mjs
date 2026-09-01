import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialPath = join(repoRoot, ".cache", "reconstructed-profile", "sand-data", "local-docker-vm.json");
const cliPath = join(repoRoot, "dist", "cli", "grok-bot.mjs");

function readGatewayToken() {
  const descriptor = openSync(
    credentialPath,
    constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW,
  );
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (!metadata.isFile() || metadata.size > 4_096) {
      throw new Error("Local Docker credential must be a small regular file.");
    }
    if (currentUid !== undefined && metadata.uid !== currentUid) {
      throw new Error("Local Docker credential must be owned by the current user.");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Local Docker credential permissions must be 0600 or stricter.");
    }

    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (typeof parsed.token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.token)) {
      throw new Error("Local Docker credential contains an invalid gateway token.");
    }
    return parsed.token;
  } finally {
    closeSync(descriptor);
  }
}

if (Number.parseInt(process.versions.node, 10) !== 26) {
  throw new Error(`Grok Bot requires Node 26; received ${process.version}.`);
}

const child = spawn(
  process.execPath,
  [cliPath, "--url", "http://127.0.0.1:1340", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      GROK_BOT_GATEWAY_TOKEN: readGatewayToken(),
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Unable to start Grok Bot CLI: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
