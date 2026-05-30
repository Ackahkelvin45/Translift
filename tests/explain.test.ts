/**
 * #5 `explain` + #6 trace-path visual.
 *
 * `explainNode` is the shared decision-extractor; `renderExplanationText` and
 * `renderTraceDiagram` are its renderers. These tests drive it with real
 * pipeline output (nodes carrying verdict / source / signals / trace) so the
 * explanation can never disagree with what the tool actually decided.
 */
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { run } from "../src/pipeline";
import { buildProjectGraphFromProject } from "../src/graph-project";
import { resolve as resolveConfig, ResolvedConfig } from "../src/config";
import { StringNode } from "../src/types";
import {
  explainNode,
  renderExplanationText,
  renderTraceDiagram,
} from "../src/explain";

async function nodesFor(
  files: Record<string, string>
): Promise<{ nodes: StringNode[]; config: ResolvedConfig }> {
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
  const ctx = buildProjectGraphFromProject(project);
  const config = resolveConfig({}, null);
  const all: StringNode[] = [];
  const shared = new Set<string>();
  for (const [p, c] of Object.entries(files)) {
    const r = await run(p, c, { dryRun: true, usedKeys: shared, config, graphContext: ctx });
    all.push(...r.nodes);
  }
  return { nodes: all, config };
}

const find = (nodes: StringNode[], text: string) =>
  nodes.find((n) => n.text === text)!;

describe("explainNode — traced wrap (with #6 diagram)", () => {
  it("explains a cross-file string traced into a component sink", async () => {
    const { nodes, config } = await nodesFor({
      "/lib.tsx": `export const errorMsg = "Payment failed completely.";`,
      "/App.tsx": `
        import { errorMsg } from "./lib";
        export const App = () => <Toast message={errorMsg} />;
      `,
    });
    const exp = explainNode(find(nodes, "Payment failed completely."), config.registry);

    expect(exp.verdict).toBe("wrap");
    expect(exp.reasons.join(" ")).toMatch(/traced through the project graph/);
    expect(exp.trace?.sink).toBe("component:Toast");
    expect(exp.trace!.depth).toBeGreaterThanOrEqual(2);

    const diagram = renderTraceDiagram(exp);
    expect(diagram).toMatch(/passed as prop 'message' to <Toast>/);
    expect(diagram).toMatch(/✅ sink: component:Toast/);
  });

  it("surfaces wrapper (HOC) matches in the explanation", async () => {
    const { nodes, config } = await nodesFor({
      "/Toast.tsx": `
        interface ToastProps { message: string; }
        export function Toast(p: ToastProps) { return null as any; }
      `,
      "/lib.tsx": `export const msg = "Payment failed completely.";`,
      "/App.tsx": `
        import { Toast } from "./Toast";
        import { msg } from "./lib";
        const styled = (c: any) => c;
        const StyledToast = styled(Toast);
        export const App = () => <StyledToast message={msg} />;
      `,
    });
    const exp = explainNode(find(nodes, "Payment failed completely."), config.registry);
    expect(exp.verdict).toBe("wrap");
    expect(exp.trace?.viaWrapper).toBe("StyledToast");
    expect(exp.reasons.join(" ")).toMatch(/unwrapping wrapper "StyledToast"/);
    expect(renderTraceDiagram(exp)).toMatch(/via wrapper "StyledToast"/);
  });
});

describe("explainNode — non-wrap verdicts", () => {
  it("explains a console.* skip with the decisive reason and no weighted noise", async () => {
    const { nodes, config } = await nodesFor({
      "/a.tsx": `export function f() { console.log("Could not connect to the server."); }`,
    });
    const exp = explainNode(find(nodes, "Could not connect to the server."), config.registry);
    expect(exp.verdict).toBe("skip");
    expect(exp.reasons.join(" ")).toMatch(/console/);
    expect(exp.weighted).toBeUndefined(); // hard skip — no weighted breakdown
  });

  it("explains an escalated-then-unresolved string with the weighted breakdown", async () => {
    const { nodes, config } = await nodesFor({
      "/a.tsx": `export const lonely = "Some floating message here.";`,
    });
    const exp = explainNode(find(nodes, "Some floating message here."), config.registry);
    expect(exp.verdict).toBe("unresolved");
    expect(exp.reasons.join(" ")).toMatch(/Pass 2 found no registered sink/);
    expect(exp.weighted).toBeDefined();
    expect(exp.weighted!.terms.length).toBeGreaterThan(0);
    // The text report renders the breakdown and the dead-end trace.
    const text = renderExplanationText(exp);
    expect(text).toMatch(/weighted score:/);
    expect(text).toMatch(/exhausted: dead-end/);
  });
});
