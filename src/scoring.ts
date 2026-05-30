import {
  ConfidenceSource,
  FunctionSink,
  StringNode,
  StringKind,
  Verdict,
  SinkRegistry,
} from "./types";
import { matchFilePathOk } from "./sink-match";
import { isUiPropName } from "./type-info";
import { CallExpressionNode } from "./graph";

// Confidence thresholds. Tuned against Phase 0 fixtures; revisit as the corpus grows.
const HIGH_CONFIDENCE = 0.75;
const LOW_CONFIDENCE = 0.25;

export interface ScoreResult {
  confidence: number;
  verdict: Verdict;
  /** Set when verdict === Wrap. Otherwise undefined. */
  source?: ConfidenceSource;
  /**
   * Set when a function-sink match used the resolved alias name rather than
   * the source-code name (e.g. `import { toast as showToast }` matched
   * registry entry `toast`). The pipeline surfaces this as an advisory.
   */
  matchedViaAlias?: string;
}

/**
 * Optional graph hooks. When supplied, scoring enforces `importFrom` and
 * `matchFile` constraints on function sinks (and matches aliased imports).
 * Without them, the constraint fields are bypassed — same as pre-F3 behavior.
 */
export interface ScoreContext {
  /** Look up the graph's call-expression node for a `(file, calleeName, line)` tuple. */
  resolveCallNode?: (
    file: string,
    calleeName: string,
    line: number
  ) => CallExpressionNode | undefined;
}

export function score(
  node: StringNode,
  registry: SinkRegistry,
  ctx: ScoreContext = {}
): ScoreResult {
  const s = node.signals;

  // Hard skips — decisive non-UI signals. These win even over a registered
  // sink: a console.log / logger call / test assertion is never UI copy.
  if (s.inConsoleCall) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inLoggerCall) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inTestAssertion) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inImportPath) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inUrlShape) return { confidence: 1.0, verdict: Verdict.Skip };

  // Dynamic template literals can't be statically wrapped — flag them even when
  // they sit in a sink argument, so this stays above the function-sink check.
  if (node.kind === StringKind.TemplateLiteralDynamic) {
    return { confidence: 1.0, verdict: Verdict.FlagDynamic };
  }

  // Function call sinks. This MUST run before the code-identifier skip below:
  // an explicit registration ("notify is a sink") has to beat the IDENT_SHAPE
  // heuristic — otherwise `notify("Saved")` is silently skipped because "Saved"
  // looks like an identifier. A non-match falls through to the heuristics.
  if (s.inFunctionSink) {
    const match = matchFunctionSink(node, s.inFunctionSink, registry, ctx);
    if (match) {
      return {
        confidence: 0.95,
        verdict: Verdict.Wrap,
        source: "function-sink",
        ...(match.matchedViaAlias && { matchedViaAlias: match.matchedViaAlias }),
      };
    }
  }

  // Code-identifier hard skip — now AFTER the explicit function-sink check so a
  // registered sink wins, but still catches bare identifiers everywhere else.
  if (s.isCodeIdentifier && !s.inJsxText) {
    return { confidence: 0.9, verdict: Verdict.Skip };
  }

  // Hard wraps — decisive UI signals.
  if (s.inJsxText && node.kind === StringKind.JsxText) {
    return { confidence: 1.0, verdict: Verdict.Wrap, source: "jsx-text" };
  }

  // Attribute sinks.
  if (s.inJsxAttribute) {
    const attrSink = registry.attributes.find(a => a.name === s.inJsxAttribute);
    if (attrSink) {
      const element = s.attributeElement ?? "";
      const blocked = attrSink.notOnElements?.includes(element) ?? false;
      const allowed = attrSink.onElements
        ? attrSink.onElements.includes(element)
        : true;
      if (allowed && !blocked) {
        return { confidence: 0.95, verdict: Verdict.Wrap, source: "attribute-sink" };
      }
      if (blocked) return { confidence: 0.9, verdict: Verdict.Skip };
    }
  }

  // Weighted scoring for ambiguous strings. Coefficients are priors, not measurements.
  let weighted = 0;

  if (s.enclosingFunctionIsComponent) weighted += 0.3;
  if (s.componentName) weighted += 0.1;
  // F7 (P4) — prop-name heuristics. A string in a JSX attribute is scored by
  // what the prop name suggests, not a flat boost: copy-bearing names
  // (`label`, `message`, `*Label`, …) lift it toward Wrap; structural names
  // (`className`, `id`, `role`, `type`, event handlers, `data-*`) push it down.
  // Registered attribute sinks (`title`, `placeholder`, `alt`, `aria-label`)
  // never reach here — the hard attribute-sink rule above already decided them.
  if (s.inJsxAttribute) {
    if (isUiCopyPropName(s.inJsxAttribute)) weighted += 0.35;
    else if (!isUiPropName(s.inJsxAttribute)) weighted -= 0.3;
    else weighted += 0.2; // generic/unknown prop — pre-F7 behavior
  }
  if (node.text.length > 3 && /\s/.test(node.text)) weighted += 0.2;
  if (/^[A-Z]/.test(node.text)) weighted += 0.05;
  if (/[.!?]$/.test(node.text)) weighted += 0.1;

  if (s.inThrowStatement) weighted -= 0.2;
  if (node.text.length < 4) weighted -= 0.2;
  if (/^[a-z][a-zA-Z]*$/.test(node.text)) weighted -= 0.2;
  if (/^[A-Z_]+$/.test(node.text)) weighted -= 0.3;
  if (/^\d+$/.test(node.text)) weighted -= 0.5;

  weighted = Math.max(0, Math.min(1, weighted));

  if (weighted >= HIGH_CONFIDENCE) {
    return { confidence: weighted, verdict: Verdict.Wrap, source: "weighted" };
  }
  if (weighted <= LOW_CONFIDENCE) {
    return { confidence: 1 - weighted, verdict: Verdict.Skip };
  }
  return { confidence: weighted, verdict: Verdict.Escalate };
}

