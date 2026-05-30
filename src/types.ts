export enum StringKind {
  JsxText = "jsx_text",
  JsxAttribute = "jsx_attribute",
  StringLiteral = "string_literal",
  TemplateLiteralStatic = "template_static",
  TemplateLiteralDynamic = "template_dynamic",
  ObjectProperty = "object_property",
  CallArgument = "call_argument",
}

/**
 * Where a wrap verdict came from. Maps onto the spec's confidence tiers:
 *   - `jsx-text` / `attribute-sink` / `function-sink` — Pass 1 hard rule → `[direct]`
 *   - `weighted`                                       — Pass 1 weighted score → `[traced]`
 *   - `traced`                                         — Pass 2 BFS resolved → `[traced, depth N]`
 *
 * Set only when `verdict === Verdict.Wrap`. Drives `[direct]` / `[traced]`
 * tagging in `--verbose` output and the `audit --strict` exit-code rule.
 */
export type ConfidenceSource =
  | "jsx-text"
  | "attribute-sink"
  | "object-property-sink"
  | "function-sink"
  | "weighted"
  | "traced";

export enum Verdict {
  Wrap = "wrap",
  Skip = "skip",
  Escalate = "escalate",
  FlagDynamic = "flag_dynamic",
  Unresolved = "unresolved",
}

export interface StringSignals {
  inJsxText: boolean;
  inJsxAttribute: string | null;
  attributeElement: string | null;
  inConsoleCall: boolean;
  inLoggerCall: boolean;
  inThrowStatement: boolean;
  inTestAssertion: boolean;
  inImportPath: boolean;
  inUrlShape: boolean;
  isCodeIdentifier: boolean;
  propName: string | null;
  /**
   * When the string is the direct value of an object property
   * (`{ contextItemLabel: "Delete" }`), the property's key name. Lets scoring
   * gate copy-bearing object properties the same way it gates JSX attributes.
   * Null otherwise.
   */
  objectPropertyKey: string | null;
  componentName: string | null;
  enclosingFunctionIsComponent: boolean;
  inFunctionSink: { name: string; argIndex: number } | null;
}

export interface StringNode {
  id: string;
  text: string;
  file: string;
  line: number;
  column: number;
  kind: StringKind;
  signals: StringSignals;
  confidence: number;
  /** Set when verdict === Wrap. Identifies which rule fired. */
  confidenceSource?: ConfidenceSource;
  verdict: Verdict;
  trace?: {
    sink: string | null;
    depth: number;
    path: string[];
    /** Source-code name when the sink matched via an aliased import (F3). */
    viaAlias?: string;
    /** Source-code tag name when the sink matched by unwrapping a wrapper (F6). */
    viaWrapper?: string;
  };
  contextSnippet: string;
}

/**
 * Optional file-path glob (micromatch syntax) matched against the *declaration*
 * file of the resolved symbol. When present, the sink entry only fires for
 * symbols declared in a file matching the glob. Lets users say things like
 * "any Toast in packages/ui/src/components/**" without listing every component.
 *
 * Matching uses absolute file paths from the project graph.
 */
type FilePathGlob = string;

export interface ComponentSink {
  name: string;
  importFrom?: string;
  /**
   * Which props carry user-facing strings.
   *
   * - `string[]` — only these prop names are UI sinks (explicit override).
   * - `"all-children"` — any prop is a UI sink (no name filter).
   * - omitted — F5b infers string-typed props from the component's TypeScript
   *   type (filtered by a blocklist; see `type-info.ts`). Inference requires
   *   types to resolve; when they don't, the entry gates nothing (degrades to
   *   "no prop matches"). Set `inferUiProps: false` to disable inference for an
   *   entry that omits `uiProps` (it then matches no prop).
   *
   * An explicit `uiProps` always wins over inference — it is an override, not a
   * supplement.
   */
  uiProps?: string[] | "all-children";
  /**
   * Opt out of F5b type-driven `uiProps` inference for this entry. Only
   * consulted when `uiProps` is omitted. Defaults to `true` (infer).
   */
  inferUiProps?: boolean;
  matchFile?: FilePathGlob;
}

export interface AttributeSink {
  name: string;
  onElements?: string[];
  notOnElements?: string[];
  // No `matchFile`: attribute sinks describe HTML attributes (no JS
  // declaration to glob against). Use `onElements` / `notOnElements` for
  // tag-level scoping.
}

export interface FunctionSink {
  name: string;
  importFrom?: string;
  uiArgs: number[] | "all";
  matchFile?: FilePathGlob;
}

export interface SinkRegistry {
  components: ComponentSink[];
  attributes: AttributeSink[];
  functions: FunctionSink[];
}

/**
 * A pre-existing `t("...")` or `i18n.t("...")` call found in source.
 * Used for missing-key / orphan / idempotency analysis — these strings
 * are deliberately not turned into `StringNode`s, so the adapter records
 * them separately.
 */
export interface UsedTranslationKey {
  keyName: string;
  file: string;
  line: number;
  column: number;
}
