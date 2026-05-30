/**
 * F4 — TypeChecker wrapper for the sink-registry fixes.
 *
 * Pure infrastructure: thin, lazy, cached. Nothing in the pipeline calls this
 * yet — F5 (type-driven `uiProps` inference) and F6 (wrapper / HOC shape
 * matching) will be the first consumers.
 *
 * Three guarantees the layer above can rely on:
 *
 *  1. **Lazy.** Type queries only fire when a caller asks. We never bulk-load
 *     types for every component during graph build (TypeChecker calls are
 *     significantly more expensive than symbol resolution).
 *  2. **Cached per-symbol.** Multiple `<Toast .../>` usages reuse one prop
 *     enumeration. The cache is consumer-owned (passed in) so it can scope
 *     to a single CLI invocation and be discarded between runs.
 *  3. **Graceful degradation.** When the TypeChecker can't resolve (untyped
 *     JS, missing imports, compile errors), every public function returns
 *     `undefined`. We never throw, never log. Callers branch on `undefined`
 *     and skip the constraint that needed types.
 */
import {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  JsxOpeningElement,
  JsxSelfClosingElement,
  Node,
  PropertyDeclaration,
  PropertySignature,
  Symbol as TsSymbol,
  Type,
  VariableDeclaration,
} from "ts-morph";

export interface PropTypeInfo {
  /** Prop name as declared on the component's props type. */
  name: string;
  /**
   * True when the prop's type is a string, string-literal, or a union whose
   * non-`undefined` members are all strings/string-literals. This is the
   * narrowest correct definition for "the value at runtime will be a string."
   */
  isString: boolean;
  /** True when the prop is required (no `?` marker, no `| undefined`). */
  required: boolean;
}

/**
 * Cache keyed by `symbol-id := "<declarationFile>:<declarationStartOffset>"`.
 *
 * `null` means "we tried, the TypeChecker couldn't help" — distinguished
 * from "not cached yet" (key absent). Saves us re-querying types for known
 * failures, which would be wasteful on large repos with many untyped JS files.
 */
export type TypeInfoCache = Map<string, PropTypeInfo[] | null>;

export function makeTypeInfoCache(): TypeInfoCache {
  return new Map();
}

/**
 * Enumerate the props type of the component referenced by a JSX tag.
 *
 * Returns the array of `PropTypeInfo` when the type was resolvable, or
 * `undefined` for any of:
 *
 *   - Member tags (`<obj.Component />`) — resolution path differs; defer.
 *   - Tags whose symbol has no resolvable declaration.
 *   - Declarations without a recognizable function/component shape.
 *   - Type queries that came back as `any` or threw.
 */
export function getComponentPropTypes(
  tag: JsxOpeningElement | JsxSelfClosingElement,
  cache?: TypeInfoCache
): PropTypeInfo[] | undefined {
  try {
    return getComponentPropTypesUnsafe(tag, cache);
  } catch {
    // Any TypeChecker throw → degrade gracefully. We intentionally do not log
    // — these failures are common on partially-typed projects and would be
    // noise. F5/F6 callers see `undefined` and fall back to manual config.
    return undefined;
  }
}

function getComponentPropTypesUnsafe(
  tag: JsxOpeningElement | JsxSelfClosingElement,
  cache?: TypeInfoCache
): PropTypeInfo[] | undefined {
  const tagNode = tag.getTagNameNode();
  if (!Node.isIdentifier(tagNode)) return undefined;

  const sym = tagNode.getSymbol();
  if (!sym) return undefined;
  const original = chaseAlias(sym);
  const decl = original.getDeclarations()[0];
  if (!decl) return undefined;

  const cacheKey = `${decl.getSourceFile().getFilePath()}:${decl.getStart()}`;
  if (cache?.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return cached ?? undefined;
  }

  const propsType = resolvePropsType(decl);
  if (!propsType || isAny(propsType)) {
    cache?.set(cacheKey, null);
    return undefined;
  }

  const props: PropTypeInfo[] = [];
  for (const propSym of propsType.getProperties()) {
    const propType = propSym.getTypeAtLocation(tag);
    if (isAny(propType)) continue;
    props.push({
      name: propSym.getName(),
      isString: isStringLike(propType),
      required: isRequired(propSym),
    });
  }

  cache?.set(cacheKey, props);
  return props;
}

/**
 * F5b — infer the set of UI-sink prop names for a component instance.
 *
 * Enumerates the component's props (via `getComponentPropTypes`), keeps those
 * whose type is string-like AND whose name passes the UI-prop blocklist
 * ([isUiPropName]), and returns their names.
 *
 * Returns `undefined` (NOT `[]`) when the type couldn't be resolved, so callers
 * can distinguish "types unavailable, degrade gracefully" from "resolved, but
 * no prop qualifies." An empty array is a real answer: the component has no
 * string-typed UI props.
 */
