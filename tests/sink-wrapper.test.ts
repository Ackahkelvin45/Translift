/**
 * F6 — wrapper / HOC shape-matching (Pass 2).
 *
 * `const StyledToast = styled(Toast)` used as `<StyledToast message={…}/>` has
 * a tag name (`StyledToast`) that no registry entry knows. F6 unwraps the
 * wrapper declaration, resolves the inner component (`Toast`), and re-matches
 * it against the registry — applying the inner entry's constraints and the
 * wrapper's own `uiProps` gating.
 *
 * Forms without a component argument (`forwardRef((p,ref) => …)`) intentionally
 * don't resolve — they need a manual registry entry.
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

function tracedSink(
  results: Array<{ path: string; result: PipelineResult }>,
  text: string
): string | null | undefined {
  const lib = results.find((r) => r.path === "/lib.tsx")!;
  return lib.result.wrapped.find((w) => w.node.text === text)?.node.trace?.sink;
}

const TOAST = `
  interface ToastProps { message: string; }
  export function Toast(props: ToastProps) { return null as any; }
`;

describe("F6 — wrapper / HOC matching", () => {
  it("resolves a single-layer wrapper to the registered inner component", async () => {
    const setup = buildContext({
      "/Toast.tsx": TOAST,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Toast } from "./Toast";
        import { msg } from "./lib";
        const styled = (c: any) => c;
        const StyledToast = styled(Toast);
        export const App = () => <StyledToast message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Toast", uiProps: "all-children" }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("wrap");
    // The trace records the *registered* sink, not the wrapper name.
    expect(tracedSink(results, "Payment failed completely.")).toBe("component:Toast");
  });

  it("applies the inner entry's uiProps gating to the wrapper", async () => {
    const base = {
      "/Modal.tsx": `
        interface ModalProps { title: string; body: string; }
        export function Modal(props: ModalProps) { return null as any; }
      `,
    };
    const wrapApp = (prop: string) => `
      import { Modal } from "./Modal";
      import { msg } from "./lib";
      const withTracking = (c: any) => c;
      const TrackedModal = withTracking(Modal);
      export const App = () => <TrackedModal ${prop}={msg} />;
    `;

    const onTitle = await runAll(
      buildContext({
        ...base,
        "/lib.tsx": `export const msg = "Payment failed completely.";`,
        "/app.tsx": wrapApp("title"),
      }),
      { sinks: { components: [{ name: "Modal", uiProps: ["title"] }] } }
    );
    expect(libVerdict(onTitle, "Payment failed completely.")).toBe("wrap");

    const onBody = await runAll(
      buildContext({
        ...base,
        "/lib.tsx": `export const msg = "Payment failed completely.";`,
        "/app.tsx": wrapApp("subtitleX"),
      }),
      { sinks: { components: [{ name: "Modal", uiProps: ["title"] }] } }
    );
    expect(libVerdict(onBody, "Payment failed completely.")).toBe("unresolved");
  });

  it("unwraps nested wrappers (a(b(Toast)))", async () => {
    const setup = buildContext({
      "/Toast.tsx": TOAST,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Toast } from "./Toast";
        import { msg } from "./lib";
        const memo = (c: any) => c;
        const styled = (c: any) => c;
        const Fancy = styled(memo(Toast));
        export const App = () => <Fancy message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Toast", uiProps: "all-children" }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("wrap");
  });

  it("unwraps curried HOCs (connect(...)(Toast))", async () => {
    const setup = buildContext({
      "/Toast.tsx": TOAST,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { Toast } from "./Toast";
        import { msg } from "./lib";
        const connect = (..._a: any[]) => (c: any) => c;
        const Connected = connect({}, {})(Toast);
        export const App = () => <Connected message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Toast", uiProps: "all-children" }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("wrap");
  });

  it("does not match a non-wrapper component", async () => {
    const setup = buildContext({
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { msg } from "./lib";
        const Plain = () => null;
        export const App = () => <Plain message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: { components: [{ name: "Toast", uiProps: "all-children" }] },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("unresolved");
  });

  it("honors importFrom on the wrapped (inner) component's origin", async () => {
    // Inner CustomToast (a name absent from the default registry) comes from a
    // local module; the entry requires a different importFrom, so the wrapper
    // must NOT match. Uses a non-default name so the appended-to-defaults Toast
    // entry can't match instead.
    const setup = buildContext({
      "/CustomToast.tsx": `
        interface CustomToastProps { message: string; }
        export function CustomToast(props: CustomToastProps) { return null as any; }
      `,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/app.tsx": `
        import { CustomToast } from "./CustomToast";
        import { msg } from "./lib";
        const styled = (c: any) => c;
        const StyledToast = styled(CustomToast);
        export const App = () => <StyledToast message={msg} />;
      `,
    });
    const results = await runAll(setup, {
      sinks: {
        components: [
          { name: "CustomToast", importFrom: "react-hot-toast", uiProps: "all-children" },
        ],
      },
    });
    expect(libVerdict(results, "Payment failed completely.")).toBe("unresolved");
  });
});
