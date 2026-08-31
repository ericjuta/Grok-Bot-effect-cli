import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadValidator() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-schema-validation-"));
  const output = path.join(temporary, "validator.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/schema-validation.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("gateway schema validation enforces the advertised object, array, URI, and base64 constraints", async () => {
  const loaded = await loadValidator();
  try {
    const schema = {
      type: "object",
      properties: {
        ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        url: { type: "string", format: "uri" },
        payload: { type: "string", contentEncoding: "base64" },
      },
      required: ["ids", "url", "payload"],
      additionalProperties: false,
    };
    assert.deepEqual(loaded.module.validateGatewayJsonSchema(schema, {
      ids: ["agent-one"],
      url: "https://example.test/logo.png",
      payload: "AQIDBA==",
    }), []);

    const issues = loaded.module.validateGatewayJsonSchema(schema, {
      ids: [],
      url: "/relative",
      payload: "not base64",
      surprise: true,
    });
    assert.deepEqual(
      new Set(issues.map((issue) => issue.keyword)),
      new Set(["minItems", "format", "contentEncoding", "additionalProperties"]),
    );
    assert.ok(issues.every((issue) => !JSON.stringify(issue).includes("not base64")));
  } finally {
    await loaded.dispose();
  }
});

test("gateway schema validation implements combinators, safe integers, and bounded diagnostics", async () => {
  const loaded = await loadValidator();
  try {
    const schema = {
      type: "object",
      properties: {
        selector: {
          oneOf: [
            { type: "object", properties: { type: { const: "id" }, id: { type: "integer" } }, required: ["type", "id"], additionalProperties: false },
            { type: "object", properties: { type: { const: "name" }, name: { type: "string" } }, required: ["type", "name"], additionalProperties: false },
          ],
        },
      },
      required: ["selector", "first", "second"],
      not: { required: ["forbidden"] },
      additionalProperties: false,
    };
    const issues = loaded.module.validateGatewayJsonSchema(schema, {
      selector: { type: "id", id: 1.5 },
      forbidden: true,
      extra: true,
    }, { maxIssues: 3 });
    assert.equal(issues.length, 3);
    assert.ok(issues.some((issue) => issue.keyword === "not"));
    assert.ok(issues.some((issue) => issue.keyword === "required"));

    assert.equal(loaded.module.isCanonicalBase64("TQ=="), true);
    assert.equal(loaded.module.isCanonicalBase64("TR=="), false, "non-zero trailing bits are not canonical");
    assert.equal(loaded.module.isCanonicalBase64("TQ=\n="), false);
  } finally {
    await loaded.dispose();
  }
});

test("gateway schema validation applies global complexity limits inside unconstrained values", async () => {
  const loaded = await loadValidator();
  try {
    let nested = null;
    for (let index = 0; index < 80; index += 1) nested = { next: nested };

    for (const schema of [
      {},
      { type: "object", additionalProperties: true },
      { type: "object", properties: { payload: {} } },
      { type: "array" },
    ]) {
      const value = schema.type === "array" ? [nested] : { payload: nested };
      const issues = loaded.module.validateGatewayJsonSchema(schema, value);
      assert.ok(issues.some((issue) => issue.keyword === "depth"), JSON.stringify(schema));
      assert.ok(issues.every((issue) => !JSON.stringify(issue).includes("next".repeat(4))));
    }

    const wide = Array.from({ length: 12 }, (_, index) => ({ index }));
    const workIssues = loaded.module.validateGatewayJsonSchema({}, { wide }, { maxVisitedNodes: 8 });
    assert.ok(workIssues.some((issue) => issue.keyword === "complexity"));

    const combinatorIssues = loaded.module.validateGatewayJsonSchema({
      anyOf: [{ type: "object" }, { type: "string" }],
    }, { outer: { inner: null } }, { maxVisitedNodes: 2 });
    assert.ok(combinatorIssues.some((issue) => issue.keyword === "anyOf"));

    let propertyReads = 0;
    const getters = {};
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(getters, `key${index}`, {
        enumerable: true,
        get() {
          propertyReads += 1;
          return null;
        },
      });
    }
    loaded.module.validateGatewayJsonSchema({}, getters, { maxVisitedNodes: 3 });
    assert.ok(propertyReads <= 3, `read ${propertyReads} properties after exhausting the work budget`);
  } finally {
    await loaded.dispose();
  }
});
