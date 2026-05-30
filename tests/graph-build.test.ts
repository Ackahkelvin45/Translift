import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { buildFileGraph } from "../src/graph-build";
import {
  GraphEdge,
  GraphNode,
  ProjectGraph,
  StringLiteralNode,
  SymbolNode,
} from "../src/graph";

function buildGraph(filename: string, source: string): ProjectGraph {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const sf = project.createSourceFile(filename, source);
  const graph = new ProjectGraph();
  buildFileGraph(sf, graph);
  return graph;
}

function nodesOfType<T extends GraphNode["type"]>(
  graph: ProjectGraph,
  type: T
): Array<Extract<GraphNode, { type: T }>> {
  return [...graph.nodes()].filter(
    (n): n is Extract<GraphNode, { type: T }> => n.type === type
  );
}

function edgesFrom(graph: ProjectGraph, node: GraphNode): GraphEdge[] {
  return [...graph.edges(node)];
}

function findSymbol(graph: ProjectGraph, name: string): SymbolNode {
  const match = nodesOfType(graph, "symbol").find((n) => n.name === name);
  if (!match) throw new Error(`symbol "${name}" not in graph`);
  return match;
}

function findString(graph: ProjectGraph, text: string): StringLiteralNode {
  const match = nodesOfType(graph, "string-literal").find(
    (n) => n.text === text
  );
  if (!match) throw new Error(`string-literal "${text}" not in graph`);
  return match;
}

describe("buildFileGraph — nodes", () => {
  it("emits one module node per file", () => {
    const g = buildGraph("/a.tsx", `const x = 1;`);
    const mods = nodesOfType(g, "module");
    expect(mods).toHaveLength(1);
    expect(mods[0].file).toBe("/a.tsx");
    expect(mods[0].line).toBe(1);
  });

  it("emits string-literal nodes for plain literals and unsubstituted templates", () => {
    const g = buildGraph(
      "/a.tsx",
      `const a = "hello"; const b = \`world\`; const c = \`hi \${x}\`;`
    );
    const strings = nodesOfType(g, "string-literal");
    const texts = strings.map((s) => s.text).sort();
    // "hello" and "world" — the dynamic template (`hi ${x}`) is intentionally NOT a string-literal.
    expect(texts).toEqual(["hello", "world"]);
  });

  it("emits symbol nodes for variables, function declarations, and parameters", () => {
    const g = buildGraph(
      "/a.tsx",
      `
      const msg = "hi";
      function notify(text: string) { return text; }
      const App = () => null;
      `
    );
    const names = nodesOfType(g, "symbol").map((s) => s.name).sort();
    expect(names).toEqual(["App", "msg", "notify", "text"]);
  });

  it("skips anonymous + destructured bindings", () => {
    const g = buildGraph(
      "/a.tsx",
      `
      const { a, b } = obj;
      function () { return 1; }
      `
    );
    expect(nodesOfType(g, "symbol")).toEqual([]);
  });

  it("emits call-expression nodes with callee name", () => {
    const g = buildGraph(
      "/a.tsx",
      `notify("hi"); toast.show("oops");`
    );
    const calls = nodesOfType(g, "call-expression").map((c) => c.calleeName);
    expect(calls.sort()).toEqual(["notify", "show"]);
  });

  it("emits jsx-element nodes with tag name", () => {
    const g = buildGraph(
      "/a.tsx",
      `const App = () => <Toast><Inner /></Toast>;`
    );
    const tags = nodesOfType(g, "jsx-element").map((n) => n.tagName).sort();
    expect(tags).toEqual(["Inner", "Toast"]);
  });

  it("collects JSX text as string-literal nodes (whitespace-only excluded)", () => {
    const g = buildGraph(
      "/a.tsx",
      `const App = () => <button>Save changes</button>;`
    );
    const texts = nodesOfType(g, "string-literal").map((n) => n.text);
    expect(texts).toContain("Save changes");
  });
});