/**
 * Find a registry entry that matches the Babel-discovered function-sink hit.
 *
 * Resolution rules:
 * - argIndex must match the registered `uiArgs` (or be `"all"`).
 * - When a graph call node is available via `ctx.resolveCallNode`, we also
 *   enforce `importFrom` and `matchFile` constraints and try the alias-resolved
 *   name as a fallback. When the node isn't found, constraint-bearing entries
 *   are skipped silently — F3 documented this gap.
 * - When no graph context is available at all, this collapses to pre-F3
 *   behavior: name-only match, no constraint enforcement.
 */
function matchFunctionSink(
  node: StringNode,
  hit: { name: string; argIndex: number },
  registry: SinkRegistry,
  ctx: ScoreContext
): { entry: FunctionSink; matchedViaAlias?: string } | null {
  const callNode = ctx.resolveCallNode?.(node.file, hit.name, node.line);

  const checkArgs = (entry: FunctionSink) =>
    entry.uiArgs === "all" || entry.uiArgs.includes(hit.argIndex);

  const checkConstraints = (entry: FunctionSink) => {
    const hasConstraints = !!entry.importFrom || !!entry.matchFile;
    if (!hasConstraints) return true;
    // No graph hook at all → caller is in legacy/unit-test mode. Fall back to
    // pre-F3 behavior: accept on name match alone. The CLI always provides
    // a hook, so this branch only fires in isolated tests.
    if (!ctx.resolveCallNode) return true;
    // Hook was provided but couldn't find the call node — be safe and refuse.
    if (!callNode) return false;
    if (entry.importFrom && callNode.calleeImportSpecifier !== entry.importFrom) {
      return false;
    }
    if (!matchFilePathOk(callNode.calleeDeclarationFile, entry.matchFile)) {
      return false;
    }
    return true;
  };

  // Try local source-code name first.
  for (const entry of registry.functions) {
    if (entry.name !== hit.name) continue;
    if (!checkArgs(entry)) continue;
    if (!checkConstraints(entry)) continue;
    return { entry };
  }

  // Try alias-resolved name. Requires the graph call node to know the resolved
  // name — without it, we can't tell that `showToast` actually refers to `toast`.
  const resolved = callNode?.calleeResolvedName;
  if (resolved && resolved !== hit.name) {
    for (const entry of registry.functions) {
      if (entry.name !== resolved) continue;
      if (!checkArgs(entry)) continue;
      if (!checkConstraints(entry)) continue;
      return { entry, matchedViaAlias: hit.name };
    }
  }

  return null;
}

/**
 * F7 (P4) — prop names that strongly indicate user-facing copy, so a string
 * passed to them should lean toward Wrap even without a registered sink.
 *
 * Two forms: an exact lowercase set, and a PascalCase suffix pattern that
 * catches the common `*Label` / `*Message` / `*Text` conventions
 * (`buttonLabel`, `errorMessage`, `helperText`). The suffix uses a capitalized
 * boundary so it doesn't misfire on words that merely end in the substring
 * (e.g. `context` is not `*Text`). Distinct from `isUiPropName` (F5b), which is
 * an *exclusion* blocklist for type-driven inference; this is an *inclusion*
 * signal for heuristic scoring.
 */
function isUiCopyPropName(prop: string): boolean {
  if (UI_COPY_PROP_EXACT.has(prop)) return true;
  return UI_COPY_PROP_SUFFIX.test(prop);
}

const UI_COPY_PROP_EXACT = new Set<string>([
  "label",
  "message",
  "description",
  "content",
  "caption",
  "heading",
  "header",
  "subtitle",
  "tooltip",
  "hint",
  "text",
  "title", // harmless: a registered attribute sink decides it before here
  "placeholder",
  "alt",
  "aria-label",
  "aria-description",
]);

const UI_COPY_PROP_SUFFIX =
  /(?:Label|Message|Text|Title|Description|Caption|Heading|Tooltip|Placeholder|Hint|Subtitle)$/;
