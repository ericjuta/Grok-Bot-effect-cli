#!/usr/bin/env node

import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");

async function loadRuntime() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grok-automation-validator-"));
  const outputPath = path.join(temporaryDirectory, "runtime.mjs");
  const fromRoot = (...segments) => path.join(repositoryRoot, ...segments);
  const entry = [
    `export { GITHUB_EVENT_KINDS, LINEAR_EVENT_CASES, SENTRY_EVENT_CASES, PAGERDUTY_EVENT_CASES, REACTION_EMOJI_PATTERN, TRIGGER_MAX_GROUP_LISTENERS, TRIGGER_MAX_REACTION_EMOJI, isGithubCiEventKind, isValidGitBranch, isValidGithubRepo, normalizeReactionEmoji, triggerCronSchedules, triggerEventTriggers } from ${JSON.stringify(fromRoot("source", "shared", "automations.ts"))};`,
    `export { parseStoredTrigger, serializeStoredTrigger, TRIGGER_MAX_CHANNEL_LENGTH, TRIGGER_MAX_KEYWORD_LENGTH, TRIGGER_MAX_REPO_LENGTH, TRIGGER_MAX_BRANCH_LENGTH, TRIGGER_MAX_ALLOWLIST_LOGINS, TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH, TRIGGER_MAX_FILTER_IDS, TRIGGER_MAX_ID_LENGTH } from ${JSON.stringify(fromRoot("source", "host", "automations", "automation-trigger.ts"))};`,
    `export { AUTOMATION_MAX_NAME_LENGTH, clampAutomationName, normalizeAutomationPrompt } from ${JSON.stringify(fromRoot("source", "host", "automations", "automation.ts"))};`,
    `export { compileCronMatcher, computeNextRunAt, describeTrigger, normalizeSchedule, parseEveryIntervalMs, splitScheduleTimeZone } from ${JSON.stringify(fromRoot("source", "shared", "automation-schedule.ts"))};`,
    `export { WORKFLOW_MAX_NAME_LENGTH, WORKFLOW_MAX_DESCRIPTION_LENGTH, WORKFLOW_MAX_BODY_LENGTH, clampWorkflowName, clampWorkflowDescription, clampWorkflowBody } from ${JSON.stringify(fromRoot("source", "shared", "workflow-model.ts"))};`,
  ].join("\n");

  try {
    await build({
      stdin: {
        contents: entry,
        loader: "ts",
        resolveDir: repositoryRoot,
        sourcefile: "automation-validator-entry.ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      outfile: outputPath,
      logLevel: "silent",
    });
    return await import(`${pathToFileURL(outputPath).href}?validator=${Date.now()}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function usage() {
  return [
    "Usage:",
    "  validate-automation-spec.mjs --json '<spec-or-create-payload>' [--kind automation|workflow] [--at ISO_OR_MS] [--time-zone IANA]",
    "  validate-automation-spec.mjs --file PATH [--kind automation|workflow] [--at ISO_OR_MS] [--time-zone IANA]",
    "  validate-automation-spec.mjs --stdin [--kind automation|workflow] [--at ISO_OR_MS] [--time-zone IANA]",
    "",
    "This validates a reconstructed-host AutomationSpec by default, or WorkflowSpec with --kind workflow.",
    "Live stock-host discovery and validation remain authoritative.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { source: null, at: Date.now(), timeZone: undefined, kind: "automation" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--stdin") {
      if (options.source != null) throw new Error("Use exactly one of --json, --file, or --stdin.");
      options.source = { kind: "stdin" };
      continue;
    }
    if (token === "--json" || token === "--file" || token === "--at" || token === "--time-zone" || token === "--kind") {
      const value = argv[index + 1];
      if (value == null) throw new Error(`${token} needs a value.`);
      index += 1;
      if (token === "--json" || token === "--file") {
        if (options.source != null) throw new Error("Use exactly one of --json, --file, or --stdin.");
        options.source = { kind: token.slice(2), value };
      } else if (token === "--time-zone") {
        options.timeZone = value;
      } else if (token === "--kind") {
        if (value !== "automation" && value !== "workflow") {
          throw new Error(`Invalid --kind value: ${value}; expected automation or workflow.`);
        }
        options.kind = value;
      } else {
        const milliseconds = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
        if (!Number.isFinite(milliseconds)) throw new Error(`Invalid --at value: ${value}`);
        options.at = milliseconds;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (options.source == null) throw new Error("Use one of --json, --file, or --stdin.");
  if (options.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone }).format(new Date(options.at));
    } catch {
      throw new Error(`Invalid --time-zone value: ${options.timeZone}`);
    }
  }
  return options;
}

async function readSource(source) {
  if (source.kind === "json") return source.value;
  if (source.kind === "file") return readFile(path.resolve(source.value), "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function record(value) {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowedKeys, label, errors) {
  if (!record(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${label}.${key} is unsupported and would be ignored by the host.`);
    }
  }
}

