/**
 * F2 — `CallExpressionIndex` + `findCallNodeNearLine` helper.
 *
 * The index is the bridge Pass 1 (F3) will use to look up the graph's
 * call-expression node corresponding to a Babel `inFunctionSink` signal.
 * These tests pin the bucketing and disambiguation semantics so F3 can
 * write against a stable contract.
 */
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import {
  buildCallExpressionIndex,
  buildProjectGraphFromProject,
  callExpressionKey,
  findCallNodeNearLine,
} from "../src/graph-project";

function mkProject(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

describe("buildCallExpressionIndex", () => {
  it("buckets calls by (file, calleeName)", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({
        "/a.tsx": `
          notify("first");
          notify("second");
          log("noise");
        `,
      })
    );
    const notifyBucket = ctx.callIndex.get(callExpressionKey("/a.tsx", "notify"));
    expect(notifyBucket).toBeDefined();
    expect(notifyBucket!).toHaveLength(2);

    const logBucket = ctx.callIndex.get(callExpressionKey("/a.tsx", "log"));
    expect(logBucket).toHaveLength(1);
  });

  it("keeps calls from different files in different buckets", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({
        "/a.tsx": `notify("x");`,
        "/b.tsx": `notify("y");`,
      })
    );
    expect(ctx.callIndex.get(callExpressionKey("/a.tsx", "notify"))).toHaveLength(1);
    expect(ctx.callIndex.get(callExpressionKey("/b.tsx", "notify"))).toHaveLength(1);
    expect(ctx.callIndex.get(callExpressionKey("/c.tsx", "notify"))).toBeUndefined();
  });

  it("skips calls with no resolvable callee name (computed callees)", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({
        "/a.tsx": `
          const fns = { run: () => null };
          fns["run"]();
        `,
      })
    );
    // The computed-call should not appear in the index — its calleeName is null.
    for (const bucket of ctx.callIndex.values()) {
      for (const c of bucket) {
        expect(c.calleeName).not.toBeNull();
      }
    }
  });
});

describe("findCallNodeNearLine — disambiguation", () => {
  it("returns the only call when only one matches", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({ "/a.tsx": `notify("hi");` })
    );
    const c = findCallNodeNearLine(ctx.callIndex, "/a.tsx", "notify", 1);
    expect(c).toBeDefined();
    expect(c!.calleeName).toBe("notify");
  });

  it("returns the nearest preceding call when multiple share a callee", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({
        "/a.tsx":
          `notify("first");\n` + // line 1
          `notify("second");\n` + // line 2
          `notify("third");\n`, // line 3
      })
    );
    // String on line 2 should bind to the call on line 2, not line 1.
    const c = findCallNodeNearLine(ctx.callIndex, "/a.tsx", "notify", 2);
    expect(c).toBeDefined();
    expect(c!.line).toBe(2);
  });

  it("returns undefined when no call precedes the string's line", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({ "/a.tsx": `notify("hi");` })
    );
    // Requesting a line BEFORE the only call's line.
    const c = findCallNodeNearLine(ctx.callIndex, "/a.tsx", "notify", 0);
    expect(c).toBeUndefined();
  });

  it("returns undefined when no call with the given name exists", () => {
    const ctx = buildProjectGraphFromProject(
      mkProject({ "/a.tsx": `notify("hi");` })
    );
    expect(
      findCallNodeNearLine(ctx.callIndex, "/a.tsx", "showError", 10)
    ).toBeUndefined();
  });
});

describe("buildCallExpressionIndex — standalone (used by ProjectGraphContext)", () => {
  it("equivalent to what buildProjectGraphFromProject builds", () => {
    const project = mkProject({
      "/a.tsx": `notify("a"); showError("b");`,
    });
    const ctx = buildProjectGraphFromProject(project);
    const standalone = buildCallExpressionIndex(ctx.graph);
    expect([...standalone.keys()].sort()).toEqual([...ctx.callIndex.keys()].sort());
  });
});
