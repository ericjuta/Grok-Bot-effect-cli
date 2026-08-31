#!/usr/bin/env node

import { build } from "esbuild";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const targetPath = path.join(skillRoot, "references", "service-catalog.md");

const PROFILE_DEFINITIONS = [
  { id: "default", label: "default", options: {} },
  { id: "sensitive", label: "sensitive", options: { includeSensitive: true } },
  { id: "writes", label: "writes", options: { includeWrites: true } },
  { id: "destructive", label: "destructive", options: { includeDestructive: true } },
  {
    id: "writes-sensitive",
    label: "writes + sensitive",
    options: { includeWrites: true, includeSensitive: true },
  },
  {
    id: "destructive-sensitive",
    label: "destructive + sensitive",
    options: { includeDestructive: true, includeSensitive: true },
  },
  {
    id: "writes-destructive",
    label: "writes + destructive",
    options: { includeWrites: true, includeDestructive: true },
  },
  {
    id: "ordinary",
    label: "all ordinary",
    options: {
      includeWrites: true,
      includeDestructive: true,
      includeSensitive: true,
    },
  },
  {
    id: "human",
    label: "all + human",
    options: {
      includeWrites: true,
      includeDestructive: true,
      includeSensitive: true,
      includeHumanActions: true,
    },
  },
];

