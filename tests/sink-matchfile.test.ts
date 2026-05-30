/**
 * F1 — `matchFile` glob support in component and function sinks.
 *
 * Each test wires up a two-file synthetic project, builds the graph, and
 * traces from a string into a sink, varying the `matchFile` glob to confirm
 * the path filter is enforced at sink-match time.
 */
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import {
  buildProjectGraphFromProject,
  stringLiteralKey,
} from "../src/graph-project";
import { trace } from "../src/pass2";
import { SinkRegistry, StringKind } from "../src/types";
import { GraphNode, StringLiteralNode } from "../src/graph";

function mkProject(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
    },
  });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

function findString(graph: ReturnType<typeof buildProjectGraphFromProject>["graph"], text: string): GraphNode {
  for (const n of graph.nodes()) {
    if (n.type === "string-literal" && (n as StringLiteralNode).text === text) {
      return n;
    }
  }
  throw new Error(`no string-literal "${text}" in graph`);
}

const emptyReg = (): SinkRegistry => ({
  components: [],
  attributes: [],
  functions: [],
});

describe("F1 — matchFile on component sinks", () => {
  it("accepts when declaration file matches the glob", () => {
    const project = mkProject({
      "/packages/ui/src/components/Toast.tsx":
        `export function Toast(props: { message?: string }) { return null; }`,
      "/app.tsx": `
        import { Toast } from "./packages/ui/src/components/Toast";
        const msg = "Hello there.";
        export const App = () => <Toast message={msg} />;
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      components: [
        {
          name: "Toast",
          uiProps: "all-children",
          matchFile: "**/packages/ui/src/components/**",
        },
      ],
    };
    const seed = findString(ctx.graph, "Hello there.");
    const r = trace(seed, ctx.graph, reg);
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.sink.name).toBe("Toast");
  });

  it("rejects when declaration file does NOT match the glob", () => {
    const project = mkProject({
      // Toast is declared somewhere the glob doesn't allow.
      "/other-lib/Toast.tsx":
        `export function Toast(props: { message?: string }) { return null; }`,
      "/app.tsx": `
        import { Toast } from "./other-lib/Toast";
        const msg = "Hello there.";
        export const App = () => <Toast message={msg} />;
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      components: [
        {
          name: "Toast",
          uiProps: "all-children",
          matchFile: "**/packages/ui/src/components/**",
        },
      ],
    };
    const seed = findString(ctx.graph, "Hello there.");
    const r = trace(seed, ctx.graph, reg);
    expect(r.resolved).toBe(false);
  });

  it("entries without matchFile keep working unchanged", () => {
    const project = mkProject({
      "/anywhere/Toast.tsx":
        `export function Toast(props: { message?: string }) { return null; }`,
      "/app.tsx": `
        import { Toast } from "./anywhere/Toast";
        const msg = "Hello there.";
        export const App = () => <Toast message={msg} />;
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      components: [{ name: "Toast", uiProps: "all-children" }],
    };
    const seed = findString(ctx.graph, "Hello there.");
    const r = trace(seed, ctx.graph, reg);
    expect(r.resolved).toBe(true);
  });
});

describe("F1 — matchFile on function sinks", () => {
  it("accepts when callee's declaration file matches the glob", () => {
    const project = mkProject({
      "/lib/notify.ts": `export function notify(msg: string) { return msg; }`,
      "/app.tsx": `
        import { notify } from "./lib/notify";
        const m = "Saved";
        notify(m);
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      functions: [
        { name: "notify", uiArgs: [0], matchFile: "**/lib/**" },
      ],
    };
    const seed = findString(ctx.graph, "Saved");
    const r = trace(seed, ctx.graph, reg);
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.sink.name).toBe("notify");
  });

  it("rejects when callee's declaration file does NOT match the glob", () => {
    const project = mkProject({
      "/utils/notify.ts": `export function notify(msg: string) { return msg; }`,
      "/app.tsx": `
        import { notify } from "./utils/notify";
        const m = "Saved";
        notify(m);
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      functions: [
        { name: "notify", uiArgs: [0], matchFile: "**/lib/**" },
      ],
    };
    const seed = findString(ctx.graph, "Saved");
    const r = trace(seed, ctx.graph, reg);
    expect(r.resolved).toBe(false);
  });
});

describe("F1 — multiple entries with same name, different matchFile", () => {
  it("matches the correct one based on declaration path", () => {
    const project = mkProject({
      "/lib/notify.ts": `export function notify(msg: string) { return msg; }`,
      "/legacy/notify.ts": `export function notify(msg: string) { return msg; }`,
      "/app.tsx": `
        import { notify } from "./lib/notify";
        const m = "From lib";
        notify(m);
      `,
      "/legacy-caller.tsx": `
        import { notify } from "./legacy/notify";
        const m2 = "From legacy";
        notify(m2);
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      ...emptyReg(),
      functions: [
        // Only flag lib-resident notify — legacy is intentionally ignored.
        { name: "notify", uiArgs: [0], matchFile: "**/lib/**" },
      ],
    };

    const libSeed = findString(ctx.graph, "From lib");
    expect(trace(libSeed, ctx.graph, reg).resolved).toBe(true);

    const legacySeed = findString(ctx.graph, "From legacy");
    expect(trace(legacySeed, ctx.graph, reg).resolved).toBe(false);
  });
});
