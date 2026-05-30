/**
 * Sub-step 3e integration tests — pipeline.run() with a real ProjectGraphContext.
 *
 * Exercises the full Phase 0 + Phase 2 flow on multi-file synthetic projects.
 * Asserts that strings that Pass 1 escalates get successfully traced (or not)
 * via Pass 2 and end up in the right verdict bucket.
 */
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { run, PipelineResult } from "../src/pipeline";
import {
  ProjectGraphContext,
  buildProjectGraphFromProject,
} from "../src/graph-project";
import { resolve as resolveConfig } from "../src/config";
import { ResolvedConfig } from "../src/config";
import { TransliftConfig } from "../src/config";

function buildContext(files: Record<string, string>): {
  ctx: ProjectGraphContext;
  files: Record<string, string>;
} {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
    },
  });
  for (const [p, c] of Object.entries(files)) project.createSourceFile(p, c);
  return { ctx: buildProjectGraphFromProject(project), files };
}

async function runAll(
  setup: { ctx: ProjectGraphContext; files: Record<string, string> },
  configInput?: TransliftConfig
): Promise<Array<{ path: string; result: PipelineResult }>> {
  const config: ResolvedConfig = resolveConfig(configInput ?? {}, null);
  const sharedKeys = new Set<string>();
  const results = [];
  for (const [path, content] of Object.entries(setup.files)) {
    const result = await run(path, content, {
      dryRun: true,
      usedKeys: sharedKeys,
      config,
      graphContext: setup.ctx,
    });
    results.push({ path, result });
  }
  return results;
}

describe("pipeline cross-file Pass 2 — acceptance #4 spine", () => {
  it("string declared in lib.tsx, traced through prop into <Toast> in app.tsx → WRAP", async () => {
    const setup = buildContext({
      "/lib.tsx": `
        export const errorMsg = "Payment failed.";
      `,
      "/app.tsx": `
        import { errorMsg } from "./lib";
        export const App = () => <Toast message={errorMsg} />;
      `,
    });

    const results = await runAll(setup, {
      sinks: {
        components: [{ name: "Toast", uiProps: "all-children" }],
      },
    });

    const lib = results.find((r) => r.path === "/lib.tsx")!;
    const wrappedTexts = lib.result.wrapped.map((w) => w.node.text);
    expect(wrappedTexts).toContain("Payment failed.");

    // The wrapped node carries trace metadata describing the path.
    const wrappedNode = lib.result.wrapped.find(
      (w) => w.node.text === "Payment failed."
    )!.node;
    expect(wrappedNode.trace).toBeDefined();
    expect(wrappedNode.trace!.sink).toBe("component:Toast");
    expect(wrappedNode.trace!.depth).toBeGreaterThanOrEqual(2);
  });

  it("without the sink registered, the same string falls into Unresolved", async () => {
    // Use a custom component name that is NOT in the default registry; the
    // default config has `Toast` baked in, which would otherwise match.
    const setup = buildContext({
      "/lib.tsx": `export const errorMsg = "Payment failed.";`,
      "/app.tsx": `
        import { errorMsg } from "./lib";
        export const App = () => <Notifier message={errorMsg} />;
      `,
    });

    const results = await runAll(setup); // no config — `Notifier` is not registered
    const lib = results.find((r) => r.path === "/lib.tsx")!;
    const unresolvedTexts = lib.result.unresolved.map((n) => n.text);
    expect(unresolvedTexts).toContain("Payment failed.");

    const wrappedTexts = lib.result.wrapped.map((w) => w.node.text);
    expect(wrappedTexts).not.toContain("Payment failed.");
  });

  it("custom function sink can wrap an imported message", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const greeting = "Hello there.";`,
      "/app.tsx": `
        import { greeting } from "./lib";
        export function App() {
          notify(greeting);
          return null;
        }
      `,
    });

    const results = await runAll(setup, {
      sinks: { functions: [{ name: "notify", uiArgs: [0] }] },
    });

    const lib = results.find((r) => r.path === "/lib.tsx")!;
    const wrappedTexts = lib.result.wrapped.map((w) => w.node.text);
    expect(wrappedTexts).toContain("Hello there.");

    const node = lib.result.wrapped.find(
      (w) => w.node.text === "Hello there."
    )!.node;
    expect(node.trace!.sink).toBe("function:notify");
  });
});

describe("pipeline cross-file Pass 2 — boundaries", () => {
  it("escalated string with no outbound edges → Unresolved with exhausted dead-end", async () => {
    const setup = buildContext({
      // Declared at module top-level; ranks as Escalate but never used elsewhere.
      "/lib.tsx": `export const lonelyMsg = "Floats in the void.";`,
    });

    const results = await runAll(setup);
    const lib = results.find((r) => r.path === "/lib.tsx")!;
    const node = lib.result.unresolved.find(
      (n) => n.text === "Floats in the void."
    );
    expect(node).toBeDefined();
    expect(node!.trace?.path?.[0]).toMatch(/exhausted/);
  });

  it("legacy callers (no graphContext) still skip Pass 2 cleanly", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const msg = "Something happened.";`,
    });
    const config = resolveConfig({}, null);

    // No graphContext passed — Pass 2 should be skipped, Escalate → Unresolved.
    const result = await run("/lib.tsx", setup.files["/lib.tsx"], {
      dryRun: true,
      config,
    });
    const node = result.unresolved.find(
      (n) => n.text === "Something happened."
    );
    expect(node).toBeDefined();
    expect(node!.trace).toBeUndefined();
  });
});
