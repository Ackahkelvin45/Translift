/**
 * Sub-step 3i — runtime schema validation of `StringNode` at the adapter
 * boundary.
 *
 * Borrows the pattern from Graphify's [`validate.py`](../graphify/graphify/validate.py):
 * a small guard between the adapter's loosely-typed output and the downstream
 * pipeline. If the adapter produces malformed data — missing field, wrong
 * type, enum value out of range — fail loud at the boundary rather than
 * silently corrupting Pass 1, Pass 2, or the audit output.
 *
 * Acceptance criterion #9 — a malformed `StringNode` is rejected with a clear
 * error pinpointing which file, which node, and which field is wrong.
 */
import { ConfidenceSource, StringKind, StringNode, Verdict } from "./types";

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

const STRING_KINDS = new Set<string>(Object.values(StringKind));
const VERDICTS = new Set<string>(Object.values(Verdict));
const CONFIDENCE_SOURCES = new Set<ConfidenceSource>([
  "jsx-text",
  "attribute-sink",
  "function-sink",
  "weighted",
  "traced",
]);

export function validateStringNodes(
  nodes: unknown,
  filePath: string
): asserts nodes is StringNode[] {
  if (!Array.isArray(nodes)) {
    throw new SchemaValidationError(
      `${filePath}: extractor output must be an array, got ${describe(nodes)}`
    );
  }
  nodes.forEach((n, i) => validateStringNode(n, filePath, i));
}

function validateStringNode(
  node: unknown,
  filePath: string,
  index: number
): asserts node is StringNode {
  const where = `${filePath} [#${index}]`;
  if (!node || typeof node !== "object") {
    throw new SchemaValidationError(`${where}: not an object (${describe(node)})`);
  }
  const n = node as Record<string, unknown>;

  requireString(n, "id", where);
  requireString(n, "text", where);
  requireString(n, "file", where);
  requireFiniteNumber(n, "line", where);
  requireFiniteNumber(n, "column", where);
  requireEnum(n, "kind", STRING_KINDS, where);
  requireFiniteNumber(n, "confidence", where);
  requireEnum(n, "verdict", VERDICTS, where);
  requireString(n, "contextSnippet", where);

  if (!n.signals || typeof n.signals !== "object") {
    throw new SchemaValidationError(
      `${where}: missing or invalid 'signals' (${describe(n.signals)})`
    );
  }
  validateSignals(n.signals as Record<string, unknown>, where);

  if (
    n.confidenceSource !== undefined &&
    !CONFIDENCE_SOURCES.has(n.confidenceSource as ConfidenceSource)
  ) {
    throw new SchemaValidationError(
      `${where}: 'confidenceSource' must be one of [${[...CONFIDENCE_SOURCES].join(", ")}] (got ${describe(n.confidenceSource)})`
    );
  }
}

function validateSignals(s: Record<string, unknown>, where: string): void {
  requireBoolean(s, "inJsxText", where);
  requireStringOrNull(s, "inJsxAttribute", where);
  requireStringOrNull(s, "attributeElement", where);
  requireBoolean(s, "inConsoleCall", where);
  requireBoolean(s, "inLoggerCall", where);
  requireBoolean(s, "inThrowStatement", where);
  requireBoolean(s, "inTestAssertion", where);
  requireBoolean(s, "inImportPath", where);
  requireBoolean(s, "inUrlShape", where);
  requireBoolean(s, "isCodeIdentifier", where);
  requireStringOrNull(s, "propName", where);
  requireStringOrNull(s, "componentName", where);
  requireBoolean(s, "enclosingFunctionIsComponent", where);

  if (s.inFunctionSink !== null) {
    if (!s.inFunctionSink || typeof s.inFunctionSink !== "object") {
      throw new SchemaValidationError(
        `${where}: 'signals.inFunctionSink' must be object | null (got ${describe(s.inFunctionSink)})`
      );
    }
    const f = s.inFunctionSink as Record<string, unknown>;
    if (typeof f.name !== "string" || typeof f.argIndex !== "number") {
      throw new SchemaValidationError(
        `${where}: 'signals.inFunctionSink' must have { name: string, argIndex: number }`
      );
    }
  }
}

function requireString(o: Record<string, unknown>, k: string, where: string): void {
  if (typeof o[k] !== "string") {
    throw new SchemaValidationError(
      `${where}: '${k}' must be a string (got ${describe(o[k])})`
    );
  }
}

function requireFiniteNumber(
  o: Record<string, unknown>,
  k: string,
  where: string
): void {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaValidationError(
      `${where}: '${k}' must be a finite number (got ${describe(v)})`
    );
  }
}

function requireBoolean(
  o: Record<string, unknown>,
  k: string,
  where: string
): void {
  if (typeof o[k] !== "boolean") {
    throw new SchemaValidationError(
      `${where}: '${k}' must be a boolean (got ${describe(o[k])})`
    );
  }
}

function requireStringOrNull(
  o: Record<string, unknown>,
  k: string,
  where: string
): void {
  if (o[k] !== null && typeof o[k] !== "string") {
    throw new SchemaValidationError(
      `${where}: '${k}' must be string | null (got ${describe(o[k])})`
    );
  }
}

function requireEnum(
  o: Record<string, unknown>,
  k: string,
  allowed: Set<string>,
  where: string
): void {
  const v = o[k];
  if (typeof v !== "string" || !allowed.has(v)) {
    throw new SchemaValidationError(
      `${where}: '${k}' must be one of [${[...allowed].join(", ")}] (got ${describe(v)})`
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}
