import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repositoryRoot, ".agents", "skills");
const skillRoot = path.join(skillsRoot, "grok-bot-automations");
const generator = path.join(skillRoot, "scripts", "render-trigger-catalog.mjs");
const validator = path.join(skillRoot, "scripts", "validate-automation-spec.mjs");
const fixedNow = "2026-08-31T12:00:00Z";

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function validate(spec, extraArguments = []) {
  const result = runNode(validator, ["--json", JSON.stringify(spec), "--at", fixedNow, ...extraArguments]);
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    assert.fail(`validator returned non-JSON output:\n${result.stdout}${result.stderr}`);
  }
  return { result, output };
}

test("automation skill generated catalogue is current and covers every trigger/event surface", async () => {
  const generated = runNode(generator, ["--check"]);
  assert.equal(
    generated.status,
    0,
    `trigger catalogue generator failed:\n${generated.stdout}${generated.stderr}`,
  );

  const catalogue = await readFile(path.join(skillRoot, "references", "trigger-catalog.md"), "utf8");
  assert.match(catalogue, /\| Reconstructed native trigger families \(cron plus six event sources\) \| 7 \|/);
  assert.match(catalogue, /\| Additional audited stock-0\.30 trigger family \| 1 \(`webhook`\) \|/);
  assert.match(catalogue, /\| GitHub event kinds \| 14 \|/);
  assert.match(catalogue, /\| Upstream event channels \| 22 \|/);
  assert.match(catalogue, /\| Event channels, stock \+ reconstructed \| 16 \|/);
  assert.match(catalogue, /\| Event channels, stock only \| 2 \|/);
  assert.match(catalogue, /\| Event channels, reconstructed only \| 4 \|/);
  assert.match(catalogue, /\| Full action catalogue \| 188 \|/);
  assert.doesNotMatch(catalogue, /^\s*curl(?:\s|\\)/m, "catalogue must not include a runnable curl credential example");
  assert.doesNotMatch(catalogue, /\$\{?WEBHOOK_KEY\}?/, "catalogue must not expand webhook secrets in shell examples");

  const automationRows = catalogue.match(/^\| `(?:create|delete|get|list|run|set|update)[^`]*Automation[^`]*` \|/gm) ?? [];
  assert.equal(automationRows.length, 8, "all eight automation services must be generated");
  const workflowRows = catalogue.match(/^\| `(?:create|delete|get|import|run|set|update)[^`]*Workflow[^`]*` \|/gm) ?? [];
  assert.equal(workflowRows.length, 8, "all eight workflow services must be generated");

  for (const value of [
    "pr-opened", "pr-pushed", "pr-merged", "review-requested",
    "review-approved", "review-changes-requested", "review-commented",
    "pr-comment", "inline-review-comment", "review-thread-resolved",
    "review-thread-unresolved", "issue-assigned", "ci-passed", "ci-failed",
    "issueCreated", "statusChanged", "endOfCycle", "issueResolved",
    "issueAssigned", "issueArchived", "issueUnresolved", "issueAny",
    "incidentTriggered", "incidentAcknowledged", "incidentResolved",
    "incidentEscalated", "incidentAny",
  ]) {
    assert.match(catalogue, new RegExp(`\\b${value}\\b`), `${value} must remain documented`);
  }
});

test("automation spec preflight round-trips every reconstructed trigger family", () => {
  const spec = {
    name: "Trigger breadth",
    prompt: "Validate the event, re-read authoritative state, and remain silent unless actionable.",
    trigger: {
      type: "group",
      listeners: [
        { type: "cron", schedule: "CRON_TZ=Europe/London 30 8 * * 1-5" },
        { type: "slack", channel: "*", match: { kind: "reaction", emoji: ["eyes"], bySelf: true } },
        { type: "github", repo: "ericjuta/Grok-Bot-effect-cli", events: ["ci-failed"], ciBranch: "main" },
        { type: "microsoftTeams", tenantId: "tenant", teamId: "", teamIds: ["team"], channelIds: [], messageContains: "deploy", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: true },
        { type: "linear", event: { case: "endOfCycle", cycleIds: ["cycle"] }, projectIds: [], teamIds: ["team"] },
        { type: "sentry", event: { case: "issueAny" }, projectIds: [] },
        { type: "pagerduty", event: { case: "incidentAny" }, serviceIds: [] },
      ],
    },
    isEnabled: false,
  };
  const { result, output } = validate(spec);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.ok, true);
  assert.equal(output.normalizedSpec.trigger.listeners.length, 7);
  assert.equal(output.schedulePreview[0].nextRunAt, "2026-09-01T07:30:00.000Z");
  assert.equal(output.hasCron, true);
  assert.equal(output.hasEvent, true);
  assert.ok(output.warnings.some((warning) => /runtime-supported OR/.test(warning)));
  assert.ok(output.warnings.some((warning) => /Group semantics are OR/.test(warning)));
});

