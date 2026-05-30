import { describe, expect, it } from "vitest";
import { Project, SourceFile, ts } from "ts-morph";
import { buildFileGraph } from "../src/graph-build";
import { stitchFileImports } from "../src/graph-stitch";
import {
  GraphEdge,
  GraphNode,
  ImportsEdge,
  ProjectGraph,
  nodeId,
} from "../src/graph";

function mkProject() {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
}

function buildAll(files: Record<string, string>): {
  graph: ProjectGraph;
  project: Project;
  sources: Record<string, SourceFile>;
} {
  const project = mkProject();
  const sources: Record<string, SourceFile> = {};
  for (const [path, content] of Object.entries(files)) {
    sources[path] = project.createSourceFile(path, content);
  }
  const graph = new ProjectGraph();
  for (const sf of Object.values(sources)) buildFileGraph(sf, graph);
  for (const sf of Object.values(sources)) stitchFileImports(sf, graph);
  return { graph, project, sources };
}

function importsEdgesFrom(graph: ProjectGraph, modulePath: string): ImportsEdge[] {
  const moduleNode = graph.getNode(nodeId(modulePath, 0));
  if (!moduleNode) throw new Error(`no module node for ${modulePath}`);
  return [...graph.edges(moduleNode, "imports")];
}

describe("stitchFileImports — named imports", () => {
  it("emits one imports edge per named import, pointing at the original declaration", () => {
    const { graph, sources } = buildAll({
      "/lib.ts": `export const msg = "Hi"; export function greet() {}`,
      "/app.tsx": `import { msg, greet } from "./lib"; greet();`,
    });

    const edges = importsEdgesFrom(graph, "/app.tsx");
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.specifier === "./lib")).toBe(true);

    // Both edges should land on declared symbols in lib.ts.
    const targetIds = edges.map((e) => e.to).sort();
    const msgSym = [...graph.nodes()].find(
      (n) => n.type === "symbol" && n.name === "msg"
    )!;
    const greetSym = [...graph.nodes()].find(
      (n) => n.type === "symbol" && n.name === "greet"
    )!;
    expect(targetIds).toEqual([msgSym.id, greetSym.id].sort());
  });

  it("resolves aliased imports to the original declaration", () => {
    const { graph } = buildAll({
      "/lib.ts": `export const original = "Hi";`,
      "/app.tsx": `import { original as renamed } from "./lib";`,
    });

    const edges = importsEdgesFrom(graph, "/app.tsx");
    expect(edges).toHaveLength(1);
    const original = [...graph.nodes()].find(
      (n) => n.type === "symbol" && n.name === "original"
    )!;
    expect(edges[0].to).toBe(original.id);
  });

  it("walks through barrel re-exports to the original declaration", () => {
    const { graph } = buildAll({
      "/lib/Toast.ts": `export function Toast() {}`,
      "/lib/index.ts": `export { Toast } from "./Toast";`,
      "/app.tsx": `import { Toast } from "./lib";`,
    });

    const edges = importsEdgesFrom(graph, "/app.tsx");
    expect(edges).toHaveLength(1);
    const toastSym = [...graph.nodes()].find(
      (n) => n.type === "symbol" && n.name === "Toast"
    )!;
    // The Toast symbol should be the one declared in /lib/Toast.ts.
    expect(toastSym.file).toBe("/lib/Toast.ts");
    expect(edges[0].to).toBe(toastSym.id);
  });
});

describe("stitchFileImports — default and namespace imports", () => {
  it("default import lands on default-exported declaration", () => {
    const { graph } = buildAll({
      "/lib.ts": `export default function Greet() {}`,
      "/app.tsx": `import Greet from "./lib";`,
    });

    const edges = importsEdgesFrom(graph, "/app.tsx");
    expect(edges).toHaveLength(1);
    const greetSym = [...graph.nodes()].find(
      (n) => n.type === "symbol" && n.name === "Greet"
    )!;
    expect(edges[0].to).toBe(greetSym.id);
  });

  it("namespace import lands on the source module node", () => {
    const { graph } = buildAll({
      "/lib.ts": `export const a = 1; export const b = 2;`,
      "/app.tsx": `import * as ns from "./lib";`,
    });

    const edges = importsEdgesFrom(graph, "/app.tsx");
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe(nodeId("/lib.ts", 0));
  });
});

describe("stitchFileImports — boundaries", () => {
  it("emits no edge for unresolvable specifiers", () => {
    const { graph } = buildAll({
      "/app.tsx": `import { x } from "./nope";`,
    });
    expect(importsEdgesFrom(graph, "/app.tsx")).toEqual([]);
  });

  it("emits no edge for side-effect imports", () => {
    const { graph } = buildAll({
      "/lib.ts": `export const a = 1;`,
      "/app.tsx": `import "./lib";`,
    });
    expect(importsEdgesFrom(graph, "/app.tsx")).toEqual([]);
  });
});

describe("end-to-end: cross-file string trace via BFS", () => {
  it("a string declared in lib.ts reaches a JSX sink in app.tsx", () => {
    const { graph } = buildAll({
      "/lib.ts": `export const msg = "Payment failed";`,
      "/app.tsx": `
        import { msg } from "./lib";
        export const App = () => <Toast message={msg} />;
      `,
    });

    const seed = [...graph.nodes()].find(
      (n): n is GraphNode & { type: "string-literal" } =>
        n.type === "string-literal" && n.text === "Payment failed"
    )!;
    expect(seed).toBeDefined();
    expect(seed.file).toBe("/lib.ts");

    const result = graph.traverse(seed, {
      maxDepth: 5,
      matches: (n) => n.type === "jsx-element" && n.tagName === "Toast",
    });

    expect(result.found).toBe(true);
    if (!result.found) return;
    // Expected hops: assigned_to → passed_as_prop.
    expect(result.path.map((s) => s.edge.type)).toEqual([
      "assigned_to",
      "passed_as_prop",
    ]);
    expect(result.terminal.type).toBe("jsx-element");
    expect((result.terminal as { tagName: string }).tagName).toBe("Toast");
  });

  it("two-hop chain through a re-exporting barrel still resolves", () => {
    const { graph } = buildAll({
      "/lib/Toast.ts": `export function Toast() { return null; }`,
      "/lib/index.ts": `export { Toast } from "./Toast";`,
      "/app.tsx": `
        import { Toast } from "./lib";
        const label = "Saved";
        export const App = () => <Toast message={label} />;
      `,
    });

    const seed = [...graph.nodes()].find(
      (n) => n.type === "string-literal" && (n as { text: string }).text === "Saved"
    )!;

    const result = graph.traverse(seed, {
      maxDepth: 5,
      matches: (n) => n.type === "jsx-element" && n.tagName === "Toast",
    });

    expect(result.found).toBe(true);
  });
});
