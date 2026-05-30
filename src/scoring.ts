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
// Exported so `explain` can show the same wrap/skip cutoffs the score is judged against.
export const HIGH_CONFIDENCE = 0.75;
export const LOW_CONFIDENCE = 0.25;

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

  // Position-based skips for already-handled / structural positions. POSITION,
  // not value shape: keyed on the string's OWN attribute/object key, so a value
  // that merely looks like a key isn't affected and real copy elsewhere is never
  // skipped (this is what guarantees no recall regression).
  //
  // `defaultMessage` (react-intl, as a JSX attr `<FormattedMessage defaultMessage=…/>`
  // or an object key `formatMessage({defaultMessage: …})`) is a foreign-i18n
  // SOURCE string — already translated; re-wrapping it double-translates. A full
  // foreign-sink model (recognizing the `formatMessage`/`<FormattedMessage>`
  // construct itself, roadmap #9) is the real fix; this name-based guard is the
  // cheap subset that kills the dominant false positives on react-intl codebases.
  //
  // `id`/`key` object properties are identifiers, never display copy — they only
  // reached a Wrap because `inJsxAttribute` walks up to an ancestor attribute
  // (`placeholder={formatMessage({id: 'a.b.c', …})}`), so the message key was
  // mis-read as the placeholder's text.
  if (s.inJsxAttribute === "defaultMessage") {
    return { confidence: 1.0, verdict: Verdict.Skip };
  }
  if (
    node.kind === StringKind.ObjectProperty &&
    s.objectPropertyKey &&
    ALREADY_HANDLED_OR_STRUCTURAL_KEYS.has(s.objectPropertyKey)
  ) {
    return { confidence: 1.0, verdict: Verdict.Skip };
  }

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

  // Attribute sinks. This MUST run before the code-identifier skip below for
  // the same reason the function-sink check does: a registered attribute sink
  // (`aria-label`, `title`, …) has to beat the IDENT_SHAPE heuristic, otherwise
  // an identifier-shaped value like `aria-label="Shade"` is silently skipped.
  //
  // But only the *direct* attribute value earns that win. A string buried in the
  // attribute's expression — a comparison operand (`title={x === "rectangle"}`),
  // a `t()` argument, a `||` fallback — carries `inJsxAttribute` too (the signal
  // walks up to any JSX ancestor) yet isn't the attribute's text. For those we
  // only wrap when the string isn't identifier-shaped (preserving prior
  // behavior); identifier-shaped buried strings fall through to the skip below.
  if (s.inJsxAttribute) {
    const attrSink = registry.attributes.find(a => a.name === s.inJsxAttribute);
    if (attrSink) {
      const element = s.attributeElement ?? "";
      const blocked = attrSink.notOnElements?.includes(element) ?? false;
      const allowed = attrSink.onElements
        ? attrSink.onElements.includes(element)
        : true;
      if (blocked) return { confidence: 0.9, verdict: Verdict.Skip };
      const isDirectValue = node.kind === StringKind.JsxAttribute;
      if (allowed && (isDirectValue || !s.isCodeIdentifier)) {
        return { confidence: 0.95, verdict: Verdict.Wrap, source: "attribute-sink" };
      }
    }
  }

  // Object-property sinks (gated heuristic). A string that is the direct value
  // of an object property whose KEY names copy — `contextItemLabel: "Delete"`,
  // `label: "Copy"`, `{ value: "Helvetica", text: "Normal" }` — is almost always
  // UI text. Real-world recall depends on this: action/menu/option labels are
  // routinely declared as object properties, never reaching JSX. Like the
  // attribute-sink check it must run BEFORE the code-identifier skip, or
  // single-word labels ("Copy", "Delete") die on IDENT_SHAPE.
  //
  // Gated tightly on the key name (`isUiCopyPropName`, the same inclusion set as
  // F7's JSX-attribute boost) so the vast majority of object properties —
  // `type`, `id`, `key`, config values, AST fields — are untouched. `value` next
  // to a copy-bearing `text`/`label` is itself a code value and is NOT in the
  // set, so it stays skipped.
  if (
    node.kind === StringKind.ObjectProperty &&
    s.objectPropertyKey &&
    isUiCopyObjectKey(s.objectPropertyKey) &&
    !looksLikeKeyOrEmptyValue(node.text)
  ) {
    return { confidence: 0.9, verdict: Verdict.Wrap, source: "object-property-sink" };
  }

  // Code-identifier hard skip — now AFTER the explicit function-, attribute-,
  // and object-property-sink checks so a recognized sink wins, but still catches
  // bare identifiers everywhere else.
  if (s.isCodeIdentifier && !s.inJsxText) {
    return { confidence: 0.9, verdict: Verdict.Skip };
  }

  // Hard wraps — decisive UI signals.
  if (s.inJsxText && node.kind === StringKind.JsxText) {
    return { confidence: 1.0, verdict: Verdict.Wrap, source: "jsx-text" };
  }

  // Weighted scoring for ambiguous strings. The per-term breakdown lives in
  // `weightedSignals` (single source of truth, reused by `explain`); the score
  // is its clamped sum. Coefficients are priors, not measurements.
  const weighted = weightedScore(node);

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