function validateToken(value, label, maximum, errors, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
    return;
  }
  if (!allowEmpty && value.trim().length === 0) errors.push(`${label} must not be empty.`);
  if (/\r|\n/.test(value)) errors.push(`${label} must be one line.`);
  if (value.trim().length > maximum) errors.push(`${label} exceeds ${maximum} characters.`);
}

function validateStringList(value, label, runtime, errors, warnings, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  if (value.length > runtime.TRIGGER_MAX_FILTER_IDS) {
    errors.push(`${label} exceeds ${runtime.TRIGGER_MAX_FILTER_IDS} entries.`);
  }
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    validateToken(entry, `${label}[${index}]`, runtime.TRIGGER_MAX_ID_LENGTH, errors);
    if (typeof entry === "string") {
      if (seen.has(entry)) warnings.push(`${label} contains duplicate ${JSON.stringify(entry)}; the host de-duplicates it.`);
      seen.add(entry);
    }
  }
  return value;
}

function validateCron(member, label, runtime, options, errors, warnings, schedulePreview) {
  rejectUnknownKeys(member, ["type", "schedule"], label, errors);
  validateToken(member.schedule, `${label}.schedule`, 120, errors);
  if (typeof member.schedule !== "string" || member.schedule.trim().length === 0) return;
  const schedule = runtime.normalizeSchedule(member.schedule);
  const split = runtime.splitScheduleTimeZone(schedule);
  const interval = runtime.parseEveryIntervalMs(schedule);
  const matcher = runtime.compileCronMatcher(schedule);
  if (interval == null && matcher == null) {
    errors.push(`${label}.schedule is neither a valid five-field cron/alias nor @every interval.`);
    return;
  }
  if (interval != null && split.timeZone != null) {
    errors.push(`${label}.schedule must not apply a timezone prefix to @every.`);
    return;
  }
  if (interval != null && interval < 5 * 60_000) {
    warnings.push(`${label}.schedule is valid on the reconstructed scheduler but below the portable five-minute stock-UI floor.`);
  }
  if (interval == null && split.timeZone == null && options.timeZone == null) {
    errors.push(`${label}.schedule is an unpinned cron; pass --time-zone for a deterministic preview or add CRON_TZ/TZ to the schedule.`);
    return;
  }
  const nextRun = runtime.computeNextRunAt(schedule, options.at, options.timeZone);
  if (nextRun == null || !Number.isFinite(nextRun)) {
    errors.push(`${label}.schedule has no next run within the runtime's 366-day search horizon.`);
    return;
  }
  schedulePreview.push({
    schedule,
    anchor: new Date(options.at).toISOString(),
    nextRunAt: new Date(nextRun).toISOString(),
    ...(split.timeZone == null && options.timeZone != null ? { effectiveTimeZone: options.timeZone } : {}),
  });
}