export function inferStringPropNames(
  tag: JsxOpeningElement | JsxSelfClosingElement,
  cache?: TypeInfoCache
): string[] | undefined {
  const props = getComponentPropTypes(tag, cache);
  if (!props) return undefined;
  return props
    .filter((p) => p.isString && isUiPropName(p.name))
    .map((p) => p.name);
}

/**
 * Blocklist filter: is this prop name plausibly a user-facing string sink?
 *
 * "Every string-typed prop" over-includes — `className`, `id`, `href`, etc. are
 * strings but never translatable. Mirrors react-docgen-typescript's `propFilter`
 * intent and the spec's Problem 6 exclusion list. Conservative by name: when in
 * doubt we exclude, because a missed sink is recoverable (manual `uiProps`)
 * while a wrongly-wrapped `className` corrupts output.
 */
export function isUiPropName(name: string): boolean {
  if (EXACT_BLOCKLIST.has(name)) return false;
  // Event handlers: onClick, onChange, … (capital after `on`).
  if (/^on[A-Z]/.test(name)) return false;
  // `data-*` attributes are never UI copy.
  if (name.startsWith("data-")) return false;
  // `aria-*` are excluded EXCEPT the two that carry human-readable text.
  if (name.startsWith("aria-")) {
    return name === "aria-label" || name === "aria-description";
  }
  return true;
}

/**
 * Props that are string-typed but structurally never translatable copy.
 * Kept narrow and explicit — see `isUiPropName` for the pattern-based rules
 * (`on*`, `data-*`, `aria-*`).
 */
const EXACT_BLOCKLIST = new Set<string>([
  "className",
  "id",
  "htmlFor",
  "key",
  "ref",
  "href",
  "src",
  "type",
  "role",
  "name",
  "rel",
  "target",
  "as",
  "slot",
  "style",
  "tabIndex",
  "testID",
  "data-testid",
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The props type is whatever the component declaration takes as its first
 * parameter — function declarations, function expressions, and arrow
 * functions are all the same shape for our purposes. Class components and
 * `React.forwardRef`-style wrappers aren't covered yet (F6 territory).
 */
function resolvePropsType(decl: Node): Type | undefined {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl)
  ) {
    return firstParamType(decl);
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = (decl as VariableDeclaration).getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return firstParamType(init);
    }
  }
  return undefined;
}

function firstParamType(
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction
): Type | undefined {
  const params = fn.getParameters();
  if (params.length === 0) return undefined;
  return params[0].getType();
}

function isAny(t: Type): boolean {
  // ts-morph exposes `isAny()` directly. Belt-and-braces against any future
  // API rename — the text form `"any"` is a reliable fallback signal.
  if (typeof (t as { isAny?: () => boolean }).isAny === "function") {
    return (t as { isAny: () => boolean }).isAny();
  }
  return t.getText() === "any";
}

/**
 * A prop is "string-like" when it is, or is a union exclusively of, string,
 * string-literal, and `undefined` (which appears for `string | undefined` or
 * optional props after widening). Excludes `string | number`, `string | null`,
 * branded types, etc. — those need explicit user opt-in.
 */
function isStringLike(t: Type): boolean {
  if (t.isString() || t.isStringLiteral()) return true;
  if (t.isUnion()) {
    return t
      .getUnionTypes()
      .every((sub) => sub.isString() || sub.isStringLiteral() || sub.isUndefined());
  }
  return false;
}

/**
 * Required = no `?` marker on the property declaration AND the declared type
 * doesn't include `undefined`. Optional or undefined-tolerant props are
 * "required = false" so callers can decide whether to insist on them.
 */
function isRequired(prop: TsSymbol): boolean {
  for (const d of prop.getDeclarations()) {
    if (
      (Node.isPropertySignature(d) || Node.isPropertyDeclaration(d)) &&
      (d as PropertySignature | PropertyDeclaration).hasQuestionToken()
    ) {
      return false;
    }
  }
  // Conservative default: when we can't find the declaration shape, treat as
  // required. F5 will use this to decide whether unset props are a problem.
  return true;
}

/**
 * Walk an alias chain to its terminal symbol. Mirrors the same-named helper
 * in [src/graph-build.ts](./graph-build.ts) — kept local here so this module
 * has no dependency on the graph layer.
 */
function chaseAlias(sym: TsSymbol): TsSymbol {
  let cur = sym;
  for (let i = 0; i < 10; i++) {
    const next = cur.getAliasedSymbol();
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}
