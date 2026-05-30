import { describe, expect, it } from "vitest";
import {
  GraphEdge,
  GraphNode,
  ModuleNode,
  ProjectGraph,
  StringLiteralNode,
  SymbolNode,
  nodeId,
} from "../src/graph";

function mkModule(file: string): ModuleNode {
  return {
    id: nodeId(file, 0),
    type: "module",
    file,
    line: 1,
    column: 0,
  };
}

function mkSymbol(file: string, offset: number, name: string): SymbolNode {
  return {
    id: nodeId(file, offset),
    type: "symbol",
    file,
    line: 1,
    column: 0,
    name,
  };
}

function mkString(
  file: string,
  offset: number,
  text: string
): StringLiteralNode {
  return {
    id: nodeId(file, offset),
    type: "string-literal",
    file,
    line: 1,
    column: 0,
    text,
  };
}

describe("nodeId", () => {
  it("is stable and unique per (file, offset)", () => {
    expect(nodeId("/a.ts", 10)).toBe("/a.ts:10");
    expect(nodeId("/a.ts", 10)).toBe(nodeId("/a.ts", 10));
    expect(nodeId("/a.ts", 10)).not.toBe(nodeId("/a.ts", 11));
    expect(nodeId("/a.ts", 10)).not.toBe(nodeId("/b.ts", 10));
  });
});

describe("ProjectGraph — empty graph contract", () => {
  it("yields no nodes", () => {
    const g = new ProjectGraph();
    expect([...g.nodes()]).toEqual([]);
  });

  it("yields no edges for an unknown node", () => {
    const g = new ProjectGraph();
    const ghost = mkModule("/ghost.ts");
    expect([...g.edges(ghost)]).toEqual([]);
  });

  it("yields no hyperedges", () => {
    const g = new ProjectGraph();
    expect([...g.hyperedges()]).toEqual([]);
  });

  it("traverse on an isolated node returns dead-end", () => {
    const g = new ProjectGraph();
    const node = mkString("/a.ts", 0, "hello");
    g.addNode(node);
    const result = g.traverse(node, {
      maxDepth: 5,
      matches: () => false,
    });
    expect(result).toEqual({ found: false, exhausted: "dead-end" });
  });
});

describe("ProjectGraph — mutators", () => {
  it("addNode is idempotent (replaces metadata under same id)", () => {
    const g = new ProjectGraph();
    g.addNode(mkSymbol("/a.ts", 0, "x"));
    g.addNode(mkSymbol("/a.ts", 0, "x_updated"));
    const nodes = [...g.nodes()] as SymbolNode[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("x_updated");
  });

  it("addEdge stores outbound edges under the source node", () => {
    const g = new ProjectGraph();
    const s = mkString("/a.ts", 0, "hi");
    const sym = mkSymbol("/a.ts", 10, "msg");
    g.addNode(s);
    g.addNode(sym);
    g.addEdge({ type: "assigned_to", from: s.id, to: sym.id });

    const out = [...g.edges(s)];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "assigned_to", to: sym.id });

    expect([...g.edges(sym)]).toEqual([]); // outbound only — no reverse lookup
  });

  it("edges(node, type) narrows to that edge type only", () => {
    const g = new ProjectGraph();
    const a = mkSymbol("/a.ts", 0, "a");
    const b = mkSymbol("/a.ts", 10, "b");
    g.addNode(a);
    g.addNode(b);
    g.addEdge({ type: "assigned_to", from: a.id, to: b.id });
    g.addEdge({
      type: "passed_as_arg",
      from: a.id,
      to: b.id,
      argIndex: 0,
    });

    expect([...g.edges(a)]).toHaveLength(2);
    expect([...g.edges(a, "assigned_to")]).toHaveLength(1);
    expect([...g.edges(a, "passed_as_prop")]).toEqual([]);
  });
});

describe("ProjectGraph.traverse — BFS", () => {
  // Build: str → msg → notifyCall → notifyFn (target sink)
  function lineGraph() {
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "Saved");
    const msg = mkSymbol("/a.ts", 10, "msg");
    const notifyCall: GraphNode = {
      id: nodeId("/a.ts", 20),
      type: "call-expression",
      file: "/a.ts",
      line: 1,
      column: 0,
      calleeName: "notify",
    };
    const notifyFn = mkSymbol("/lib.ts", 0, "notify");
    [str, msg, notifyCall, notifyFn].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: msg.id });
    g.addEdge({
      type: "passed_as_arg",
      from: msg.id,
      to: notifyCall.id,
      argIndex: 0,
    });
    g.addEdge({ type: "imports", from: notifyCall.id, to: notifyFn.id, specifier: "./lib" });
    return { g, str, msg, notifyCall, notifyFn };
  }

  it("returns depth 0 + empty path when start already matches", () => {
    const { g, str } = lineGraph();
    const r = g.traverse(str, { maxDepth: 5, matches: (n) => n === str });
    expect(r).toEqual({ found: true, terminal: str, path: [], depth: 0 });
  });

  it("walks the line graph to the sink and records the path", () => {
    const { g, str, msg, notifyCall, notifyFn } = lineGraph();
    const r = g.traverse(str, {
      maxDepth: 5,
      matches: (n) => n.id === notifyFn.id,
    });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.depth).toBe(3);
    expect(r.terminal).toBe(notifyFn);
    expect(r.path.map((s) => s.node)).toEqual([msg, notifyCall, notifyFn]);
    expect(r.path.map((s) => s.edge.type)).toEqual([
      "assigned_to",
      "passed_as_arg",
      "imports",
    ]);
  });

  it("respects edgeTypes filter — dead-ends when no allowed edges exist", () => {
    const { g, str, notifyFn } = lineGraph();
    const r = g.traverse(str, {
      maxDepth: 5,
      edgeTypes: ["passed_as_prop"],
      matches: (n) => n.id === notifyFn.id,
    });
    expect(r).toEqual({ found: false, exhausted: "dead-end" });
  });

  it("respects maxDepth — returns exhausted: depth", () => {
    const { g, str, notifyFn } = lineGraph();
    const r = g.traverse(str, {
      maxDepth: 1,
      matches: (n) => n.id === notifyFn.id,
    });
    expect(r).toEqual({ found: false, exhausted: "depth" });
  });

  it("does not revisit nodes — cycles terminate", () => {
    const g = new ProjectGraph();
    const a = mkSymbol("/a.ts", 0, "a");
    const b = mkSymbol("/a.ts", 10, "b");
    g.addNode(a);
    g.addNode(b);
    g.addEdge({ type: "assigned_to", from: a.id, to: b.id });
    g.addEdge({ type: "assigned_to", from: b.id, to: a.id });
    const r = g.traverse(a, { maxDepth: 100, matches: () => false });
    expect(r.found).toBe(false);
  });
});
