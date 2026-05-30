import * as path from "path";
import { ReactAdapter, Replacement } from "./adapters/react";
import { score } from "./scoring";
import { trace } from "./pass2";
import { ResolvedConfig, resolve as resolveConfig } from "./config";
import {
  ProjectGraphContext,
  findCallNodeNearLine,
  stringLiteralKey,
} from "./graph-project";
import { GraphNode, PathStep } from "./graph";
import { Verdict, StringNode, UsedTranslationKey } from "./types";
import { validateStringNodes } from "./validate";

export interface PipelineResult {
  nodes: StringNode[];
  modifiedContent: string | null;
  keys: Record<string, Record<string, string>>;
  wrapped: Replacement[];
  unresolved: StringNode[];
  flaggedDynamic: StringNode[];
  /** Pre-existing `t("...")` / `i18n.t("...")` call sites found in source. */
  usedTranslationKeys: UsedTranslationKey[];
}

export async function run(
  filePath: string,
  fileContent: string,
  options: {
    dryRun: boolean;
    usedKeys?: Set<string>;
    config?: ResolvedConfig;
    graphContext?: ProjectGraphContext;
  }
): Promise<PipelineResult> {
  const adapter = new ReactAdapter();
  const config = options.config ?? resolveConfig({}, null);

  // Pass 1 — extract and score.
  // Per acceptance #10, per-file extraction is exception-safe: a broken file
  // produces a stderr warning and continues with an empty result, so one
  // unparseable input doesn't sink the whole run. Catches everything: Babel's
  // SyntaxError, RangeError (Babel can recurse on pathological inputs — the
  // Graphify `_safe_extract` pattern), and schema-validation failures.
  let extracted: ReturnType<ReactAdapter["extract"]>;
  try {
    extracted = adapter.extract(fileContent, filePath);
    validateStringNodes(extracted.nodes, filePath);
  } catch (err) {
    process.stderr.write(
      `warn: extract failed for ${filePath} — ${(err as Error).message}\n`
    );
    return emptyResult();
  }
  const { nodes, usedTranslationKeys } = extracted;

  const scoreCtx = options.graphContext
    ? {
        resolveCallNode: (file: string, calleeName: string, line: number) =>
          findCallNodeNearLine(
            options.graphContext!.callIndex,
            file,
            calleeName,
            line
          ),
      }
    : undefined;

  for (const node of nodes) {
    const { confidence, verdict, source, matchedViaAlias } = score(
      node,
      config.registry,
      scoreCtx
    );
    node.confidence = confidence;
    node.verdict = verdict;
    if (source) node.confidenceSource = source;
    if (matchedViaAlias) {
      process.stderr.write(
        `warn: ${filePath}:${node.line} — wrapped via aliased import ` +
          `(source-code name "${matchedViaAlias}" matched registry entry by ` +
          `resolved name). Consider registering the alias explicitly.\n`
      );
    }
  }

  // Pass 2 — cross-file trace. Only runs when a graph context is supplied.
  // Without one (e.g. legacy callers, isolated unit tests), Escalate falls
  // through to Unresolved — preserves Phase 0 behavior exactly.
  for (const node of nodes) {
    if (node.verdict !== Verdict.Escalate) continue;
    if (!options.graphContext) {
      node.verdict = Verdict.Unresolved;
      continue;
    }
    const result = runTrace(node, options.graphContext, config);
    node.trace = result.trace;
    if (result.resolved) {
      node.verdict = Verdict.Wrap;
      node.confidenceSource = "traced";
    } else {
      node.verdict = Verdict.Unresolved;
    }
  }

  const toWrap = nodes.filter((n) => n.verdict === Verdict.Wrap);
  const unresolved = nodes.filter((n) => n.verdict === Verdict.Unresolved);
  const flaggedDynamic = nodes.filter((n) => n.verdict === Verdict.FlagDynamic);

  const keys: Record<string, Record<string, string>> = {};
  // When a shared set is passed in, key uniqueness is enforced across files.
  const usedKeys = options.usedKeys ?? new Set<string>();
  const replacements: Replacement[] = toWrap.map((node) => {
    const { namespace, slug } = generateKey(node);
    const keyName = uniqueKey(`${namespace}.${slug}`, usedKeys);
    const dot = keyName.indexOf(".");
    const ns = keyName.slice(0, dot);
    const sl = keyName.slice(dot + 1);
    if (!keys[ns]) keys[ns] = {};
    keys[ns][sl] = node.text;
    return { node, keyName };
  });

  const modifiedContent = options.dryRun
    ? null
    : await adapter.mutate(fileContent, replacements);

  return {
    nodes,
    modifiedContent,
    keys,
    wrapped: replacements,
    unresolved,
    flaggedDynamic,
    usedTranslationKeys,
  };
}

