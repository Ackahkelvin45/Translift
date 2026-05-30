/**
 * Sub-step 3e — project-level graph build.
 *
 * Owns the ts-morph `Project` lifecycle: loads files, runs `buildFileGraph`
 * on each, then `stitchFileImports` on each, and exposes a lookup index so
 * the pipeline can resolve a `StringNode` (Babel-produced) to its
 * corresponding `StringLiteralNode` in the graph by `(file, line, column)`.
 *
 * Why a separate file: keeps [src/graph.ts](./graph.ts) pure (types + class),
 * keeps the build (3b) and stitch (3c) modules focused on per-file work, and
 * keeps the CLI entry point ([src/cli.ts](./cli.ts)) free of ts-morph wiring.
 */
import * as fs from "fs";
import * as path from "path";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import {
  CallExpressionNode,
  JsxElementNode,
  ProjectGraph,
  StringLiteralNode,
} from "./graph";
import {
  buildFileGraph,
  chaseAlias,
  resolveSymbolMetadata,
} from "./graph-build";
import { stitchFileImports } from "./graph-stitch";
import {
  TypeInfoCache,
  inferStringPropNames,
  makeTypeInfoCache,
} from "./type-info";
import { WrapperTarget } from "./sink-match";

type TagNode =
  | import("ts-morph").JsxOpeningElement
  | import("ts-morph").JsxSelfClosingElement;

/**
 * Lookup keyed by `<file>:<line>:<text>`.
 *
 * We index by text rather than column because the Babel adapter records
 * `column + 1` (a display-oriented offset) while ts-morph reports 0-based.
 * Text + line is column-convention-independent and identifies the literal
 * uniquely in all but pathological cases (multiple identical literals on
 * the same line — which we tolerate by storing all candidates and picking
 * the first match).
 */
export type StringLiteralIndex = Map<string, StringLiteralNode[]>;

/**
 * Lookup keyed by `<file>:<calleeName>`. Buckets every call expression with
 * the same callee name in the same file (e.g. all `notify(...)` calls in
 * `app.tsx`). When Pass 1 sees a function-sink hit via Babel signals and
 * needs the resolved graph node (for `importFrom` / `matchFile` checks),
 * it looks here.
 *
 * Disambiguation by line — see [findCallNodeNearLine](./graph-project.ts).
 */
export type CallExpressionIndex = Map<string, CallExpressionNode[]>;

export interface ProjectGraphContext {
  graph: ProjectGraph;
  stringIndex: StringLiteralIndex;
  callIndex: CallExpressionIndex;
  /**
   * F5b — lazily enumerate the inferred UI-sink string-prop names for a JSX
   * element node, using the TypeChecker. Returns `undefined` when types can't
   * be resolved (untyped JS, missing imports) so callers degrade gracefully.
   * Results are cached per component symbol for the lifetime of the context.
   *
   * Only invoked by Pass 2's `matchSink` for component entries that omit an
   * explicit `uiProps`, so default-registry configs (all explicit) pay nothing.
   */
  inferStringProps: (node: JsxElementNode) => string[] | undefined;
  /**
   * F6 — resolve the component(s) a wrapper/HOC tag unwraps to. For
   * `const StyledToast = styled(Toast)` used as `<StyledToast/>`, returns the
   * inner `Toast`'s identity so `matchSink` can re-check it against the
   * registry. Returns `undefined` when the tag isn't a resolvable wrapper
   * (plain component, intrinsic tag, `forwardRef` with no component arg, …).
   * Cached per wrapper declaration. Only invoked for capitalized tags whose
   * direct name match already failed.
   */
  resolveWrapperTargets: (node: JsxElementNode) => WrapperTarget[] | undefined;
}

/**
 * Build a project-wide graph from a set of files on disk.
 *
 * If a `tsconfig.json` exists at `rootDir`, ts-morph picks up its `paths`,
 * `baseUrl`, and other resolution settings — that's what makes path aliases
 * (e.g. `@/components/X`) resolve correctly. The walked files are added
 * explicitly so the build doesn't depend on tsconfig's `include` matching
 * what our `.gitignore`-aware walker chose.
 */
export function buildProjectGraph(
  rootDir: string,
  files: string[]
): ProjectGraphContext {
  const project = loadProject(rootDir, files);
  return buildProjectGraphFromProject(project);
}

