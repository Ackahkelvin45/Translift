/**
 * Sub-step 3d — Pass 2 cross-file tracer.
 *
 * Walks the `ProjectGraph` forward from a starting string-literal (or any
 * graph node, really) via the four string-flow edges:
 *
 *   assigned_to · passed_as_arg · passed_as_prop · returned_from
 *
 * Terminates when the BFS lands on a node that matches a registered sink:
 *
 *   - call-expression whose `calleeName` is a registered function sink
 *   - jsx-element whose `tagName` is a registered component sink AND whose
 *     arriving prop is listed in that sink's `uiProps` (F5a prop-gating)
 *
 * `importFrom` / `matchFile` constraints are enforced here (F1/F3). Component
 * `uiProps` gating is enforced via the incoming `passed_as_prop` edge (F5a):
 * a string traced into `<Modal subtitle={…}/>` only resolves when `subtitle`
 * is in `Modal`'s `uiProps` (or `uiProps` is `"all-children"`). Function-sink
 * `uiArgs` are NOT gated in Pass 2 yet — Pass 1 enforces them; the Pass 2 gap
 * is logged as a known limitation (analogous mechanism, deferred).
 *
 * Attribute sinks (e.g. `aria-label`) are handled by Pass 1 for direct cases
 * and are not consulted here.
 *
 * `imports` edges are NOT traversed. They are metadata for downstream
 * features (hub analysis, importFrom matching). Cross-file traversal works
 * because `graph-build.ts` resolves identifier references through alias
 * chains, so edges already point at the original declaration's node.
 */
import {
  EdgeType,
  GraphEdge,
  GraphNode,
  JsxElementNode,
  PathStep,
  ProjectGraph,
} from "./graph";
import { ComponentSink, SinkRegistry } from "./types";
import { WrapperTarget, matchFilePathOk } from "./sink-match";

/**
 * Optional hooks for the tracer. Carry F5b's lazy prop-type inference resolver
 * and F6's wrapper/HOC resolver; absent for legacy/unit-test callers (those
 * features simply don't run — entries that omit `uiProps` match no prop, and
 * wrapper tags don't resolve to their inner component).
 */
export interface TraceContext {
  inferStringProps?: (node: JsxElementNode) => string[] | undefined;
  resolveWrapperTargets?: (node: JsxElementNode) => WrapperTarget[] | undefined;
}

const FORWARD_EDGES: EdgeType[] = [
  "assigned_to",
  "passed_as_arg",
  "passed_as_prop",
  "returned_from",
];

export interface SinkMatch {
  kind: "function" | "component";
  /** The registered sink name that matched. */
  name: string;
  /**
   * Set when the match succeeded via the resolved (alias-chased) name rather
   * than the source-code name — i.e. the user wrote `showToast(...)` and the
   * registry has `toast`. Pipeline uses this to surface an advisory warning.
   */
  matchedViaAlias?: string;
  /**
   * Set (to the wrapper's source-code tag name) when the match succeeded only
   * after unwrapping a wrapper/HOC declaration — e.g. `<StyledToast/>` resolved
   * to the registered `Toast` via `const StyledToast = styled(Toast)`. Pipeline
   * surfaces this as an advisory so the heuristic match is visible.
   */
  matchedViaWrapper?: string;
}

export type TraceResult =
  | { resolved: true; sink: SinkMatch; path: PathStep[]; depth: number }
  | { resolved: false; exhausted: "depth" | "dead-end" };

export function trace(
  start: GraphNode,
  graph: ProjectGraph,
  registry: SinkRegistry,
  maxDepth: number = 5,
  ctx: TraceContext = {}
): TraceResult {
  const result = graph.traverse(start, {
    edgeTypes: FORWARD_EDGES,
    maxDepth,
    matches: (node, incomingEdge) =>
      !!matchSink(node, registry, incomingEdge, ctx),
  });

  if (!result.found) {
    return { resolved: false, exhausted: result.exhausted };
  }
  const terminalEdge = result.path[result.path.length - 1]?.edge;
  const sink = matchSink(result.terminal, registry, terminalEdge, ctx);
  if (!sink) {
    // Defensive: matches() returned true but the re-check couldn't identify the
    // sink (would only happen on a racing registry mutation — none today).
    return { resolved: false, exhausted: "dead-end" };
  }
  return {
    resolved: true,
    sink,
    path: result.path,
    depth: result.depth,
  };
}

/**
 * Single source of truth for "is this graph node a registered sink, and which
 * one?". Iterates registry entries so per-entry constraints (`matchFile`,
 * `importFrom`) are honored consistently — returning the `SinkMatch`
 * description if it matches, `null` otherwise.
 *
 * Name resolution tries the source-code name first, then the alias-resolved
 * name. When the second succeeds while the first failed, `matchedViaAlias`
 * is set so the caller can warn about the implicit aliasing.
 *
 * `incomingEdge` is the edge the BFS traversed to reach `node`. For component
 * sinks it gates the match on `uiProps`: the arriving `passed_as_prop` edge's
 * prop name must be registered (or the entry must be `"all-children"`).
 */