test("automation spec preflight rejects silent-loss and nonportable failure cases", () => {
  const tightInterval = validate({
    name: "Tight interval",
    prompt: "Check.",
    trigger: { type: "cron", schedule: "@every 1m" },
  });
  assert.equal(tightInterval.result.status, 0);
  assert.ok(tightInterval.output.warnings.some((warning) => /five-minute stock-UI floor/.test(warning)));

  const ciWithoutBranch = validate({
    name: "Bad CI",
    prompt: "Report CI.",
    trigger: { type: "github", repo: "owner/repo", events: ["ci-failed"] },
  });
  assert.equal(ciWithoutBranch.result.status, 1);
  assert.match(ciWithoutBranch.output.errors.join("\n"), /ciBranch is required/);

  const ciBranchWithoutCi = validate({
    name: "Ignored branch",
    prompt: "Report reviews.",
    trigger: { type: "github", repo: "owner/repo", events: ["review-requested"], ciBranch: "main" },
  });
  assert.equal(ciBranchWithoutCi.result.status, 1);
  assert.match(ciBranchWithoutCi.output.errors.join("\n"), /ciBranch.*no CI event/);

  const githubUnknownField = validate({
    name: "Lossy GitHub filter",
    prompt: "Report the PR.",
    trigger: { type: "github", repo: "owner/repo", events: ["pr-opened"], prNumber: 42 },
  });
  assert.equal(githubUnknownField.result.status, 1);
  assert.match(githubUnknownField.output.errors.join("\n"), /spec\.trigger\.prNumber.*ignored/);

  const slackWrongMatchField = validate({
    name: "Lossy Slack filter",
    prompt: "Report the message.",
    trigger: { type: "slack", channel: "C123", match: { kind: "message", keyword: "deploy" } },
  });
  assert.equal(slackWrongMatchField.result.status, 1);
  assert.match(slackWrongMatchField.output.errors.join("\n"), /spec\.trigger\.match\.keyword.*ignored/);

  const linearWrongCaseField = validate({
    name: "Lossy Linear filter",
    prompt: "Report the status change.",
    trigger: {
      type: "linear",
      event: { case: "statusChanged", statusIds: ["done"], cycleIds: ["cycle"] },
      projectIds: [],
      teamIds: [],
    },
  });
  assert.equal(linearWrongCaseField.result.status, 1);
  assert.match(linearWrongCaseField.output.errors.join("\n"), /spec\.trigger\.event\.cycleIds.*ignored/);

  const impossibleCron = validate({
    name: "Impossible schedule",
    prompt: "Run.",
    trigger: { type: "cron", schedule: "0 0 30 2 *" },
  }, ["--time-zone", "UTC"]);
  assert.equal(impossibleCron.result.status, 1);
  assert.match(impossibleCron.output.errors.join("\n"), /no next run within/);

  const tooMany = validate({
    name: "Oversized group",
    prompt: "Run.",
    trigger: {
      type: "group",
      listeners: Array.from({ length: 9 }, (_, index) => ({
        type: "cron",
        schedule: `${index % 60} 9 * * 1-5`,
      })),
    },
  });
  assert.equal(tooMany.result.status, 1);
  assert.match(tooMany.output.errors.join("\n"), /exceeds 8 members/);

  const stockOnlyWebhook = validate({
    name: "Stock webhook",
    prompt: "Handle the webhook.",
    trigger: { type: "webhook" },
  });
  assert.equal(stockOnlyWebhook.result.status, 1);
  assert.match(stockOnlyWebhook.output.errors.join("\n"), /webhook.*unsupported/);
});

test("automation spec preflight requires deterministic cron timezone context", () => {
  const unpinned = validate({
    name: "Local morning",
    prompt: "Run the check.",
    trigger: { type: "cron", schedule: "0 9 * * 1-5" },
  });
  assert.equal(unpinned.result.status, 1);
  assert.match(unpinned.output.errors.join("\n"), /unpinned cron.*--time-zone/);

  const explicitZone = validate({
    name: "UTC morning",
    prompt: "Run the check.",
    trigger: { type: "cron", schedule: "0 9 * * 1-5" },
  }, ["--time-zone", "UTC"]);
  assert.equal(explicitZone.result.status, 0, explicitZone.result.stderr);
  assert.equal(explicitZone.output.ok, true);
  assert.equal(explicitZone.output.schedulePreview[0].effectiveTimeZone, "UTC");
});

