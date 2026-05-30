import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import {
  CallExpressionNode,
  GraphNode,
  JsxElementNode,
  ProjectGraph,
  StringLiteralNode,
  SymbolNode,
  nodeId,
} from "../src/graph";
import { buildFileGraph } from "../src/graph-build";
import { stitchFileImports } from "../src/graph-stitch";
import { trace } from "../src/pass2";
import { SinkRegistry } from "../src/types";

/* -------------------------------------------------------------------------- */
/* Helpers: synthetic graph fixtures                                          */
/* -------------------------------------------------------------------------- */

function makeRegistry(overrides: Partial<SinkRegistry> = {}): SinkRegistry {
  return {
    components: overrides.components ?? [],
    attributes: overrides.attributes ?? [],
    functions: overrides.functions ?? [],
  };
}

function mkString(file: string, offset: number, text: string): StringLiteralNode {
  return {
    id: nodeId(file, offset),
    type: "string-literal",
    file,
    line: 1,
    column: 0,
    text,
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

function mkCall(
  file: string,
  offset: number,
  calleeName: string
): CallExpressionNode {
  return {
    id: nodeId(file, offset),
    type: "call-expression",
    file,
    line: 1,
    column: 0,
    calleeName,
  };
}

function mkJsx(file: string, offset: number, tagName: string): JsxElementNode {
  return {
    id: nodeId(file, offset),
    type: "jsx-element",
    file,
    line: 1,
    column: 0,
    tagName,
  };
}

/* -------------------------------------------------------------------------- */
/* Synthetic graph tests — exercise BFS+match logic in isolation              */
/* -------------------------------------------------------------------------- */

describe("trace — function sink", () => {
  it("matches a registered function callee at the end of a chain", () => {
    // "Saved" → msg → notify("…") — notify is registered
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "Saved");
    const msg = mkSymbol("/a.ts", 10, "msg");
    const call = mkCall("/a.ts", 20, "notify");
    [str, msg, call].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: msg.id });
    g.addEdge({
      type: "passed_as_arg",
      from: msg.id,
      to: call.id,
      argIndex: 0,
    });

    const reg = makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] });
    const r = trace(str, g, reg);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sink).toEqual({ kind: "function", name: "notify" });
    expect(r.depth).toBe(2);
    expect(r.path.map((p) => p.edge.type)).toEqual([
      "assigned_to",
      "passed_as_arg",
    ]);
  });

  it("misses when the callee name isn't registered", () => {
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "Saved");
    const call = mkCall("/a.ts", 10, "log"); // not a sink
    [str, call].forEach((n) => g.addNode(n));
    g.addEdge({ type: "passed_as_arg", from: str.id, to: call.id, argIndex: 0 });

    const r = trace(str, g, makeRegistry());
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.exhausted).toBe("dead-end");
  });
});

describe("trace — component sink", () => {
  it("matches a registered JSX tag at the end of a chain", () => {
    // "Saved" → msg → <Toast message={msg} /> — Toast is registered
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "Saved");
    const msg = mkSymbol("/a.ts", 10, "msg");
    const toast = mkJsx("/a.ts", 30, "Toast");
    [str, msg, toast].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: msg.id });
    g.addEdge({
      type: "passed_as_prop",
      from: msg.id,
      to: toast.id,
      propName: "message",
    });

    const reg = makeRegistry({
      components: [{ name: "Toast", uiProps: "all-children" }],
    });
    const r = trace(str, g, reg);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sink).toEqual({ kind: "component", name: "Toast" });
    expect(r.depth).toBe(2);
  });
});