function generateKey(node: StringNode): { namespace: string; slug: string } {
  // Phase 0 scheme: namespace = enclosing component (lowercased) or "common".
  // Slug = first 4 alphanum words of the text. Joined as `${namespace}.${slug}`
  // for the runtime `t()` call; en.json nests them as { [namespace]: { [slug]: text } }.
  const namespace = node.signals.componentName?.toLowerCase() ?? "common";
  const slug =
    node.text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join("_") || "key";
  return { namespace, slug };
}

function uniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const finalKey = `${base}_${i}`;
  used.add(finalKey);
  return finalKey;
}

/**
 * Trace a single Pass-1-escalated string through the project graph.
 * Returns a `resolved` flag (for verdict mapping) and a denormalized `trace`
 * shape that fits `StringNode.trace`. The full structured `TraceResult` from
 * pass2 stays in scope here only — richer rendering uses the graph directly.
 */
function runTrace(
  node: StringNode,
  ctx: ProjectGraphContext,
  config: ResolvedConfig
): {
  resolved: boolean;
  trace: { sink: string | null; depth: number; path: string[] };
} {
  const candidates = ctx.stringIndex.get(
    stringLiteralKey(node.file, node.line, node.text)
  );
  const seed = candidates?.[0];
  if (!seed) {
    return {
      resolved: false,
      trace: { sink: null, depth: 0, path: ["seed missing from graph"] },
    };
  }
  const result = trace(seed, ctx.graph, config.registry, config.pass2.maxDepth, {
    inferStringProps: ctx.inferStringProps,
    resolveWrapperTargets: ctx.resolveWrapperTargets,
  });
  if (result.resolved) {
    if (result.sink.matchedViaAlias) {
      process.stderr.write(
        `warn: ${node.file}:${node.line} — traced wrap via aliased import ` +
          `(source-code name "${result.sink.matchedViaAlias}" matched registry ` +
          `entry "${result.sink.name}" by resolved name).\n`
      );
    }
    if (result.sink.matchedViaWrapper) {
      process.stderr.write(
        `warn: ${node.file}:${node.line} — traced wrap via wrapper component ` +
          `("${result.sink.matchedViaWrapper}" resolves to registry entry ` +
          `"${result.sink.name}"). Verify the wrapper preserves the sink's props.\n`
      );
    }
    return {
      resolved: true,
      trace: {
        sink: `${result.sink.kind}:${result.sink.name}`,
        depth: result.depth,
        path: result.path.map(formatPathStep),
      },
    };
  }
  return {
    resolved: false,
    trace: {
      sink: null,
      depth: 0,
      path: [`exhausted: ${result.exhausted}`],
    },
  };
}

/**
 * Human-friendly rendering of a single trace step. Includes the file + line
 * of the destination node so the audit output can reference the exact spot.
 * Format aligns with the spec's example:
 *   "assigned to errorMsg in Form.tsx:38"
 *   "passed as prop 'message' to <Toast> in PaymentPanel.tsx:74"
 */
function formatPathStep(step: PathStep): string {
  const loc = `${path.basename(step.node.file)}:${step.node.line}`;
  const target = describeGraphNode(step.node);
  switch (step.edge.type) {
    case "assigned_to":
      return `assigned to ${target} in ${loc}`;
    case "passed_as_arg":
      return `passed as arg ${step.edge.argIndex} to ${target} in ${loc}`;
    case "passed_as_prop":
      return `passed as prop '${step.edge.propName}' to ${target} in ${loc}`;
    case "returned_from":
      return `returned from ${target} in ${loc}`;
    case "imports":
      // The BFS does not traverse `imports` edges, so we should never see one
      // here — but format defensively rather than crash on a future change.
      return `imported via ${target}`;
  }
}

function describeGraphNode(n: GraphNode): string {
  switch (n.type) {
    case "symbol":
      return n.name;
    case "call-expression":
      return `${n.calleeName ?? "<expr>"}(…)`;
    case "jsx-element":
      return `<${n.tagName}>`;
    case "string-literal":
      return JSON.stringify(truncate(n.text));
    case "module":
      return "module";
  }
}

function truncate(s: string, n: number = 24): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Returned when extraction fails for a single file (acceptance #10). Looks
 * like a no-op pipeline pass — empty arrays, no modified content — so the
 * downstream merge/audit logic treats the file as having no work to do.
 */
function emptyResult(): PipelineResult {
  return {
    nodes: [],
    modifiedContent: null,
    keys: {},
    wrapped: [],
    unresolved: [],
    flaggedDynamic: [],
    usedTranslationKeys: [],
  };
}