function validateSlack(member, label, runtime, errors, warnings) {
  rejectUnknownKeys(member, ["type", "channel", "match"], label, errors);
  validateToken(member.channel, `${label}.channel`, runtime.TRIGGER_MAX_CHANNEL_LENGTH, errors);
  if (!record(member.match)) {
    errors.push(`${label}.match must be an object.`);
    return;
  }
  const kind = member.match.kind;
  if (!["mention", "message", "keyword", "reaction"].includes(kind)) {
    rejectUnknownKeys(member.match, ["kind"], `${label}.match`, errors);
    errors.push(`${label}.match.kind is unsupported.`);
    return;
  }
  const matchKeys = kind === "keyword"
    ? ["kind", "keyword"]
    : kind === "reaction"
      ? ["kind", "emoji", "bySelf"]
      : ["kind"];
  rejectUnknownKeys(member.match, matchKeys, `${label}.match`, errors);
  if (kind === "keyword") {
    validateToken(member.match.keyword, `${label}.match.keyword`, runtime.TRIGGER_MAX_KEYWORD_LENGTH, errors);
  }
  if (kind !== "reaction") return;
  if (member.match.bySelf !== undefined && typeof member.match.bySelf !== "boolean") {
    errors.push(`${label}.match.bySelf must be boolean when present.`);
  }
  if (member.match.emoji === undefined) return;
  if (!Array.isArray(member.match.emoji)) {
    errors.push(`${label}.match.emoji must be an array.`);
    return;
  }
  if (member.match.emoji.length > runtime.TRIGGER_MAX_REACTION_EMOJI) {
    errors.push(`${label}.match.emoji exceeds ${runtime.TRIGGER_MAX_REACTION_EMOJI} entries.`);
  }
  const seen = new Set();
  for (const [index, entry] of member.match.emoji.entries()) {
    if (typeof entry !== "string") {
      errors.push(`${label}.match.emoji[${index}] must be a string.`);
      continue;
    }
    const normalized = runtime.normalizeReactionEmoji(entry);
    if (!runtime.REACTION_EMOJI_PATTERN.test(normalized)) {
      errors.push(`${label}.match.emoji[${index}] is not a supported emoji name.`);
    }
    if (seen.has(normalized)) warnings.push(`${label}.match.emoji contains duplicate ${JSON.stringify(normalized)}.`);
    seen.add(normalized);
  }
}

function validateGithub(member, label, runtime, errors, warnings) {
  rejectUnknownKeys(member, ["type", "repo", "events", "ciBranch", "userAllowlist"], label, errors);
  validateToken(member.repo, `${label}.repo`, runtime.TRIGGER_MAX_REPO_LENGTH, errors);
  if (typeof member.repo === "string" && !runtime.isValidGithubRepo(member.repo.trim())) {
    errors.push(`${label}.repo must be one concrete owner/name repository; wildcards are unsupported.`);
  }
  if (!Array.isArray(member.events) || member.events.length === 0) {
    errors.push(`${label}.events must be a non-empty array.`);
  } else {
    const allowed = new Set(runtime.GITHUB_EVENT_KINDS);
    const seen = new Set();
    for (const [index, event] of member.events.entries()) {
      if (typeof event !== "string" || !allowed.has(event)) errors.push(`${label}.events[${index}] is unsupported.`);
      if (seen.has(event)) warnings.push(`${label}.events contains duplicate ${JSON.stringify(event)}.`);
      seen.add(event);
    }
    const watchesCi = member.events.some((event) => typeof event === "string" && runtime.isGithubCiEventKind(event));
    if (watchesCi) {
      if (typeof member.ciBranch !== "string" || !runtime.isValidGitBranch(member.ciBranch.trim())) {
        errors.push(`${label}.ciBranch is required and must be valid for ci-passed/ci-failed.`);
      }
      if (Array.isArray(member.userAllowlist) && member.userAllowlist.length > 0) {
        warnings.push(`${label}.userAllowlist does not narrow CI events.`);
      }
    } else if (member.ciBranch !== undefined) {
      errors.push(`${label}.ciBranch is unsupported when no CI event is selected because the host would ignore it.`);
    }
  }
  if (member.ciBranch !== undefined) {
    validateToken(member.ciBranch, `${label}.ciBranch`, runtime.TRIGGER_MAX_BRANCH_LENGTH, errors);
  }
  if (member.userAllowlist !== undefined) {
    if (!Array.isArray(member.userAllowlist)) {
      errors.push(`${label}.userAllowlist must be an array.`);
    } else {
      if (member.userAllowlist.length > runtime.TRIGGER_MAX_ALLOWLIST_LOGINS) {
        errors.push(`${label}.userAllowlist exceeds ${runtime.TRIGGER_MAX_ALLOWLIST_LOGINS} entries.`);
      }
      const seen = new Set();
      for (const [index, login] of member.userAllowlist.entries()) {
        validateToken(login, `${label}.userAllowlist[${index}]`, runtime.TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH, errors);
        if (typeof login === "string") {
          const normalized = login.trim().replace(/^@+/, "").toLowerCase();
          if (normalized.length === 0) errors.push(`${label}.userAllowlist[${index}] is empty after removing @.`);
          if (seen.has(normalized)) warnings.push(`${label}.userAllowlist contains duplicate ${JSON.stringify(normalized)}.`);
          seen.add(normalized);
        }
      }
    }
  }
}

