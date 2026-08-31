import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repositoryRoot, ".agents", "skills", "grok-bot-operator");
const generator = path.join(skillRoot, "scripts", "render-service-catalog.mjs");

test("grok-bot operator skill is complete and its catalogue is current", async () => {
  const result = spawnSync(process.execPath, [generator, "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `catalogue generator failed:\n${result.stdout}${result.stderr}`,
  );

  const [skill, daily, mcp, catalogue] = await Promise.all([
    readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    readFile(path.join(skillRoot, "references", "daily-workflows.md"), "utf8"),
    readFile(path.join(skillRoot, "references", "mcp-and-omp.md"), "utf8"),
    readFile(path.join(skillRoot, "references", "service-catalog.md"), "utf8"),
  ]);

  assert.match(skill, /^---\nname: grok-bot-operator\ndescription: .+\n---\n/);
  assert.match(skill, /skill:\/\/grok-bot-operator\/references\/service-catalog\.md/);
  assert.ok(daily.length > 2_000, "daily workflow reference should remain substantive");
  assert.ok(mcp.length > 2_000, "MCP/OMP reference should remain substantive");

  const serviceRows = catalogue.match(/^\| `[^`]+` \| `[^`]+` \|/gm) ?? [];
  assert.equal(serviceRows.length, 188, "generated reference must enumerate all union services");
  assert.match(catalogue, /\| Union catalogue \| 188 \|/);
  assert.match(catalogue, /\| Human decision \| 30 \|/);
  assert.match(catalogue, /\| all \+ human \| 185 \|/);
});
