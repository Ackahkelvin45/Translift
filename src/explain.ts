/**
 * #5 `explain` + #6 trace-path visual — the "why" layer.
 *
 * One shared decision-extractor (`explainNode`) reads the decision the pipeline
 * already computed for a `StringNode` (verdict, source, signals, weighted
 * breakdown, trace) into a structured `Explanation`. Two renderers consume it:
 *
 *   - `renderExplanationText`  — the auditable text report (#5)
 *   - `renderTraceDiagram`     — a small ASCII path diagram for one string (#6)
 *
 * Nothing here re-runs scoring; it interprets the result + reuses
 * `weightedSignals` so the breakdown can never drift from `score()`.
 */
import {
  HIGH_CONFIDENCE,
  LOW_CONFIDENCE,
  WeightedTerm,
  weightedScore,
  weightedSignals,
} from "./scoring";
import { SinkRegistry, StringNode, Verdict } from "./types";

export interface Explanation {
  text: string;
  file: string;
  line: number;
  column: number;
  verdict: Verdict;
  confidence: number;
  /** The decisive, human-readable reason(s) for the verdict, most-specific first. */
  reasons: string[];
  /** Present when the verdict came from (or fell through) weighted scoring. */
  weighted?: {
    terms: WeightedTerm[];
    total: number;
    wrapAt: number;
    skipAt: number;
  };
  /** Present when Pass 2 was consulted (resolved or exhausted). */
  trace?: {
    sink: string | null;
    depth: number;
    path: string[];
    viaAlias?: string;
    viaWrapper?: string;
  };
}

/**
 * Build the structured explanation for one already-scored node. `registry` is
 * optional — when supplied, attribute-sink reasons name the matched entry.
 */
export function explainNode(
  node: StringNode,
  registry?: SinkRegistry
): Explanation {
  const s = node.signals;
  const reasons: string[] = [];

  // --- Decisive reason, mirroring score()'s branch order. -------------------
  if (node.verdict === Verdict.Skip) {
    if (s.inConsoleCall) reasons.push("inside a console.* call — never UI copy");
    else if (s.inLoggerCall) reasons.push("inside a logger call — never UI copy");
    else if (s.inTestAssertion) reasons.push("inside a test assertion — never UI copy");
    else if (s.inImportPath) reasons.push("an import path, not UI copy");
    else if (s.inUrlShape) reasons.push("looks like a URL, not UI copy");
    else if (s.isCodeIdentifier && !s.inJsxText)
      reasons.push('looks like a code identifier (single capitalized word) — IDENT_SHAPE skip');
    else if (s.inJsxAttribute && isBlockedAttributeSink(s.inJsxAttribute, s.attributeElement, registry))
      reasons.push(
        `value of attribute sink "${s.inJsxAttribute}" but blocked on <${s.attributeElement}> (notOnElements)`
      );
    else reasons.push("weighted score fell at/below the skip threshold");
  } else if (node.verdict === Verdict.FlagDynamic) {
    reasons.push("dynamic template literal — interpolated, can't be statically wrapped");
  } else if (node.verdict === Verdict.Unresolved) {
    reasons.push("ambiguous (escalated by Pass 1), and Pass 2 found no registered sink");
  } else if (node.verdict === Verdict.Wrap) {
    switch (node.confidenceSource) {
      case "jsx-text":
        reasons.push("JSX text content — always user-facing");
        break;
      case "attribute-sink":
        reasons.push(
          `value of registered attribute sink "${s.inJsxAttribute}"` +
            (s.attributeElement ? ` on <${s.attributeElement}>` : "")
        );
        break;
      case "function-sink":
        reasons.push(
          `argument to a registered function sink${
            s.inFunctionSink ? ` "${s.inFunctionSink.name}" (arg ${s.inFunctionSink.argIndex})` : ""
          }`
        );
        break;
      case "weighted":
        reasons.push("weighted score reached the wrap threshold");
        break;
      case "traced":
        reasons.push(
          `traced through the project graph to ${node.trace?.sink ?? "a sink"}` +
            (node.trace ? ` at depth ${node.trace.depth}` : "")
        );
        if (node.trace?.viaAlias)
          reasons.push(`matched via aliased import (source name "${node.trace.viaAlias}")`);
        if (node.trace?.viaWrapper)
          reasons.push(`matched by unwrapping wrapper "${node.trace.viaWrapper}"`);
        break;
      default:
        reasons.push("wrapped");
    }
  } else {
    reasons.push("escalated for review (no project graph available to trace)");
  }

  // --- Weighted breakdown, only when the verdict was actually decided by it.
  // (Hard skips and blocked attribute sinks short-circuit before weighted
  // scoring, so showing their score would imply a decision that never happened.)
  const blockedAttr = isBlockedAttributeSink(
    s.inJsxAttribute,
    s.attributeElement,
    registry
  );
  const showWeighted =
    node.verdict === Verdict.Unresolved ||
    node.verdict === Verdict.Escalate ||
    node.confidenceSource === "weighted" ||
    (node.verdict === Verdict.Skip && !hasHardSkipSignal(node) && !blockedAttr);
  const weighted = showWeighted
    ? {
        terms: weightedSignals(node),
        total: weightedScore(node),
        wrapAt: HIGH_CONFIDENCE,
        skipAt: LOW_CONFIDENCE,
      }
    : undefined;

  return {
    text: node.text,
    file: node.file,
    line: node.line,
    column: node.column,
    verdict: node.verdict,
    confidence: node.confidence,
    reasons,
    weighted,
    trace: node.trace,
  };
}

