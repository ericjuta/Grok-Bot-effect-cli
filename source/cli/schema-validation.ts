import type { GatewayJsonSchema } from "./catalog.js";

export interface GatewaySchemaValidationIssue {
  /** JSON Pointer rooted at `$`; values are never included in diagnostics. */
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface GatewaySchemaValidationOptions {
  readonly maxDepth?: number;
  readonly maxIssues?: number;
  readonly maxVisitedNodes?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ISSUES = 16;
const DEFAULT_MAX_VISITED_NODES = 250_000;
const UNCONSTRAINED_JSON_VALUE_SCHEMA: GatewayJsonSchema = {};

interface ValidationBudget {
  visitedNodes: number;
  exhausted: boolean;
}

interface ValidationState {
  readonly issues: GatewaySchemaValidationIssue[];
  readonly maxDepth: number;
  readonly maxIssues: number;
  readonly maxVisitedNodes: number;
  readonly budget: ValidationBudget;
}

function pointer(path: string, key: string | number): string {
  const encoded = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${encoded}`;
}

function issue(
  state: ValidationState,
  path: string,
  keyword: string,
  message: string,
): void {
  if (state.issues.length >= state.maxIssues) return;
  state.issues.push({ path, keyword, message });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: return false;
  }
}

/** Strict RFC 4648 base64 without whitespace or non-canonical trailing bits. */
export function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = code >= 65 && code <= 90
      || code >= 97 && code <= 122
      || code >= 48 && code <= 57
      || code === 43
      || code === 47;
    if (!valid) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  const alphabetIndex = (code: number): number => {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    return code === 43 ? 62 : code === 47 ? 63 : -1;
  };
  if (padding === 2) {
    const final = alphabetIndex(value.charCodeAt(dataLength - 1));
    if (final < 0 || (final & 0x0f) !== 0) return false;
  } else if (padding === 1) {
    const final = alphabetIndex(value.charCodeAt(dataLength - 1));
    if (final < 0 || (final & 0x03) !== 0) return false;
  }
  return true;
}

function validFormat(value: string, format: string): boolean {
  switch (format) {
    case "uri":
    case "url":
      try {
        const parsed = new URL(value);
        return parsed.protocol.length > 1;
      } catch {
        return false;
      }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    default:
      // Unknown formats are annotations under JSON Schema and must not make an
      // otherwise valid request fail.
      return true;
  }
}

function schemaMatches(
  schema: GatewayJsonSchema,
  value: unknown,
  path: string,
  depth: number,
  parent: ValidationState,
): boolean {
  const child: ValidationState = {
    ...parent,
    issues: [],
    maxIssues: 1,
  };
  validate(schema, value, path, depth, child);
  return child.issues.length === 0;
}

function stableJson(value: unknown, depth = 0): string | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (const item of value) {
      const encoded = stableJson(item, depth + 1);
      if (encoded === undefined) return undefined;
      entries.push(encoded);
    }
    return `[${entries.join(",")}]`;
  }
  if (isRecord(value)) {
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = stableJson(value[key], depth + 1);
      if (encoded === undefined) return undefined;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  }
  return undefined;
}

function validate(
  schema: GatewayJsonSchema,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): void {
  if (state.issues.length >= state.maxIssues) return;
  state.budget.visitedNodes += 1;
  if (state.budget.visitedNodes > state.maxVisitedNodes) {
    state.budget.exhausted = true;
    // schemaMatches uses an isolated issue list while sharing the global work
    // budget. Every branch must observe exhaustion as a failure; otherwise a
    // later anyOf/oneOf branch could spuriously match with an empty issue list.
    issue(state, path, "complexity", `validation exceeds the ${state.maxVisitedNodes}-node work limit`);
    return;
  }
  if (depth > state.maxDepth) {
    issue(state, path, "depth", `value nesting exceeds the ${state.maxDepth}-level limit`);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((type) => matchesType(value, type))) {
      issue(state, path, "type", `must be ${expected.join(" or ")}; received ${actualType(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issue(state, path, "const", "must equal the schema's constant value");
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => Object.is(value, entry))) {
    issue(state, path, "enum", "must be one of the allowed values");
  }

  if (schema.allOf !== undefined) {
    for (const branch of schema.allOf) validate(branch, value, path, depth + 1, state);
  }
  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some((branch) => schemaMatches(branch, value, path, depth + 1, state));
    if (!matches) issue(state, path, "anyOf", "must match at least one allowed schema");
  }
  if (schema.oneOf !== undefined) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      if (schemaMatches(branch, value, path, depth + 1, state)) matches += 1;
    }
    if (matches !== 1) issue(state, path, "oneOf", "must match exactly one allowed schema");
  }
  if (schema.not !== undefined && schemaMatches(schema.not, value, path, depth + 1, state)) {
    issue(state, path, "not", "matches a disallowed schema");
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issue(state, path, "minLength", `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issue(state, path, "maxLength", `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) issue(state, path, "pattern", "does not match the required pattern");
      } catch {
        issue(state, path, "pattern", "uses an invalid schema pattern");
      }
    }
    if (schema.format !== undefined && !validFormat(value, schema.format)) {
      issue(state, path, "format", `must be a valid ${schema.format}`);
    }
    if (schema.contentEncoding === "base64" && !isCanonicalBase64(value)) {
      issue(state, path, "contentEncoding", "must be canonical base64 without whitespace");
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issue(state, path, "minimum", `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issue(state, path, "maximum", `must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issue(state, path, "minItems", `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issue(state, path, "maxItems", `must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (let index = 0; index < value.length; index += 1) {
        const encoded = stableJson(value[index]);
        if (encoded === undefined) {
          issue(state, pointer(path, index), "uniqueItems", "could not be compared within validation limits");
          break;
        }
        if (seen.has(encoded)) {
          issue(state, pointer(path, index), "uniqueItems", "must not duplicate an earlier item");
          break;
        }
        seen.add(encoded);
      }
    }
    // Walk unconstrained items too. JSON Schema's absent `items` keyword
    // permits every value, but the CLI still has to enforce its global depth
    // and work budgets before handing the value to JSON.stringify.
    const itemSchema = schema.items ?? UNCONSTRAINED_JSON_VALUE_SCHEMA;
    for (
      let index = 0;
      index < value.length && state.issues.length < state.maxIssues && !state.budget.exhausted;
      index += 1
    ) {
      validate(itemSchema, value[index], pointer(path, index), depth + 1, state);
    }
  }

  if (isRecord(value)) {
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) issue(state, pointer(path, key), "required", "is required");
      }
    }
    const properties = schema.properties ?? {};
    // Avoid allocating an attacker-sized Object.entries array before the
    // validation node budget gets a chance to stop traversal.
    for (const key in value) {
      if (state.budget.exhausted) break;
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        validate(propertySchema, item, pointer(path, key), depth + 1, state);
      } else if (schema.additionalProperties === false) {
        issue(state, pointer(path, key), "additionalProperties", "is not an allowed property");
      } else if (typeof schema.additionalProperties === "object") {
        validate(schema.additionalProperties, item, pointer(path, key), depth + 1, state);
      } else {
        // `additionalProperties: true` (and the default when omitted) permits
        // the property semantically; it does not exempt its descendants from
        // the CLI's global JSON complexity limits.
        validate(UNCONSTRAINED_JSON_VALUE_SCHEMA, item, pointer(path, key), depth + 1, state);
      }
      if (state.issues.length >= state.maxIssues) break;
    }
  }
}