test("workflow spec preflight validates plain and scheduled workflow contracts", () => {
  const plain = validate({
    name: "Incident brief",
    description: "Summarize an incident when explicitly invoked.",
    body: "# Incident brief\n\nRe-read authoritative incident state before responding.",
    trigger: null,
    sourceRef: "https://example.invalid/incident-brief.md",
  }, ["--kind", "workflow"]);
  assert.equal(plain.result.status, 0, plain.result.stderr);
  assert.equal(plain.output.ok, true);
  assert.equal(plain.output.contract, "reconstructed-host WorkflowSpec");
  assert.equal(plain.output.normalizedSpec.trigger, null);
  assert.equal(plain.output.hasSchedule, false);

  const scheduled = validate({
    name: "Weekday brief",
    description: "Create a weekday brief.",
    body: "Create the brief, then report only actionable changes.",
    trigger: { schedule: "30 8 * * 1-5", isEnabled: false },
  }, ["--kind", "workflow", "--time-zone", "Europe/London"]);
  assert.equal(scheduled.result.status, 0, scheduled.result.stderr);
  assert.equal(scheduled.output.ok, true);
  assert.equal(scheduled.output.hasSchedule, true);
  assert.equal(scheduled.output.schedulePreview[0].effectiveTimeZone, "Europe/London");

  const unpinnedScheduled = validate({
    name: "Ambiguous brief",
    description: "A schedule without timezone context.",
    body: "Create the brief.",
    trigger: { schedule: "30 8 * * 1-5", isEnabled: true },
  }, ["--kind", "workflow"]);
  assert.equal(unpinnedScheduled.result.status, 1);
  assert.match(unpinnedScheduled.output.errors.join("\n"), /unpinned cron.*--time-zone/);

  const eventShapedTrigger = validate({
    name: "Unsupported event workflow",
    description: "Must not lose event fields.",
    body: "Run when an event happens.",
    trigger: { type: "github", schedule: "0 9 * * *", isEnabled: true },
  }, ["--kind", "workflow", "--time-zone", "UTC"]);
  assert.equal(eventShapedTrigger.result.status, 1);
  assert.match(eventShapedTrigger.output.errors.join("\n"), /spec\.trigger\.type.*ignored/);
});

test("automation skill has no scaffold residue and every project skill link resolves", async () => {
  const files = [
    path.join(skillRoot, "SKILL.md"),
    path.join(skillRoot, "references", "native-routines.md"),
    path.join(skillRoot, "references", "conditional-controllers.md"),
    path.join(skillRoot, "references", "pattern-cookbook.md"),
    path.join(skillRoot, "references", "lifecycle-runbook.md"),
    path.join(skillRoot, "references", "trigger-catalog.md"),
  ];
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.match(contents[0], /^---\nname: grok-bot-automations\ndescription: .+\n---\n/);
  assert.match(contents[0], /skill:\/\/grok-bot-automations\/references\/native-routines\.md/);
  assert.doesNotMatch(contents.join("\n"), /automationWriteProvenance/, "the skill must not advertise unenforced provenance metadata");
  assert.doesNotMatch(contents[2], /2026-09-07T17:00:00Z/, "controller examples must not carry a stale concrete expiry");
  assert.match(contents[1], /daylight-saving transitions/i);
  assert.match(contents[3], /Additional service-family conditions/);
  assert.doesNotMatch(
    contents[4],
    /service (?:create|update)-agent-(?:automation|workflow) --json/,
    "private prompt and workflow bodies belong in protected payload files",
  );
  assert.match(contents[4], /service create-agent-automation --file automation-create\.json/);
  for (const [index, content] of contents.entries()) {
    assert.doesNotMatch(content, /\[TODO|TODO:/, `${path.basename(files[index])} still contains scaffold text`);
    for (const match of content.matchAll(/skill:\/\/([^/]+)\/([^\s)]+)/g)) {
      const [, skillName, resource] = match;
      const target = path.join(skillsRoot, skillName, resource);
      await assert.doesNotReject(readFile(target), `broken skill link: ${match[0]}`);
    }
  }

  const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /default_prompt: "Use \$grok-bot-automations /);
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /\.agents\/skills\/grok-bot-automations\/SKILL\.md/);
});