/* -------------------------------------------------------------------------- */
/* #5 — text renderer                                                         */
/* -------------------------------------------------------------------------- */

export function renderExplanationText(exp: Explanation): string {
  const lines: string[] = [];
  const loc = `${shortPath(exp.file)}:${exp.line}:${exp.column}`;
  lines.push(`${JSON.stringify(exp.text)}   ${loc}`);
  lines.push(
    `  verdict: ${exp.verdict.toUpperCase()}  (confidence ${exp.confidence.toFixed(2)})`
  );

  lines.push("  why:");
  for (const r of exp.reasons) lines.push(`    • ${r}`);

  if (exp.weighted) {
    lines.push(
      `  weighted score: ${exp.weighted.total.toFixed(2)}  ` +
        `(wrap ≥ ${exp.weighted.wrapAt}, skip ≤ ${exp.weighted.skipAt})`
    );
    if (exp.weighted.terms.length === 0) {
      lines.push("    (no signals fired)");
    } else {
      for (const t of exp.weighted.terms) {
        const sign = t.delta >= 0 ? "+" : "−";
        lines.push(`    ${sign}${Math.abs(t.delta).toFixed(2)}  ${t.label}`);
      }
    }
  }

  if (exp.trace) {
    lines.push("");
    lines.push(renderTraceDiagram(exp));
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* #6 — trace-path visual (ASCII, single string, never the whole graph)       */
/* -------------------------------------------------------------------------- */

/**
 * Render the string's path to its sink as a small vertical ASCII diagram —
 * the decision already computed in `trace.path`, for one string, on demand.
 * Deliberately NOT a whole-graph view (that's a hairball; see next-steps "do
 * NOT do"). Falls back to the exhaustion reason when Pass 2 didn't resolve.
 */
export function renderTraceDiagram(exp: Explanation): string {
  const t = exp.trace;
  if (!t) return "";
  const out: string[] = ["  trace:"];
  const start = `${JSON.stringify(truncate(exp.text))}  (${shortPath(exp.file)}:${exp.line})`;
  out.push(`    ◆ ${start}`);

  if (t.sink) {
    for (const step of t.path) {
      out.push("    │");
      out.push(`    ▼ ${step}`);
    }
    const tags = [
      t.viaAlias ? `via alias "${t.viaAlias}"` : null,
      t.viaWrapper ? `via wrapper "${t.viaWrapper}"` : null,
    ].filter(Boolean);
    out.push(`    ✅ sink: ${t.sink}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
  } else {
    // Unresolved — show how far it got.
    const reason = t.path[0] ?? "no outbound edges";
    out.push("    │");
    out.push(`    ✗ ${reason}`);
  }
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function hasHardSkipSignal(node: StringNode): boolean {
  const s = node.signals;
  return (
    s.inConsoleCall ||
    s.inLoggerCall ||
    s.inTestAssertion ||
    s.inImportPath ||
    s.inUrlShape ||
    (s.isCodeIdentifier && !s.inJsxText)
  );
}

function isBlockedAttributeSink(
  attr: string | null,
  element: string | null,
  registry?: SinkRegistry
): boolean {
  if (!attr || !registry) return false;
  const entry = registry.attributes.find((a) => a.name === attr);
  if (!entry) return false;
  return entry.notOnElements?.includes(element ?? "") ?? false;
}

function truncate(str: string, max = 32): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}
