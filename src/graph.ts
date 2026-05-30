/**
 * Phase 2, Step 3 — symbol graph types and the `ProjectGraph` class.
 *
 * Vocabulary is intentionally narrow (5 node types, 5 edge types) and tuned for
 * string-data-flow tracing, not symbol resolution. See phase-2-spec.md §Step 3
 * for the rationale on why this diverges from Graphify's broader vocabulary.
 *
 * This file holds the API surface only — no AST walking, no ts-morph. Per-file
 * extraction lives in `graph-build.ts` (sub-step 3b); cross-file stitching lives
 * in `graph-stitch.ts` (sub-step 3c).
 */

export type NodeType =
  | "module"
  | "symbol"
  | "string-literal"
  | "call-expression"
  | "jsx-element";

export type EdgeType =
  | "imports"
  | "assigned_to"
  | "passed_as_arg"
  | "passed_as_prop"
  | "returned_from";

interface BaseNode {
  /** Stable project-wide identity: `"<absolutePath>:<startOffset>"`. */
  id: string;
  type: NodeType;
  /** Absolute filesystem path of the source file. */
  file: string;
  line: number;
  column: number;
}

export interface ModuleNode extends BaseNode {
  type: "module";
}

export interface SymbolNode extends BaseNode {
  type: "symbol";
  name: string;
}

export interface StringLiteralNode extends BaseNode {
  type: "string-literal";
  text: string;
}

export interface CallExpressionNode extends BaseNode {
  type: "call-expression";
  /** Local AST name as written in source (e.g. `showToast` after aliasing). `null` for computed callees. */
  calleeName: string | null;
  /**
   * Canonical exported name after walking through all import aliases and
   * barrel re-exports. For `import { toast as showToast } from "..."`,
   * `calleeName === "showToast"` and `calleeResolvedName === "toast"`.
   * Equal to `calleeName` when no aliasing happened; `undefined` for local
   * declarations or when symbol resolution fails.
   */
  calleeResolvedName?: string;
  /** Absolute file path of the resolved callee declaration. See `resolveSymbolMetadata`. */
  calleeDeclarationFile?: string;
  /**
   * Module specifier (the string in the `from "..."`) used to import the
   * callee into the current file. `undefined` for locally-declared callees
   * and computed/method calls. Used to enforce `importFrom` constraints on
   * function sinks.
   */
  calleeImportSpecifier?: string;
}

export interface JsxElementNode extends BaseNode {
  type: "jsx-element";
  /** Local tag name as written in source. */
  tagName: string;
  /** Canonical exported name after alias chasing — see `calleeResolvedName`. */
  tagResolvedName?: string;
  /** Same as `calleeDeclarationFile` but for the JSX tag's underlying symbol. */
  tagDeclarationFile?: string;
  /** Module specifier the tag was imported from — see `calleeImportSpecifier`. */
  tagImportSpecifier?: string;
}

export type GraphNode =
  | ModuleNode
  | SymbolNode
  | StringLiteralNode
  | CallExpressionNode
  | JsxElementNode;

interface BaseEdge {
  type: EdgeType;
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
}

export interface ImportsEdge extends BaseEdge {
  type: "imports";
  /** Original module specifier text, e.g. `"@/components/Toast"`. */
  specifier: string;
}

export interface AssignedToEdge extends BaseEdge {
  type: "assigned_to";
}

export interface PassedAsArgEdge extends BaseEdge {
  type: "passed_as_arg";
  argIndex: number;
}

export interface PassedAsPropEdge extends BaseEdge {
  type: "passed_as_prop";
  propName: string;
}

export interface ReturnedFromEdge extends BaseEdge {
  type: "returned_from";
}

export type GraphEdge =
  | ImportsEdge
  | AssignedToEdge
  | PassedAsArgEdge
  | PassedAsPropEdge
  | ReturnedFromEdge;

/**
 * Hyperedges represent a single conceptual translation unit linking multiple
 * nodes — currently reserved for dynamic template literals
 * (e.g. `` `Hello ${user.name}, you have ${count}` ``) which Phase 2 surfaces
 * as one unit + N interpolation symbols.
 *
 * Empty in Phase 2; declared now so the data structure is forward-compatible.
 */
export interface HyperEdge {
  template: string;
  interpolations: string[];
}

export interface PathStep {
  /** The edge traversed to arrive at `node`. */
  edge: GraphEdge;
  /** The node arrived at. */
  node: GraphNode;
}

export interface TraverseOpts {
  /** Subset of edge types to follow. Defaults to all edge types. */
  edgeTypes?: EdgeType[];
  /** Hard cap on traversal depth. Hits past this return `exhausted: "depth"`. */
  maxDepth: number;
  /**
   * Termination predicate. First node satisfying this ends the walk.
   *
   * `incomingEdge` is the edge traversed to reach `node` (`undefined` only for
   * the start node, which has no incoming edge). Edge-aware predicates use it
   * to gate on how the value arrived — e.g. matching a component sink only when
   * the string came in via a registered `uiProps` prop (F5a). Because the BFS
   * `visited` set is keyed on node id, a node reachable via two different edges
   * is only offered to `matches` for whichever edge the BFS reaches first; a
   * value passed to the *same* element as both a UI prop and a non-UI prop can
   * therefore be missed (rare; consistent with the node-keyed-visited tradeoff).
   */
  matches: (node: GraphNode, incomingEdge?: GraphEdge) => boolean;
}