describe("buildFileGraph — intra-file edges", () => {
  it("assigned_to: literal → declared variable", () => {
    const g = buildGraph("/a.tsx", `const msg = "Saved";`);
    const str = findString(g, "Saved");
    const sym = findSymbol(g, "msg");
    const out = edgesFrom(g, str);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "assigned_to", to: sym.id });
  });

  it("assigned_to: identifier reference → declared variable", () => {
    const g = buildGraph(
      "/a.tsx",
      `const src = "hi"; const dst = src;`
    );
    const src = findSymbol(g, "src");
    const dst = findSymbol(g, "dst");
    const out = edgesFrom(g, src).filter((e) => e.type === "assigned_to");
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(dst.id);
  });

  it("passed_as_arg: literal flows into call-expression with argIndex", () => {
    const g = buildGraph("/a.tsx", `notify("Saved");`);
    const str = findString(g, "Saved");
    const call = nodesOfType(g, "call-expression")[0];
    const out = edgesFrom(g, str).filter((e) => e.type === "passed_as_arg");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "passed_as_arg",
      to: call.id,
      argIndex: 0,
    });
  });

  it("passed_as_arg: identifier flows from declared symbol → call", () => {
    const g = buildGraph(
      "/a.tsx",
      `const msg = "Saved"; notify(msg);`
    );
    const msg = findSymbol(g, "msg");
    const call = nodesOfType(g, "call-expression")[0];
    const out = edgesFrom(g, msg).filter((e) => e.type === "passed_as_arg");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: call.id, argIndex: 0 });
  });

  it("passed_as_prop: string-literal attribute → jsx-element", () => {
    const g = buildGraph(
      "/a.tsx",
      `const App = () => <Toast message="Saved" />;`
    );
    const str = findString(g, "Saved");
    const el = nodesOfType(g, "jsx-element").find((e) => e.tagName === "Toast")!;
    const out = edgesFrom(g, str).filter((e) => e.type === "passed_as_prop");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "passed_as_prop",
      to: el.id,
      propName: "message",
    });
  });

  it("passed_as_prop: expression-wrapped identifier → jsx-element", () => {
    const g = buildGraph(
      "/a.tsx",
      `const msg = "Saved"; const App = () => <Toast message={msg} />;`
    );
    const msg = findSymbol(g, "msg");
    const el = nodesOfType(g, "jsx-element").find((e) => e.tagName === "Toast")!;
    const out = edgesFrom(g, msg).filter((e) => e.type === "passed_as_prop");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: el.id, propName: "message" });
  });

  it("returned_from: identifier in return → enclosing function symbol", () => {
    const g = buildGraph(
      "/a.tsx",
      `function identity(x: string) { return x; }`
    );
    const x = findSymbol(g, "x");
    const fn = findSymbol(g, "identity");
    const out = edgesFrom(g, x).filter((e) => e.type === "returned_from");
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(fn.id);
  });

  it("returned_from: literal in arrow function return → enclosing symbol", () => {
    const g = buildGraph(
      "/a.tsx",
      `const getLabel = () => "Hello";`
    );
    const str = findString(g, "Hello");
    const fn = findSymbol(g, "getLabel");
    const out = edgesFrom(g, str).filter((e) => e.type === "returned_from");
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(fn.id);
  });
});

describe("buildFileGraph — integration", () => {
  it("comprehensive fixture: 5 node types, 4 edge types, one file", () => {
    const g = buildGraph(
      "/Form.tsx",
      `
      const msg = "Saved successfully";

      export function App() {
        notify(msg);
        return <Toast message={msg} />;
      }

      function notify(text: string) {
        return text;
      }
      `
    );

    // Node types
    expect(nodesOfType(g, "module")).toHaveLength(1);
    expect(nodesOfType(g, "string-literal").map((s) => s.text).sort()).toEqual(
      ["Saved successfully"]
    );
    expect(nodesOfType(g, "symbol").map((s) => s.name).sort()).toEqual(
      ["App", "msg", "notify", "text"]
    );
    expect(nodesOfType(g, "call-expression").map((c) => c.calleeName)).toEqual(
      ["notify"]
    );
    expect(nodesOfType(g, "jsx-element").map((j) => j.tagName)).toEqual([
      "Toast",
    ]);

    // Edge types
    const allEdges: GraphEdge[] = [...g.nodes()].flatMap((n) => [...g.edges(n)]);
    const byType = (t: string) => allEdges.filter((e) => e.type === t);

    expect(byType("assigned_to")).toHaveLength(1);
    expect(byType("passed_as_arg")).toHaveLength(1);
    expect(byType("passed_as_prop")).toHaveLength(1);
    expect(byType("returned_from")).toHaveLength(1);
  });
});
