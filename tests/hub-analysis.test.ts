import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { ProjectGraph } from "../src/graph";
import { buildFileGraph } from "../src/graph-build";
import { findUnregisteredSinks } from "../src/hub-analysis";
import { SinkRegistry } from "../src/types";

function buildSingleFile(source: string): ProjectGraph {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const sf = project.createSourceFile("/a.tsx", source);
  const graph = new ProjectGraph();
  buildFileGraph(sf, graph);
  return graph;
}

const emptyReg: SinkRegistry = {
  components: [],
  attributes: [],
  functions: [],
};

describe("findUnregisteredSinks — functions", () => {
  it("flags a function called with strings ≥ minHits times", () => {
    const g = buildSingleFile(`
      notify("a");
      notify("b");
      notify("c");
      notify("d");
      notify("e");
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0].name).toBe("notify");
    expect(r.functions[0].hits).toBe(5);
  });

  it("does NOT flag functions below minHits", () => {
    const g = buildSingleFile(`
      notify("a");
      notify("b");
      notify("c");
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.functions).toEqual([]);
  });

  it("does NOT flag functions already in the registry", () => {
    const reg: SinkRegistry = {
      components: [],
      attributes: [],
      functions: [{ name: "notify", uiArgs: [0] }],
    };
    const g = buildSingleFile(`
      notify("a"); notify("b"); notify("c"); notify("d"); notify("e");
    `);
    const r = findUnregisteredSinks(g, reg, 5);
    expect(r.functions).toEqual([]);
  });

  it("counts symbol-passed args too — `notify(msg)` with `const msg = '…'`", () => {
    const g = buildSingleFile(`
      const a = "x"; const b = "y"; const c = "z"; const d = "w"; const e = "v";
      notify(a); notify(b); notify(c); notify(d); notify(e);
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0].hits).toBe(5);
  });
});

describe("findUnregisteredSinks — components", () => {
  it("flags a component used with string-bearing props ≥ minHits times", () => {
    const g = buildSingleFile(`
      const App = () => (
        <div>
          <Notice text="a" />
          <Notice text="b" />
          <Notice text="c" />
          <Notice text="d" />
          <Notice text="e" />
        </div>
      );
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.components).toHaveLength(1);
    expect(r.components[0].name).toBe("Notice");
    expect(r.components[0].hits).toBe(5);
  });

  it("does NOT flag registered components", () => {
    const reg: SinkRegistry = {
      components: [{ name: "Notice", uiProps: "all-children" }],
      attributes: [],
      functions: [],
    };
    const g = buildSingleFile(`
      const App = () => (
        <div>
          <Notice text="a" />
          <Notice text="b" />
          <Notice text="c" />
          <Notice text="d" />
          <Notice text="e" />
        </div>
      );
    `);
    const r = findUnregisteredSinks(g, reg, 5);
    expect(r.components).toEqual([]);
  });
});

describe("findUnregisteredSinks — sample collection", () => {
  it("collects up to 3 unique sample locations, deduped by file:line", () => {
    // 6 calls but only 4 unique lines → samples capped at 3.
    const g = buildSingleFile(`
      notify("a"); notify("a2");
      notify("b");
      notify("c");
      notify("d");
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0].hits).toBe(5);
    expect(r.functions[0].samples).toHaveLength(3);
    // Each sample is a unique file:line pair.
    const lines = r.functions[0].samples.map((s) => s.line);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("findUnregisteredSinks — sort order", () => {
  it("highest-hit findings first", () => {
    const g = buildSingleFile(`
      log("1"); log("2"); log("3"); log("4"); log("5"); log("6");
      notify("a"); notify("b"); notify("c"); notify("d"); notify("e");
    `);
    const r = findUnregisteredSinks(g, emptyReg, 5);
    expect(r.functions.map((f) => f.name)).toEqual(["log", "notify"]);
  });
});