export type TraverseResult =
  | { found: true; terminal: GraphNode; path: PathStep[]; depth: number }
  | { found: false; exhausted: "depth" | "dead-end" };

/**
 * Build a stable, project-wide node id. Exported so `graph-build.ts` and
 * `graph-stitch.ts` produce ids identical to whatever the graph stores.
 */
export function nodeId(file: string, startOffset: number): string {
  return `${file}:${startOffset}`;
}

/**
 * In-memory typed graph. Query API is read-only and matches the spec. The
 * `add*` mutators are intended for the build/stitch modules — public because
 * TypeScript has no package-private, but treat them as internal.
 */
export class ProjectGraph {
  private _nodes = new Map<string, GraphNode>();
  // Adjacency from source node id → outbound edges, for O(1) neighbour lookup.
  private _outbound = new Map<string, GraphEdge[]>();
  private _hyperedges: HyperEdge[] = [];

  /** Read-only view of every node in the graph. */
  nodes(): Iterable<GraphNode> {
    return this._nodes.values();
  }

  /**
   * Outbound edges from `node`. The overloaded form narrows the return type
   * when an explicit `type` is supplied.
   */
  edges(node: GraphNode): Iterable<GraphEdge>;
  edges<T extends EdgeType>(
    node: GraphNode,
    type: T
  ): Iterable<Extract<GraphEdge, { type: T }>>;
  edges(node: GraphNode, type?: EdgeType): Iterable<GraphEdge> {
    const all = this._outbound.get(node.id) ?? [];
    return type ? all.filter((e) => e.type === type) : all;
  }

  hyperedges(): Iterable<HyperEdge> {
    return this._hyperedges;
  }

  /**
   * Forward BFS from `start`. Returns the first node satisfying `opts.matches`,
   * along with the path taken, or an exhaustion reason.
   *
   * Depth counts edges, not nodes — depth 0 means the start node itself matched.
   */
  traverse(start: GraphNode, opts: TraverseOpts): TraverseResult {
    if (opts.matches(start)) {
      return { found: true, terminal: start, path: [], depth: 0 };
    }
    if (opts.maxDepth <= 0) {
      return { found: false, exhausted: "depth" };
    }

    type QueueEntry = { node: GraphNode; path: PathStep[]; depth: number };
    const queue: QueueEntry[] = [{ node: start, path: [], depth: 0 }];
    const visited = new Set<string>([start.id]);
    // Tracks whether we stopped exploring a node because its depth+1 would
    // exceed maxDepth — that's the only "the answer might be further away"
    // condition. Edges to already-visited nodes don't count.
    let hitDepthLimit = false;

    while (queue.length > 0) {
      const { node, path, depth } = queue.shift()!;

      const edges = this._outbound.get(node.id) ?? [];
      for (const edge of edges) {
        if (opts.edgeTypes && !opts.edgeTypes.includes(edge.type)) continue;
        if (visited.has(edge.to)) continue;
        const next = this._nodes.get(edge.to);
        if (!next) continue;

        if (depth + 1 > opts.maxDepth) {
          hitDepthLimit = true;
          continue;
        }
        visited.add(next.id);

        const nextPath = [...path, { edge, node: next }];
        if (opts.matches(next, edge)) {
          return {
            found: true,
            terminal: next,
            path: nextPath,
            depth: depth + 1,
          };
        }
        queue.push({ node: next, path: nextPath, depth: depth + 1 });
      }
    }

    return {
      found: false,
      exhausted: hitDepthLimit ? "depth" : "dead-end",
    };
  }

  // ---------------------------------------------------------------------------
  // Internal mutators — used by graph-build.ts (3b) and graph-stitch.ts (3c).
  // ---------------------------------------------------------------------------

  /** Idempotent: re-adding a node with the same id replaces metadata. */
  addNode(node: GraphNode): void {
    this._nodes.set(node.id, node);
  }

  /**
   * Adds an outbound edge from `edge.from`. Edges are stored under the source
   * node only; reverse lookup is not currently supported (add when needed).
   */
  addEdge(edge: GraphEdge): void {
    const bucket = this._outbound.get(edge.from);
    if (bucket) bucket.push(edge);
    else this._outbound.set(edge.from, [edge]);
  }

  addHyperEdge(h: HyperEdge): void {
    this._hyperedges.push(h);
  }

  /** Returns the node with the given id, if any. */
  getNode(id: string): GraphNode | undefined {
    return this._nodes.get(id);
  }
}