/** Same as `buildProjectGraph` but accepts a pre-loaded Project (for tests). */
export function buildProjectGraphFromProject(
  project: Project
): ProjectGraphContext {
  const graph = new ProjectGraph();
  for (const sf of project.getSourceFiles()) buildFileGraph(sf, graph);
  for (const sf of project.getSourceFiles()) stitchFileImports(sf, graph);
  return {
    graph,
    stringIndex: buildStringLiteralIndex(graph),
    callIndex: buildCallExpressionIndex(graph),
    inferStringProps: makeInferStringProps(project),
    resolveWrapperTargets: makeResolveWrapperTargets(project),
  };
}

/**
 * Build the lazy prop-inference resolver. Closes over the `Project` (for node
 * re-location) and a single `TypeInfoCache` shared across all queries in this
 * context, so repeated `<Toast>` usages enumerate the prop type once.
 */
function makeInferStringProps(
  project: Project
): (node: JsxElementNode) => string[] | undefined {
  const cache: TypeInfoCache = makeTypeInfoCache();
  return (node) => {
    const tag = locateTag(project, node);
    if (!tag) return undefined;
    return inferStringPropNames(tag, cache);
  };
}

/**
 * Build the lazy wrapper/HOC resolver (F6). Closes over a cache keyed by the
 * wrapper's declaration site so repeated `<StyledToast/>` usages walk the
 * `styled(Toast)` initializer once. `null` caches "tried, not a wrapper."
 */
function makeResolveWrapperTargets(
  project: Project
): (node: JsxElementNode) => WrapperTarget[] | undefined {
  const cache = new Map<string, WrapperTarget[] | null>();
  return (node) => {
    const tag = locateTag(project, node);
    if (!tag) return undefined;
    const tagName = tag.getTagNameNode();
    if (!Node.isIdentifier(tagName)) return undefined;
    const sym = tagName.getSymbol();
    if (!sym) return undefined;
    const decl = chaseAlias(sym).getDeclarations()[0];
    if (!decl) return undefined;

    const key = `${decl.getSourceFile().getFilePath()}:${decl.getStart()}`;
    if (cache.has(key)) return cache.get(key) ?? undefined;

    const targets = collectWrapperTargets(decl);
    const stored = targets.length ? targets : null;
    cache.set(key, stored);
    return stored ?? undefined;
  };
}

/**
 * Walk a wrapper declaration's initializer for component identifiers.
 * Handles `hoc(Inner)`, `a(b(Inner))`, `connect(...)(Inner)`,
 * `styled(Inner)\`…\``, and parenthesized / `as`-cast forms. Returns the
 * resolved identities of every component-like identifier argument found.
 */
function collectWrapperTargets(decl: Node): WrapperTarget[] {
  if (!Node.isVariableDeclaration(decl)) return [];
  const init = decl.getInitializer();
  if (!init) return [];
  const out: WrapperTarget[] = [];
  collectFromExpression(init, out, 0);
  return out;
}

function collectFromExpression(expr: Node, out: WrapperTarget[], depth: number): void {
  if (depth > 6) return; // bound pathological nesting

  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr)) {
    collectFromExpression(expr.getExpression(), out, depth + 1);
    return;
  }
  if (Node.isTaggedTemplateExpression(expr)) {
    // `styled(Inner)`…`` — the wrapping call is the tag.
    collectFromExpression(expr.getTag(), out, depth + 1);
    return;
  }
  if (Node.isCallExpression(expr)) {
    // Recurse into the callee (`connect(...)(Inner)`) and every argument
    // (`hoc(Inner)`, `withX(Inner, opts)`). Non-component args resolve to
    // nothing and are dropped; the registry filters the rest.
    collectFromExpression(expr.getExpression(), out, depth + 1);
    for (const arg of expr.getArguments()) {
      collectFromExpression(arg, out, depth + 1);
    }
    return;
  }
  if (Node.isIdentifier(expr)) {
    // Only PascalCase identifiers can be components — skips `connect`, option
    // bags, etc. cheaply before paying for symbol resolution.
    if (!/^[A-Z]/.test(expr.getText())) return;
    const meta = resolveSymbolMetadata(expr);
    if (meta.resolvedName) {
      out.push({
        name: meta.resolvedName,
        declarationFile: meta.declarationFile,
        importSpecifier: meta.importSpecifier,
      });
    }
    return;
  }
}

