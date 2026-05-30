/**
 * F5a — component `uiProps` prop-gating in Pass 2.
 *
 * Before F5a, `uiProps` was declared in the registry but never enforced: any
 * string traced into a registered component via *any* prop was wrapped. F5a
 * makes the array form actually filter — a string only resolves when it
 * arrives via a listed prop. `"all-children"` keeps the old accept-any
 * behavior.
 *
 * These tests pin the gate end-to-end through `pipeline.run()` + Pass 2.
 */
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { run, PipelineResult } from "../src/pipeline";
import {
  ProjectGraphContext,
  buildProjectGraphFromProject,
} from "../src/graph-project";
import { resolve as resolveConfig, ResolvedConfig, TransliftConfig } from "../src/config";

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

/** Convenience: did `text` (declared in lib.tsx) end up wrapped vs. unresolved? */
function libVerdict(
  results: Array<{ path: string; result: PipelineResult }>,
  text: string
): "wrap" | "unresolved" | "other" {
  const lib = results.find((r) => r.path === "/lib.tsx")!;
  if (lib.result.wrapped.some((w) => w.node.text === text)) return "wrap";
  if (lib.result.unresolved.some((n) => n.text === text)) return "unresolved";
  return "other";
}

describe("F5a — uiProps array gating (Pass 2)", () => {
  it("wraps a string traced into a LISTED prop", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const heading = "Payment failed.";`,
      "/app.tsx": `
        import { heading } from "./lib";
        export const App = () => <Modal title={heading} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Modal", uiProps: ["title"] }] },
    });
    expect(libVerdict(results, "Payment failed.")).toBe("wrap");

    const wrapped = results
      .find((r) => r.path === "/lib.tsx")!
      .result.wrapped.find((w) => w.node.text === "Payment failed.")!;
    expect(wrapped.node.trace!.sink).toBe("component:Modal");
  });

  it("does NOT wrap a string traced into an UNLISTED prop", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const heading = "Payment failed.";`,
      "/app.tsx": `
        import { heading } from "./lib";
        export const App = () => <Modal subtitle={heading} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Modal", uiProps: ["title"] }] },
    });
    expect(libVerdict(results, "Payment failed.")).toBe("unresolved");
  });

  it("accepts any of several listed props", async () => {
    const setup = buildContext({
      "/lib.tsx": `
        export const a = "First message.";
        export const b = "Second message.";
      `,
      "/app.tsx": `
        import { a, b } from "./lib";
        export const App = () => <Dialog title={a} description={b} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Dialog", uiProps: ["title", "description"] }] },
    });
    expect(libVerdict(results, "First message.")).toBe("wrap");
    expect(libVerdict(results, "Second message.")).toBe("wrap");
  });

  it("'all-children' accepts an arbitrary prop (back-compat)", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const msg = "Anything goes here.";`,
      "/app.tsx": `
        import { msg } from "./lib";
        export const App = () => <Toast somethingUnusual={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Toast", uiProps: "all-children" }] },
    });
    expect(libVerdict(results, "Anything goes here.")).toBe("wrap");
  });

  it("unlisted prop on an 'all-children'-sibling does not leak across entries", async () => {
    // Modal (title-only) and Toast (all-children) both registered; a string
    // into Modal.subtitle must stay unresolved even though Toast would accept it.
    const setup = buildContext({
      "/lib.tsx": `export const heading = "Gated message.";`,
      "/app.tsx": `
        import { heading } from "./lib";
        export const App = () => <Modal subtitle={heading} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: {
        components: [
          { name: "Modal", uiProps: ["title"] },
          { name: "Toast", uiProps: "all-children" },
        ],
      },
    });
    expect(libVerdict(results, "Gated message.")).toBe("unresolved");
  });
});