function validateTeams(member, label, runtime, errors, warnings) {
  rejectUnknownKeys(member, [
    "type",
    "tenantId",
    "teamId",
    "teamIds",
    "channelIds",
    "messageContains",
    "messageContainsIsRegex",
    "blockUnauthenticatedTeamsUsers",
  ], label, errors);
  validateToken(member.tenantId, `${label}.tenantId`, runtime.TRIGGER_MAX_ID_LENGTH, errors);
  const teams = validateStringList(member.teamIds, `${label}.teamIds`, runtime, errors, warnings);
  if (member.teamId !== undefined) validateToken(member.teamId, `${label}.teamId`, runtime.TRIGGER_MAX_ID_LENGTH, errors, { allowEmpty: true });
  if ((typeof member.teamId !== "string" || member.teamId.trim().length === 0) && teams.length === 0) {
    errors.push(`${label} needs teamId or at least one teamIds entry.`);
  }
  validateStringList(member.channelIds, `${label}.channelIds`, runtime, errors, warnings);
  if (member.messageContains !== undefined) {
    validateToken(member.messageContains, `${label}.messageContains`, runtime.TRIGGER_MAX_KEYWORD_LENGTH, errors, { allowEmpty: true });
  }
  for (const key of ["messageContainsIsRegex", "blockUnauthenticatedTeamsUsers"]) {
    if (member[key] !== undefined && typeof member[key] !== "boolean") errors.push(`${label}.${key} must be boolean.`);
  }
}

function validateCaseTrigger(member, label, runtime, errors, warnings) {
  const memberKeys = member.type === "linear"
    ? ["type", "event", "projectIds", "teamIds"]
    : member.type === "sentry"
      ? ["type", "event", "projectIds"]
      : ["type", "event", "serviceIds"];
  rejectUnknownKeys(member, memberKeys, label, errors);
  if (!record(member.event)) {
    errors.push(`${label}.event.case is required.`);
    return;
  }
  if (member.type === "linear") {
    const eventKeys = member.event.case === "statusChanged"
      ? ["case", "statusIds"]
      : member.event.case === "endOfCycle"
        ? ["case", "cycleIds"]
        : ["case"];
    rejectUnknownKeys(member.event, eventKeys, `${label}.event`, errors);
    if (typeof member.event.case !== "string") {
      errors.push(`${label}.event.case is required.`);
      return;
    }
    if (!runtime.LINEAR_EVENT_CASES.includes(member.event.case)) errors.push(`${label}.event.case is unsupported.`);
    validateStringList(member.projectIds, `${label}.projectIds`, runtime, errors, warnings);
    validateStringList(member.teamIds, `${label}.teamIds`, runtime, errors, warnings);
    if (member.event.case === "statusChanged") validateStringList(member.event.statusIds, `${label}.event.statusIds`, runtime, errors, warnings);
    if (member.event.case === "endOfCycle") validateStringList(member.event.cycleIds, `${label}.event.cycleIds`, runtime, errors, warnings);
    return;
  }
  if (member.type === "sentry") {
    rejectUnknownKeys(member.event, ["case"], `${label}.event`, errors);
    if (typeof member.event.case !== "string") {
      errors.push(`${label}.event.case is required.`);
      return;
    }
    if (!runtime.SENTRY_EVENT_CASES.includes(member.event.case)) errors.push(`${label}.event.case is unsupported.`);
    validateStringList(member.projectIds, `${label}.projectIds`, runtime, errors, warnings);
    return;
  }
  rejectUnknownKeys(member.event, ["case"], `${label}.event`, errors);
  if (typeof member.event.case !== "string") {
    errors.push(`${label}.event.case is required.`);
    return;
  }
  if (!runtime.PAGERDUTY_EVENT_CASES.includes(member.event.case)) errors.push(`${label}.event.case is unsupported.`);
  validateStringList(member.serviceIds, `${label}.serviceIds`, runtime, errors, warnings);
}