/** Re-locate the ts-morph JSX tag node for a graph jsx-element node. */
function locateTag(project: Project, node: JsxElementNode): TagNode | undefined {
  const sf = project.getSourceFile(node.file);
  if (!sf) return undefined;
  const offset = offsetOfNodeId(node.id);
  if (offset === null) return undefined;
  const at = sf.getDescendantAtPos(offset);
  if (!at) return undefined;
  if (Node.isJsxOpeningElement(at) || Node.isJsxSelfClosingElement(at)) return at;
  return (
    at.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement) ??
    at.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement)
  );
}

/**
 * Parse the start offset out of a graph node id (`<file>:<startOffset>`).
 * Uses the last colon so POSIX paths (no colons) and the rare path-with-colon
 * both work. Returns `null` if the suffix isn't a number.
 */
function offsetOfNodeId(id: string): number | null {
  const idx = id.lastIndexOf(":");
  if (idx === -1) return null;
  const n = Number(id.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

function loadProject(rootDir: string, files: string[]): Project {
  const tsConfigPath = path.join(rootDir, "tsconfig.json");
  const hasTsConfig = fs.existsSync(tsConfigPath);
  const project = new Project(
    hasTsConfig
      ? { tsConfigFilePath: tsConfigPath }
      : {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
            allowJs: true,
          },
        }
  );

  // Always add the walker's files in case tsconfig's `include` excludes them.
  // ts-morph deduplicates by absolute path.
  for (const file of files) {
    if (project.getSourceFile(file)) continue;
    try {
      project.addSourceFileAtPath(file);
    } catch (err) {
      // Babel has its own parse — one bad file should not kill the CLI.
      // eslint-disable-next-line no-console
      console.warn(
        `warn: ts-morph could not load ${file}: ${(err as Error).message}`
      );
    }
  }
  return project;
}

export function buildStringLiteralIndex(graph: ProjectGraph): StringLiteralIndex {
  const idx: StringLiteralIndex = new Map();
  for (const node of graph.nodes()) {
    if (node.type === "string-literal") {
      const k = stringLiteralKey(node.file, node.line, node.text);
      const bucket = idx.get(k);
      if (bucket) bucket.push(node);
      else idx.set(k, [node]);
    }
  }
  return idx;
}

export function stringLiteralKey(
  file: string,
  line: number,
  text: string
): string {
  return `${file}:${line}:${text}`;
}

export function buildCallExpressionIndex(
  graph: ProjectGraph
): CallExpressionIndex {
  const idx: CallExpressionIndex = new Map();
  for (const node of graph.nodes()) {
    if (node.type !== "call-expression" || !node.calleeName) continue;
    const k = callExpressionKey(node.file, node.calleeName);
    const bucket = idx.get(k);
    if (bucket) bucket.push(node);
    else idx.set(k, [node]);
  }
  return idx;
}

export function callExpressionKey(file: string, calleeName: string): string {
  return `${file}:${calleeName}`;
}

/**
 * Given a `(file, calleeName)` pair plus the line where a string argument was
 * found by the Babel walker, return the most-likely matching graph call node.
 *
 * Heuristic: the call expression's start line is `≤` the string's line, and
 * among those the largest such start line (= the call closest to the string,
 * going backwards). Handles single-line calls trivially and multi-line calls
 * by preferring the nearest enclosing call.
 *
 * Returns `undefined` when no call in that file has the given callee name, or
 * when none precedes the string's line — both indicate a Babel/ts-morph
 * disagreement we should not paper over.
 */
export function findCallNodeNearLine(
  index: CallExpressionIndex,
  file: string,
  calleeName: string,
  stringLine: number
): CallExpressionNode | undefined {
  const candidates = index.get(callExpressionKey(file, calleeName));
  if (!candidates || candidates.length === 0) return undefined;
  let best: CallExpressionNode | undefined;
  let bestLine = -1;
  for (const c of candidates) {
    if (c.line <= stringLine && c.line > bestLine) {
      best = c;
      bestLine = c.line;
    }
  }
  return best;
}
