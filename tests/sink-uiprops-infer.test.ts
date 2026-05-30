/**
 * F5b — type-driven `uiProps` inference (Pass 2).
 *
 * When a component sink omits `uiProps`, the effective prop list is inferred
 * from the component's TypeScript type: string-typed props that pass the
 * UI-prop blocklist. Manual `uiProps` stays an override; `inferUiProps: false`
 * disables inference; unresolved types degrade gracefully to "no match".
 *
 * Components are declared + typed in-project so the TypeChecker can resolve
 * their prop shapes (mirrors the F4 smoke-test setup).
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

function libVerdict(
  results: Array<{ path: string; result: PipelineResult }>,
  text: string
): "wrap" | "unresolved" | "other" {
  const lib = results.find((r) => r.path === "/lib.tsx")!;
  if (lib.result.wrapped.some((w) => w.node.text === text)) return "wrap";
  if (lib.result.unresolved.some((n) => n.text === text)) return "unresolved";
  return "other";
}

const BANNER = `
  interface BannerProps {
    message: string;
    subtitle?: string;
    id: string;
    className?: string;
    onClick?: () => void;
  }
  export function Banner(props: BannerProps) { return null as any; }
`;

describe("F5b — uiProps inference", () => {
  it("infers a string-typed prop as a sink (no uiProps declared)", async () => {
    const setup = buildContext({
      "/Banner.tsx": BANNER,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Banner } from "./Banner";
        import { msg } from "./lib";
        export const App = () => <Banner message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Banner" }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("wrap");

    const wrapped = results
      .find((r) => r.path === "/lib.tsx")!
      .result.wrapped.find((w) => w.node.text === "Payment failed completely.")!;
    expect(wrapped.node.trace!.sink).toBe("component:Banner");
  });

  it("excludes blocklisted string props (id, className) from inference", async () => {
    const setup = buildContext({
      "/Banner.tsx": BANNER,
      "/lib.tsx": `export const ident = "Some descriptive label here.";`,
      "/app.tsx": `
        import { Banner } from "./Banner";
        import { ident } from "./lib";
        export const App = () => <Banner id={ident} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Banner" }] },
    });
    expect(libVerdict(results, "Some descriptive label here.")).toBe("unresolved");
  });

  it("inferUiProps:false disables inference (entry matches no prop)", async () => {
    const setup = buildContext({
      "/Banner.tsx": BANNER,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Banner } from "./Banner";
        import { msg } from "./lib";
        export const App = () => <Banner message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Banner", inferUiProps: false }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("unresolved");
  });

  it("explicit uiProps overrides inference (message excluded when not listed)", async () => {
    const setup = buildContext({
      "/Banner.tsx": BANNER,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Banner } from "./Banner";
        import { msg } from "./lib";
        export const App = () => <Banner message={msg} />;
      `,
    });
    // 'message' would be inferred, but the explicit list only allows 'subtitle'.
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Banner", uiProps: ["subtitle"] }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("unresolved");
  });

  it("degrades gracefully on an untyped component (props: any)", async () => {
    const setup = buildContext({
      "/Untyped.tsx": `export function Untyped(props) { return null; }`,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Untyped } from "./Untyped";
        import { msg } from "./lib";
        export const App = () => <Untyped message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Untyped" }] },
    });
    // No types → inference returns undefined → no wrap, no crash.
    expect(libVerdict(results, "Payment failed completely.")).toBe("unresolved");
  });
});
