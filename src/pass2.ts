import { StringNode, SinkRegistry } from "./types";

// Phase 0: intra-file tracing only. Cross-file resolution is Phase 1.
//
// Strategy: if the escalated string is currently passed as a prop or an argument,
// look forward within the same file for usages that forward that prop into a
// known sink (component prop, attribute sink, or function sink). If any path
// reaches a sink within `maxDepth` hops, return that sink. Otherwise unresolved.
//
// Phase 0 leaves the implementation as a best-effort no-op stub — most fixture
// strings resolve in Pass 1, so this rarely fires. Wire up the real walk when a
// fixture actually needs it.
export function trace(
  _node: StringNode,
  _allNodes: StringNode[],
  _registry: SinkRegistry,
  _maxDepth: number = 2
): { sink: string | null; depth: number; path: string[] } {
  return { sink: null, depth: 0, path: [] };
}