async function loadCatalogueModule() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grok-bot-catalogue-"));
  const outputPath = path.join(temporaryDirectory, "catalogue.mjs");
  const cataloguePath = path.join(repositoryRoot, "source", "cli", "catalog.ts");
  const mcpPath = path.join(repositoryRoot, "source", "cli", "mcp-stdio.ts");

  try {
    await build({
      stdin: {
        contents: [
          `export { GATEWAY_SERVICE_CATALOG, GATEWAY_EVENT_CHANNELS, CLI_GATEWAY_EVENT_CHANNEL } from ${JSON.stringify(cataloguePath)};`,
          `export { makeMcpTools } from ${JSON.stringify(mcpPath)};`,
        ].join("\n"),
        loader: "ts",
        resolveDir: repositoryRoot,
        sourcefile: "catalogue-entry.ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      outfile: outputPath,
      logLevel: "silent",
    });

    return await import(`${pathToFileURL(outputPath).href}?catalogue=${Date.now()}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function countBy(values, select) {
  const counts = new Map();
  for (const value of values) {
    const key = select(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function markdownCell(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("`", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function inputLabel(service) {
  return service.acceptsInput ? service.inputSchemaKind : "none";
}

function privacyLabel(service) {
  if (service.sensitiveInput && service.sensitiveOutput) return "input + output";
  if (service.sensitiveInput) return "input";
  if (service.sensitiveOutput) return "output";
  return "—";
}

function runtimeLabel(service) {
  if (service.grokBot030 && service.reconstructedHost) return "stock + reconstructed";
  if (service.grokBot030) return "stock 0.30 only";
  return "reconstructed/legacy only";
}

function minimumMcpProfile(serviceName, profileToolNames) {
  for (const profile of PROFILE_DEFINITIONS) {
    if (profileToolNames.get(profile.id).has(serviceName)) return profile.label;
  }
  return "raw/RPC only";
}

function summaryTable(counts, order) {
  return order
    .map((key) => `| ${markdownCell(key)} | ${counts.get(key) ?? 0} |`)
    .join("\n");
}

function renderCatalogue(module) {
  const services = [...module.GATEWAY_SERVICE_CATALOG];
  const profiles = PROFILE_DEFINITIONS.map((profile) => {
    const tools = module.makeMcpTools(profile.options);
    return {
      ...profile,
      count: tools.length,
      names: new Set(tools.map((tool) => tool.name)),
    };
  });
  const profileToolNames = new Map(profiles.map((profile) => [profile.id, profile.names]));
  const groups = [...new Set(services.map((service) => service.group))].sort();
  const groupCounts = countBy(services, (service) => service.group);
  const riskCounts = countBy(services, (service) => service.risk);
  const schemaCounts = countBy(services, (service) => service.inputSchemaKind);
  const stockCount = services.filter((service) => service.grokBot030).length;
  const reconstructedCount = services.filter((service) => service.reconstructedHost).length;
  const overlapCount = services.filter(
    (service) => service.grokBot030 && service.reconstructedHost,
  ).length;
  const stockOnlyCount = services.filter(
    (service) => service.grokBot030 && !service.reconstructedHost,
  ).length;
  const reconstructedOnlyCount = services.filter(
    (service) => !service.grokBot030 && service.reconstructedHost,
  ).length;
  const sensitiveInputCount = services.filter((service) => service.sensitiveInput).length;
  const sensitiveOutputCount = services.filter((service) => service.sensitiveOutput).length;
  const sensitiveEitherCount = services.filter(
    (service) => service.sensitiveInput || service.sensitiveOutput,
  ).length;
  const sensitiveBothCount = services.filter(
    (service) => service.sensitiveInput && service.sensitiveOutput,
  ).length;
  const humanDecisionCount = services.filter(
    (service) => service.requiresHumanDecision,
  ).length;

  const lines = [
    "# Generated Grok Bot service catalogue",
    "",
    "> Generated from `source/cli/catalog.ts`, `source/cli/service-metadata.ts`, and `source/cli/mcp-stdio.ts`. Do not edit this file by hand; run `render-service-catalog.mjs --write`.",
    "",
    "This is the static client union, not a promise that every method is live. Run `grok-bot doctor`, inspect `liveDiscovery`, and then run `grok-bot services`; add `--live-only` only when discovery is live. A generic or partial schema is not a complete semantic contract; use `describe-service` and preserve authoritative host errors.",
    "",
    "## Coverage",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Union catalogue | ${services.length} |`,
    `| Audited stock 0.30 | ${stockCount} |`,
    `| Reconstructed host | ${reconstructedCount} |`,
    `| Stock/reconstructed overlap | ${overlapCount} |`,
    `| Stock-only | ${stockOnlyCount} |`,
    `| Reconstructed or legacy only | ${reconstructedOnlyCount} |`,
    "",
    "## Risk and schema summary",
    "",
    "Risk labels are explicit catalogue policy. They are not inferred at generation time.",
    "",
    "| Risk | Count |",
    "| --- | ---: |",
    summaryTable(riskCounts, ["read", "write", "interactive", "destructive"]),
    "",
    "| Input schema | Count |",
    "| --- | ---: |",
    summaryTable(schemaCounts, ["exact", "partial", "generic"]),
    "",
    "| Privacy/human marker | Count |",
    "| --- | ---: |",
    `| Sensitive input | ${sensitiveInputCount} |`,
    `| Sensitive output | ${sensitiveOutputCount} |`,
    `| Either | ${sensitiveEitherCount} |`,
    `| Both | ${sensitiveBothCount} |`,
    `| Human decision | ${humanDecisionCount} |`,
    "",
    "## Groups",
    "",
    "`memory` is an event channel, not an emitted service group. Memory-named methods are classified under `agent` by the source policy.",
    "",
    "| Group | Count |",
    "| --- | ---: |",
    summaryTable(groupCounts, groups),
    "",
    "## MCP projections",
    "",
    "Counts are compiled policy projections before live-host filtering. Write, destructive, and sensitive gates are independent. Human-decision actions remain withheld until the human gate is added to the full ordinary profile.",
    "",
    "| Profile | Named tools |",
    "| --- | ---: |",
    ...profiles.map((profile) => `| ${profile.label} | ${profile.count} |`),
    "",
    "The raw tool is not included above. `--unsafe-raw` adds exactly one tool, `grok_gateway_call_unsafe`. Named MCP always excludes `executeRoutedMcpTool`, `refreshMcp`, and `setHostSettings`.",
    "",
    "## Event channels",
    "",
    ...module.GATEWAY_EVENT_CHANNELS.map((channel) => `- \`${channel}\``),
    `- \`${module.CLI_GATEWAY_EVENT_CHANNEL}\` (synthetic reconnect/gap channel)`,
    "",
    "## Complete service index",
    "",
    "The MCP minimum column names the first conservative profile above that exposes the service. Human-decision entries are intentionally shown as `all + human`, even when a smaller implementation-specific combination could technically pass the filter.",
    "",
  ];

  for (const group of groups) {
    lines.push(
      `### ${group}`,
      "",
      "| Service | CLI alias | Risk | Input | Private | Human | Runtime | MCP minimum | Purpose |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const service of services.filter((candidate) => candidate.group === group)) {
      lines.push(
        `| \`${service.name}\` | \`${service.cliName}\` | ${service.risk} | ${inputLabel(service)} | ${privacyLabel(service)} | ${service.requiresHumanDecision ? "yes" : "—"} | ${runtimeLabel(service)} | ${minimumMcpProfile(service.name, profileToolNames)} | ${markdownCell(service.description)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || ![undefined, "--write", "--check"].includes(mode)) {
    console.error("Usage: render-service-catalog.mjs [--write|--check]");
    process.exitCode = 2;
    return;
  }

  const module = await loadCatalogueModule();
  const rendered = renderCatalogue(module);

  if (mode === "--write") {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, rendered, "utf8");
    process.stdout.write(`Wrote ${path.relative(repositoryRoot, targetPath)}\n`);
    return;
  }

  if (mode === "--check") {
    let current;
    try {
      current = await readFile(targetPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        console.error(`Missing ${path.relative(repositoryRoot, targetPath)}; run with --write.`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    if (current !== rendered) {
      console.error(`Stale ${path.relative(repositoryRoot, targetPath)}; run with --write.`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Current ${path.relative(repositoryRoot, targetPath)}\n`);
    return;
  }

  process.stdout.write(rendered);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