describe("trace — termination conditions", () => {
  it("dead-ends when the start node has no outbound traversal edges", () => {
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "Saved");
    g.addNode(str);
    const r = trace(str, g, makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] }));
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.exhausted).toBe("dead-end");
  });

  it("returns exhausted: 'depth' when the chain is longer than maxDepth", () => {
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "x");
    const a = mkSymbol("/a.ts", 10, "a");
    const b = mkSymbol("/a.ts", 20, "b");
    const c = mkSymbol("/a.ts", 30, "c");
    const call = mkCall("/a.ts", 40, "notify");
    [str, a, b, c, call].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: a.id });
    g.addEdge({ type: "assigned_to", from: a.id, to: b.id });
    g.addEdge({ type: "assigned_to", from: b.id, to: c.id });
    g.addEdge({ type: "passed_as_arg", from: c.id, to: call.id, argIndex: 0 });

    const reg = makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] });
    const r = trace(str, g, reg, /* maxDepth */ 2);
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.exhausted).toBe("depth");
  });

  it("does NOT follow imports edges", () => {
    // assigned_to to symbol, then imports edge to a sink call.
    // Imports is metadata, so BFS must not cross it.
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "x");
    const sym = mkSymbol("/a.ts", 10, "msg");
    const call = mkCall("/lib.ts", 0, "notify");
    [str, sym, call].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: sym.id });
    g.addEdge({
      type: "imports",
      from: sym.id,
      to: call.id,
      specifier: "./lib",
    });

    const reg = makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] });
    const r = trace(str, g, reg);
    expect(r.resolved).toBe(false);
  });
});

describe("trace — branching paths", () => {
  it("any branch that reaches a sink wins", () => {
    // "x" → msg, then msg passes to two places: log() (not a sink) and notify() (sink)
    const g = new ProjectGraph();
    const str = mkString("/a.ts", 0, "x");
    const msg = mkSymbol("/a.ts", 10, "msg");
    const logCall = mkCall("/a.ts", 20, "log");
    const notifyCall = mkCall("/a.ts", 30, "notify");
    [str, msg, logCall, notifyCall].forEach((n) => g.addNode(n));
    g.addEdge({ type: "assigned_to", from: str.id, to: msg.id });
    g.addEdge({ type: "passed_as_arg", from: msg.id, to: logCall.id, argIndex: 0 });
    g.addEdge({ type: "passed_as_arg", from: msg.id, to: notifyCall.id, argIndex: 0 });

    const reg = makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] });
    const r = trace(str, g, reg);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sink.name).toBe("notify");
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end: ts-morph + buildFileGraph + stitch + trace                     */
/* -------------------------------------------------------------------------- */

describe("trace — cross-file integration", () => {
  function buildAll(files: Record<string, string>): ProjectGraph {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    });
    const sources = Object.entries(files).map(([p, c]) =>
      project.createSourceFile(p, c)
    );
    const graph = new ProjectGraph();
    for (const sf of sources) buildFileGraph(sf, graph);
    for (const sf of sources) stitchFileImports(sf, graph);
    return graph;
  }

  function findSeed(graph: ProjectGraph, text: string): GraphNode {
    const match = [...graph.nodes()].find(
      (n) => n.type === "string-literal" && (n as StringLiteralNode).text === text
    );
    if (!match) throw new Error(`string-literal "${text}" not in graph`);
    return match;
  }

  it("traces a string declared in lib.ts to a <Toast> in app.tsx", () => {
    const g = buildAll({
      "/lib.ts": `export const msg = "Payment failed";`,
      "/app.tsx": `
        import { msg } from "./lib";
        export const App = () => <Toast message={msg} />;
      `,
    });

    const seed = findSeed(g, "Payment failed");
    const reg = makeRegistry({
      components: [{ name: "Toast", uiProps: "all-children" }],
    });
    const r = trace(seed, g, reg);

    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sink).toEqual({ kind: "component", name: "Toast" });
    expect(r.path.map((p) => p.edge.type)).toEqual([
      "assigned_to",
      "passed_as_prop",
    ]);
  });

  it("traces through a barrel re-export into a sink", () => {
    const g = buildAll({
      "/lib/notify.ts": `export function notify(msg: string) { return msg; }`,
      "/lib/index.ts": `export { notify } from "./notify";`,
      "/app.tsx": `
        import { notify } from "./lib";
        const m = "Saved";
        notify(m);
      `,
    });

    const seed = findSeed(g, "Saved");
    const reg = makeRegistry({ functions: [{ name: "notify", uiArgs: [0] }] });
    const r = trace(seed, g, reg);
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.sink.name).toBe("notify");
  });
});