function validateMember(member, label, runtime, options, errors, warnings, schedulePreview) {
  if (!record(member) || typeof member.type !== "string") {
    errors.push(`${label} must be a trigger object with type.`);
    return;
  }
  if (member.type === "cron") return validateCron(member, label, runtime, options, errors, warnings, schedulePreview);
  if (member.type === "slack") return validateSlack(member, label, runtime, errors, warnings);
  if (member.type === "github") return validateGithub(member, label, runtime, errors, warnings);
  if (member.type === "microsoftTeams") return validateTeams(member, label, runtime, errors, warnings);
  if (["linear", "sentry", "pagerduty"].includes(member.type)) {
    return validateCaseTrigger(member, label, runtime, errors, warnings);
  }
  errors.push(`${label}.type ${JSON.stringify(member.type)} is unsupported.`);
}

function validateSpec(root, runtime, options) {
  const errors = [];
  const warnings = [];
  const schedulePreview = [];
  if (!record(root)) return { errors: ["Input must be a JSON object."], warnings, schedulePreview };
  const spec = record(root.spec) ? root.spec : root;

  rejectUnknownKeys(spec, ["name", "prompt", "trigger", "isEnabled"], "spec", errors);
  validateToken(spec.name, "spec.name", runtime.AUTOMATION_MAX_NAME_LENGTH, errors);
  if (typeof spec.prompt !== "string" || spec.prompt.trim().length === 0) errors.push("spec.prompt must be a non-empty string.");
  if (spec.isEnabled !== undefined && typeof spec.isEnabled !== "boolean") errors.push("spec.isEnabled must be boolean when present.");
  if (!record(spec.trigger)) {
    errors.push("spec.trigger must be an object.");
  } else if (spec.trigger.type === "group") {
    rejectUnknownKeys(spec.trigger, ["type", "listeners"], "spec.trigger", errors);
    if (!Array.isArray(spec.trigger.listeners)) {
      errors.push("spec.trigger.listeners must be an array.");
    } else {
      if (spec.trigger.listeners.length < 2) errors.push("A group trigger needs at least two members.");
      if (spec.trigger.listeners.length > runtime.TRIGGER_MAX_GROUP_LISTENERS) {
        errors.push(`A group trigger exceeds ${runtime.TRIGGER_MAX_GROUP_LISTENERS} members; the host would truncate it.`);
      }
      for (const [index, member] of spec.trigger.listeners.entries()) {
        validateMember(member, `spec.trigger.listeners[${index}]`, runtime, options, errors, warnings, schedulePreview);
      }
      const hasCron = spec.trigger.listeners.some((member) => record(member) && member.type === "cron");
      const hasEvent = spec.trigger.listeners.some((member) => record(member) && member.type !== "cron");
      if (hasCron && hasEvent) warnings.push("Mixed cron/event groups are runtime-supported OR, but are discouraged as a deadline or AND construct.");
      warnings.push("Group semantics are OR: any valid member fires the same prompt.");
    }
  } else {
    validateMember(spec.trigger, "spec.trigger", runtime, options, errors, warnings, schedulePreview);
  }

  let normalizedTrigger = null;
  if (errors.length === 0) {
    normalizedTrigger = runtime.parseStoredTrigger(spec.trigger);
    if (normalizedTrigger == null) errors.push("The runtime trigger parser rejected this trigger.");
  }
  if (errors.length > 0 || normalizedTrigger == null) return { errors, warnings, schedulePreview };

  const normalizedSpec = {
    name: runtime.clampAutomationName(spec.name),
    prompt: runtime.normalizeAutomationPrompt(spec.prompt),
    trigger: runtime.serializeStoredTrigger(normalizedTrigger),
    ...(spec.isEnabled === undefined ? {} : { isEnabled: spec.isEnabled }),
  };
  return {
    errors,
    warnings,
    schedulePreview,
    normalizedSpec,
    description: runtime.describeTrigger(normalizedTrigger),
    hasCron: runtime.triggerCronSchedules(normalizedTrigger).length > 0,
    hasEvent: runtime.triggerEventTriggers(normalizedTrigger).length > 0,
  };
}