/**
 * Validate JSON input against the exact schema advertised in MCP tools/list.
 * Diagnostics intentionally describe only paths and constraints, never input
 * values, so credentials cannot be reflected into protocol errors.
 */
export function validateGatewayJsonSchema(
  schema: GatewayJsonSchema,
  value: unknown,
  options: GatewaySchemaValidationOptions = {},
): readonly GatewaySchemaValidationIssue[] {
  const maxDepth = Number.isSafeInteger(options.maxDepth) && (options.maxDepth ?? 0) > 0
    ? options.maxDepth!
    : DEFAULT_MAX_DEPTH;
  const maxIssues = Number.isSafeInteger(options.maxIssues) && (options.maxIssues ?? 0) > 0
    ? options.maxIssues!
    : DEFAULT_MAX_ISSUES;
  const maxVisitedNodes = Number.isSafeInteger(options.maxVisitedNodes) && (options.maxVisitedNodes ?? 0) > 0
    ? options.maxVisitedNodes!
    : DEFAULT_MAX_VISITED_NODES;
  const state: ValidationState = {
    issues: [],
    maxDepth,
    maxIssues,
    maxVisitedNodes,
    budget: { visitedNodes: 0, exhausted: false },
  };
  validate(schema, value, "$", 0, state);
  return state.issues;
}

export function formatGatewaySchemaIssues(issues: readonly GatewaySchemaValidationIssue[]): string {
  return issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ");
}
