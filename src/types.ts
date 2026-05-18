export enum StringKind {
  JsxText = "jsx_text",
  JsxAttribute = "jsx_attribute",
  StringLiteral = "string_literal",
  TemplateLiteralStatic = "template_static",
  TemplateLiteralDynamic = "template_dynamic",
  ObjectProperty = "object_property",
  CallArgument = "call_argument",
}

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
  verdict: Verdict;
  trace?: {
    sink: string | null;
    depth: number;
    path: string[];
  };
  contextSnippet: string;
}

export interface ComponentSink {
  name: string;
  importFrom?: string;
  uiProps: string[] | "all-children";
}

export interface AttributeSink {
  name: string;
  onElements?: string[];
  notOnElements?: string[];
}

export interface FunctionSink {
  name: string;
  importFrom?: string;
  uiArgs: number[] | "all";
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