export function matchSink(
  node: GraphNode,
  registry: SinkRegistry,
  incomingEdge?: GraphEdge,
  ctx: TraceContext = {}
): SinkMatch | null {
  if (node.type === "call-expression" && node.calleeName) {
    const candidate = matchByName(
      registry.functions,
      node.calleeName,
      node.calleeResolvedName,
      (entry) =>
        matchFilePathOk(node.calleeDeclarationFile, entry.matchFile) &&
        importFromOk(node.calleeImportSpecifier, entry.importFrom)
    );
    if (candidate) {
      return {
        kind: "function",
        name: candidate.entry.name,
        ...(candidate.viaAlias && { matchedViaAlias: node.calleeName }),
      };
    }
  }
  if (node.type === "jsx-element") {
    const candidate = matchByName(
      registry.components,
      node.tagName,
      node.tagResolvedName,
      (entry) =>
        matchFilePathOk(node.tagDeclarationFile, entry.matchFile) &&
        importFromOk(node.tagImportSpecifier, entry.importFrom) &&
        uiPropsAccepts(entry, node, incomingEdge, ctx)
    );
    if (candidate) {
      return {
        kind: "component",
        name: candidate.entry.name,
        ...(candidate.viaAlias && { matchedViaAlias: node.tagName }),
      };
    }
    // F6 — no direct name match. If the tag is a capitalized component, try
    // unwrapping a wrapper/HOC declaration and re-matching the inner component.
    const wrapped = matchWrappedComponent(node, registry, incomingEdge, ctx);
    if (wrapped) return wrapped;
  }
  return null;
}

/**
 * F6 wrapper/HOC matching. Resolves the tag to the component(s) it unwraps to
 * (via `ctx.resolveWrapperTargets`) and re-checks each against the component
 * registry — name, `matchFile`/`importFrom` (evaluated against the *inner*
 * component's declaration), and `uiProps` gating (inferred from the *wrapper's*
 * own prop type, so `styled(Toast)` still gets Toast's string props).
 */
function matchWrappedComponent(
  node: GraphNode & { type: "jsx-element" },
  registry: SinkRegistry,
  incomingEdge: GraphEdge | undefined,
  ctx: TraceContext
): SinkMatch | null {
  // Cheap gate: only PascalCase tags can be user wrappers; skip intrinsics
  // (`div`) and member tags (`obj.X`) before paying for resolution.
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(node.tagName)) return null;
  const targets = ctx.resolveWrapperTargets?.(node);
  if (!targets) return null;

  for (const target of targets) {
    for (const entry of registry.components) {
      if (entry.name !== target.name) continue;
      if (!matchFilePathOk(target.declarationFile, entry.matchFile)) continue;
      if (!importFromOk(target.importSpecifier, entry.importFrom)) continue;
      if (!uiPropsAccepts(entry, node, incomingEdge, ctx)) continue;
      return {
        kind: "component",
        name: entry.name,
        matchedViaWrapper: node.tagName,
      };
    }
  }
  return null;
}

/**
 * F5a/F5b prop-gating: does this component sink accept a string that arrived
 * via `incomingEdge`?
 *
 * Resolution order for the effective prop list:
 *
 * - `uiProps: "all-children"` — accept any prop (no name filter).
 * - `uiProps: string[]` — explicit override; accept only listed prop names.
 * - `uiProps` omitted, `inferUiProps !== false` — F5b infers string-typed prop
 *   names from the component's type (via `ctx.inferStringProps`). When types
 *   can't be resolved (resolver absent or returns `undefined`), the entry gates
 *   nothing — graceful degradation, never a wrong wrap.
 * - `uiProps` omitted, `inferUiProps === false` — opted out of both; matches no
 *   prop.
 *
 * A string reaches a jsx-element node only via a `passed_as_prop` edge, so in
 * practice `incomingEdge` is always that shape during a BFS match. The
 * defensive branches (missing/non-prop edge) reject name-list entries — we
 * can't confirm the prop, so we don't wrap.
 */
function uiPropsAccepts(
  entry: ComponentSink,
  node: JsxElementNode,
  incomingEdge: GraphEdge | undefined,
  ctx: TraceContext
): boolean {
  if (entry.uiProps === "all-children") return true;
  if (!incomingEdge || incomingEdge.type !== "passed_as_prop") return false;
  const propName = incomingEdge.propName;

  if (entry.uiProps !== undefined) {
    // Explicit list wins over inference (it is an override, not a supplement).
    return entry.uiProps.includes(propName);
  }
  if (entry.inferUiProps === false) return false;

  const inferred = ctx.inferStringProps?.(node);
  if (!inferred) return false; // types unavailable → degrade gracefully
  return inferred.includes(propName);
}

/**
 * Generic name+constraint matcher. Tries `localName` first; if that finds no
 * accepting entry, tries `resolvedName` and marks it as alias-matched.
 */
function matchByName<E extends { name: string }>(
  entries: E[],
  localName: string | null,
  resolvedName: string | undefined,
  acceptConstraints: (entry: E) => boolean
): { entry: E; viaAlias: boolean } | null {
  if (localName) {
    for (const entry of entries) {
      if (entry.name === localName && acceptConstraints(entry)) {
        return { entry, viaAlias: false };
      }
    }
  }
  if (resolvedName && resolvedName !== localName) {
    for (const entry of entries) {
      if (entry.name === resolvedName && acceptConstraints(entry)) {
        return { entry, viaAlias: true };
      }
    }
  }
  return null;
}

function importFromOk(
  actualSpecifier: string | undefined,
  expected: string | undefined
): boolean {
  if (!expected) return true; // entry unconstrained — accept
  return actualSpecifier === expected;
}