function validateWorkflowSpec(root, runtime, options) {
  const errors = [];
  const warnings = [];
  const schedulePreview = [];
  if (!record(root)) return { errors: ["Input must be a JSON object."], warnings, schedulePreview };
  const spec = record(root.spec) ? root.spec : root;

  rejectUnknownKeys(spec, ["name", "description", "body", "trigger", "sourceRef"], "spec", errors);
  validateToken(spec.name, "spec.name", runtime.WORKFLOW_MAX_NAME_LENGTH, errors);
  validateToken(spec.description, "spec.description", runtime.WORKFLOW_MAX_DESCRIPTION_LENGTH, errors, { allowEmpty: true });
  if (typeof spec.body !== "string") {
    errors.push("spec.body must be a string.");
  } else {
    if (spec.body.trim().length === 0) errors.push("spec.body must not be empty.");
    if (spec.body.trim().length > runtime.WORKFLOW_MAX_BODY_LENGTH) {
      errors.push(`spec.body exceeds ${runtime.WORKFLOW_MAX_BODY_LENGTH} characters.`);
    }
  }
  if (spec.sourceRef !== undefined && spec.sourceRef !== null) {
    if (typeof spec.sourceRef !== "string") {
      errors.push("spec.sourceRef must be a string or null when present.");
    } else {
      if (spec.sourceRef.length === 0) errors.push("spec.sourceRef must not be empty when present.");
      if (/\r|\n/.test(spec.sourceRef)) errors.push("spec.sourceRef must be one line.");
    }
  }

  if (!Object.hasOwn(spec, "trigger")) {
    errors.push("spec.trigger is required; use null for a plain workflow.");
  } else if (spec.trigger !== null) {
    if (!record(spec.trigger)) {
      errors.push("spec.trigger must be null or an object.");
    } else {
      rejectUnknownKeys(spec.trigger, ["schedule", "isEnabled"], "spec.trigger", errors);
      if (typeof spec.trigger.isEnabled !== "boolean") errors.push("spec.trigger.isEnabled must be boolean.");
      validateCron(
        { type: "cron", schedule: spec.trigger.schedule },
        "spec.trigger",
        runtime,
        options,
        errors,
        warnings,
        schedulePreview,
      );
    }
  }

  if (errors.length > 0) return { errors, warnings, schedulePreview };
  const normalizedSpec = {
    name: runtime.clampWorkflowName(spec.name),
    description: runtime.clampWorkflowDescription(spec.description),
    body: runtime.clampWorkflowBody(spec.body),
    trigger: spec.trigger === null
      ? null
      : {
          schedule: runtime.normalizeSchedule(spec.trigger.schedule),
          isEnabled: spec.trigger.isEnabled,
        },
    ...(spec.sourceRef === undefined ? {} : { sourceRef: spec.sourceRef }),
  };
  return {
    errors,
    warnings,
    schedulePreview,
    normalizedSpec,
    hasSchedule: normalizedSpec.trigger !== null,
  };
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(2);
}

if (options?.help) {
  console.log(usage());
} else if (options != null) {
  let input;
  try {
    input = JSON.parse(await readSource(options.source));
  } catch (error) {
    console.error(`Could not read valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const runtime = await loadRuntime();
  const result = options.kind === "workflow"
    ? validateWorkflowSpec(input, runtime, options)
    : validateSpec(input, runtime, options);
  const output = {
    ok: result.errors.length === 0,
    contract: options.kind === "workflow"
      ? "reconstructed-host WorkflowSpec"
      : "reconstructed-host AutomationSpec",
    ...result,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}