/**
 * Like `isUiCopyPropName` but for OBJECT-PROPERTY keys, which are far more
 * polysemous than JSX-attribute names: `text`, `title`, `content`, and
 * `description` routinely hold *data* (text-element content, chart/demo data,
 * MIME descriptions) rather than UI copy, and bare `label` often holds a
 * translation *key* (`label: "labels.alignTop"`). An Excalidraw spot-check of
 * the naive (reuse-`isUiCopyPropName`) version produced 159 wraps, ~150 of them
 * false — almost entirely from `text`/`title`/`label`. So this set deliberately
 * EXCLUDES those data-polysemous keys and keeps only keys that are reliably
 * copy: `*Label`/`label`, the `message` family, `tooltip`, `placeholder`, etc.
 * The remaining `label` ambiguity (key-shaped values) is handled by
 * `looksLikeKeyOrEmptyValue` at the call site.
 */
function isUiCopyObjectKey(key: string): boolean {
  if (UI_COPY_OBJECT_KEY_EXACT.has(key)) return true;
  return UI_COPY_OBJECT_KEY_SUFFIX.test(key);
}

/**
 * Value-shape guard for object-property sinks: reject values that are clearly
 * not display copy even under a copy-bearing key. Two shapes:
 *  - a translation key already (`labels.alignTop`, `buttons.save`) — dotted
 *    identifier segments, no whitespace; wrapping it would double-key it;
 *  - empty / whitespace-only.
 */
function looksLikeKeyOrEmptyValue(text: string): boolean {
  if (text.trim() === "") return true;
  return /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/.test(text);
}

/** One contributing term in the weighted score, with a human-readable label. */
export interface WeightedTerm {
  label: string;
  delta: number;
}

/**
 * The weighted-scoring terms that fired for `node`, each with its signed delta.
 * Single source of truth: `score()` sums these (clamped) and the `explain`
 * command renders them. Evaluation order preserved for readability.
 */
export function weightedSignals(node: StringNode): WeightedTerm[] {
  const s = node.signals;
  const t = node.text;
  const terms: WeightedTerm[] = [];
  const add = (cond: boolean, label: string, delta: number) => {
    if (cond) terms.push({ label, delta });
  };

  add(s.enclosingFunctionIsComponent, "inside a component function", 0.3);
  add(!!s.componentName, "enclosing component name present", 0.1);
  // F7 (P4) prop-name heuristics — copy-bearing props lift, structural props
  // penalize, others get the flat pre-F7 boost. Registered attribute sinks
  // never reach weighted scoring (the hard attribute-sink rule decides them).
  if (s.inJsxAttribute) {
    if (isUiCopyPropName(s.inJsxAttribute)) {
      terms.push({ label: `copy-bearing prop "${s.inJsxAttribute}"`, delta: 0.35 });
    } else if (!isUiPropName(s.inJsxAttribute)) {
      terms.push({ label: `structural prop "${s.inJsxAttribute}"`, delta: -0.3 });
    } else {
      terms.push({ label: `prop "${s.inJsxAttribute}"`, delta: 0.2 });
    }
  }
  add(t.length > 3 && /\s/.test(t), "contains whitespace (sentence-like)", 0.2);
  add(/^[A-Z]/.test(t), "starts with a capital", 0.05);
  add(/[.!?]$/.test(t), "ends with sentence punctuation", 0.1);

  add(s.inThrowStatement, "inside a throw statement", -0.2);
  add(t.length < 4, "very short (<4 chars)", -0.2);
  add(/^[a-z][a-zA-Z]*$/.test(t), "single lowercase identifier", -0.2);
  add(/^[A-Z_]+$/.test(t), "SCREAMING_CASE constant", -0.3);
  add(/^\d+$/.test(t), "purely numeric", -0.5);
  // Value-shape skip for SVG geometry / CSS values. Catches the cases the
  // structural prop-name blocklist misses (differently-named props, or values
  // that are unambiguously non-text regardless of prop): SVG path data, numeric
  // coordinate lists, `var(...)`/`calc(...)`, and CSS transform functions.
  // Decisive (-0.6) so it overrides the component/whitespace lifts these can
  // otherwise pick up. Mutually exclusive shapes, so at most one fires.
  add(looksLikeStyleOrGeometryValue(t), "SVG/CSS value shape (non-text)", -0.6);

  return terms;
}

