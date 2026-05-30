/**
 * F3 — `importFrom` enforcement + aliased-import resolution.
 *
 * Two scenarios that previously failed silently:
 *
 *   1. Two same-name functions from different modules. Pre-F3 the registry's
 *      `importFrom` was theatrical — both matched. F3 rejects the one whose
 *      import doesn't line up.
 *   2. `import { toast as showToast } from "react-hot-toast"` — pre-F3 this
 *      never wrapped because the callee identifier was `showToast` and the
 *      registry had `toast`. F3 resolves the alias and wraps + warns.
 *
 * Both Pass 2 (graph BFS) and Pass 1 (Babel signal-based fast path) are
 * tested via `pipeline.run()` with a real `ProjectGraphContext`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project, ts } from "ts-morph";
import { run } from "../src/pipeline";
import { buildProjectGraphFromProject } from "../src/graph-project";
import { resolve as resolveConfig, TransliftConfig } from "../src/config";
import { trace } from "../src/pass2";
import { SinkRegistry } from "../src/types";
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

async function runAll(
  files: Record<string, string>,
  configInput: TransliftConfig
) {
  const project = mkProject(files);
  const ctx = buildProjectGraphFromProject(project);
  const config = resolveConfig(configInput, null);
  const results: Array<{ path: string; result: Awaited<ReturnType<typeof run>> }> =
    [];
  const sharedKeys = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const result = await run(path, content, {
      dryRun: true,
      usedKeys: sharedKeys,
      config,
      graphContext: ctx,
    });
    results.push({ path, result });
  }
  return { ctx, results };
}

describe("F3 — importFrom enforcement on function sinks", () => {
  it("matches when actual import specifier equals entry.importFrom", async () => {
    // Babel signal will fire on `notify("Saved successfully.")`; graph confirms import.
    const { results } = await runAll(
      {
        "/lib/notify.ts":
          `export function notify(msg: string) { return msg; }`,
        "/app.tsx": `
          import { notify } from "./lib/notify";
          notify("Saved successfully.");
        `,
      },
      {
        sinks: {
          functions: [
            { name: "notify", importFrom: "./lib/notify", uiArgs: [0] },
          ],
        },
      }
    );
    const app = results.find((r) => r.path === "/app.tsx")!;
    const texts = app.result.wrapped.map((w) => w.node.text);
    expect(texts).toContain("Saved successfully.");
  });

  it("rejects same-name call from a different module", async () => {
    const { results } = await runAll(
      {
        "/lib/legacy.ts":
          `export function notify(msg: string) { return msg; }`,
        "/app.tsx": `
          import { notify } from "./lib/legacy";
          notify("Saved successfully.");
        `,
      },
      {
        sinks: {
          functions: [
            // Constrained to a different specifier — should NOT match.
            { name: "notify", importFrom: "./lib/canonical", uiArgs: [0] },
          ],
        },
      }
    );
    const app = results.find((r) => r.path === "/app.tsx")!;
    const texts = app.result.wrapped.map((w) => w.node.text);
    expect(texts).not.toContain("Saved successfully.");
  });

  it("disambiguates two registry entries with the same name", async () => {
    const { results } = await runAll(
      {
        "/lib/strict/notify.ts":
          `export function notify(msg: string) { return msg; }`,
        "/lib/legacy/notify.ts":
          `export function notify(msg: string) { return msg; }`,
        "/app.tsx": `
          import { notify } from "./lib/strict/notify";
          notify("Strict path");
        `,
        "/legacy.tsx": `
          import { notify } from "./lib/legacy/notify";
          notify("Legacy path");
        `,
      },
      {
        sinks: {
          // Only the strict variant is a real sink.
          functions: [
            {
              name: "notify",
              importFrom: "./lib/strict/notify",
              uiArgs: [0],
            },
          ],
        },
      }
    );
    const app = results.find((r) => r.path === "/app.tsx")!;
    const legacy = results.find((r) => r.path === "/legacy.tsx")!;
    expect(app.result.wrapped.map((w) => w.node.text)).toContain("Strict path");
    expect(legacy.result.wrapped.map((w) => w.node.text)).not.toContain(
      "Legacy path"
    );
  });
});

describe("F3 — aliased imports resolve via the canonical export name", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("Pass 1 wraps `showToast(...)` when registry has `notify` from same module (alias)", async () => {
    const { results } = await runAll(
      {
        "/lib/notify.ts":
          `export function notify(msg: string) { return msg; }`,
        "/app.tsx": `
          import { notify as showToast } from "./lib/notify";
          showToast("Saved successfully.");
        `,
      },
      {
        sinks: {
          functions: [
            { name: "notify", importFrom: "./lib/notify", uiArgs: [0] },
          ],
        },
      }
    );
    const app = results.find((r) => r.path === "/app.tsx")!;
    expect(app.result.wrapped.map((w) => w.node.text)).toContain("Saved successfully.");
  });

  it("emits a warning when the alias was used", async () => {
    await runAll(
      {
        "/lib/notify.ts":
          `export function notify(msg: string) { return msg; }`,
        "/app.tsx": `
          import { notify as showToast } from "./lib/notify";
          showToast("Saved successfully.");
        `,
      },
      {
        sinks: {
          functions: [
            { name: "notify", importFrom: "./lib/notify", uiArgs: [0] },
          ],
        },
      }
    );
    // At least one stderr write should mention the aliased-import warning.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => /aliased import/i.test(c))).toBe(true);
    expect(calls.some((c) => /showToast/i.test(c))).toBe(true);
  });
});

describe("F3 — Pass 2 (graph BFS) also enforces importFrom", () => {
  function findString(
    graph: ReturnType<typeof buildProjectGraphFromProject>["graph"],
    text: string
  ): GraphNode {
    for (const n of graph.nodes()) {
      if (n.type === "string-literal" && (n as StringLiteralNode).text === text) {
        return n;
      }
    }
    throw new Error(`no string-literal "${text}" in graph`);
  }

  it("BFS rejects component match when importFrom is wrong", () => {
    const project = mkProject({
      "/other/Toast.tsx":
        `export function Toast(props: { message?: string }) { return null; }`,
      "/app.tsx": `
        import { Toast } from "./other/Toast";
        const msg = "Hello.";
        export const App = () => <Toast message={msg} />;
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      components: [
        {
          name: "Toast",
          uiProps: "all-children",
          importFrom: "@/ui/Toast",
        },
      ],
      attributes: [],
      functions: [],
    };
    const seed = findString(ctx.graph, "Hello.");
    expect(trace(seed, ctx.graph, reg).resolved).toBe(false);
  });

  it("BFS accepts component match when importFrom is right", () => {
    const project = mkProject({
      "/ui/Toast.tsx":
        `export function Toast(props: { message?: string }) { return null; }`,
      "/app.tsx": `
        import { Toast } from "./ui/Toast";
        const msg = "Hello.";
        export const App = () => <Toast message={msg} />;
      `,
    });
    const ctx = buildProjectGraphFromProject(project);
    const reg: SinkRegistry = {
      components: [
        {
          name: "Toast",
          uiProps: "all-children",
          importFrom: "./ui/Toast",
        },
      ],
      attributes: [],
      functions: [],
    };
    const seed = findString(ctx.graph, "Hello.");
    expect(trace(seed, ctx.graph, reg).resolved).toBe(true);
  });
});