/**
 * Heuristic: does this string look like an SVG geometry or CSS value rather
 * than human-readable copy? Deliberately narrow to avoid catching real text:
 * each branch requires structural punctuation/commands a sentence wouldn't have.
 */
function looksLikeStyleOrGeometryValue(t: string): boolean {
  // `var(--x, …)`, `calc(…)`, `url(…)`, `rgb/rgba/hsl(…)`.
  if (/^(?:var|calc|url|rgba?|hsla?)\s*\(/.test(t)) return true;
  // CSS transform function list: `translate(…)`, `rotate(…) scale(…)`, `matrix(…)`.
  if (/^(?:translate|translateX|translateY|rotate|scale|scaleX|scaleY|skew|skewX|skewY|matrix)\s*\(/.test(t)) {
    return true;
  }
  // Numeric coordinate / dimension list: `0 0 40 40`, `1.5,2 3,4` — only digits,
  // separators, signs, units. Requires ≥2 numbers so a lone `42` isn't caught here.
  if (/^[\d.\s,+%-]*\d[\d.\s,+%-]*$/.test(t) && /\d[\s,].*\d/.test(t)) return true;
  // SVG path data: starts with a path command + number, and the whole string is
  // only path commands, digits, and separators (no prose letters).
  if (/^[MmLlHhVvCcSsQqTtAaZz]\s*[-\d.]/.test(t) && /^[MmLlHhVvCcSsQqTtAaZz\d.\s,+\-eE]+$/.test(t)) {
    return true;
  }
  return false;
}

/** Clamped sum of `weightedSignals` — the weighted confidence in [0, 1]. */
export function weightedScore(node: StringNode): number {
  const sum = weightedSignals(node).reduce((acc, term) => acc + term.delta, 0);
  return Math.max(0, Math.min(1, sum));
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

// Object-property keys reliably carrying display copy. Intentionally a STRICT
// subset of the JSX set: `text`, `title`, `content`, `description`, `header`,
// and the `*Text`/`*Title`/`*Description` suffixes are omitted because as object
// keys they overwhelmingly hold data, not copy (proven by the Excalidraw FP
// spot-check). `label` stays, paired with the `looksLikeKeyOrEmptyValue` guard.
const UI_COPY_OBJECT_KEY_EXACT = new Set<string>([
  "label",
  "contextItemLabel",
  "message",
  "errorMessage",
  "tooltip",
  "placeholder",
  "caption",
  "heading",
  "subtitle",
  "hint",
  "alt",
  "ariaLabel",
  "aria-label",
]);

const UI_COPY_OBJECT_KEY_SUFFIX =
  /(?:Label|Message|Tooltip|Placeholder|Caption|Hint)$/;

// Object-property keys whose value is never display copy *in that position*:
// `defaultMessage` is react-intl's already-translated source string; `id`/`key`
// are identifiers. Skipped decisively (see the position-based guard in score()).
// Note `defaultMessage` also matches UI_COPY_OBJECT_KEY_SUFFIX (`*Message`) — the
// guard runs first so it wins.
const ALREADY_HANDLED_OR_STRUCTURAL_KEYS = new Set<string>([
  "defaultMessage",
  "id",
  "key",
]);
