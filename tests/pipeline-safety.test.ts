/**
 * Sub-step 3i — per-file exception safety (acceptance #10).
 *
 * Verifies that an unparseable input doesn't crash the run: pipeline.run()
 * catches the error, writes a warning to stderr, and returns an empty
 * PipelineResult so the caller's per-file loop keeps going.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/pipeline";

describe("pipeline.run — per-file exception safety", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("syntax-broken source does not throw", async () => {
    const broken = "const x = ";
    await expect(
      run("/broken.tsx", broken, { dryRun: true })
    ).resolves.toBeDefined();
  });

  it("syntax-broken source returns empty result", async () => {
    const result = await run("/broken.tsx", "const x = ", { dryRun: true });
    expect(result.nodes).toEqual([]);
    expect(result.wrapped).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.flaggedDynamic).toEqual([]);
    expect(result.usedTranslationKeys).toEqual([]);
    expect(result.modifiedContent).toBeNull();
  });

  it("emits a warn line to stderr that names the file", async () => {
    await run("/broken.tsx", "const x = ", { dryRun: true });
    expect(stderrSpy).toHaveBeenCalled();
    const call = stderrSpy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/warn/i);
    expect(call).toMatch(/broken\.tsx/);
  });

  it("good file processed normally on next call (state isolation)", async () => {
    // One broken call must not leave the adapter in a weird state.
    await run("/broken.tsx", "const x = ", { dryRun: true });
    const result = await run(
      "/good.tsx",
      `const App = () => <h1>Hello world</h1>;`,
      { dryRun: true }
    );
    expect(result.nodes.length).toBeGreaterThan(0);
    const hello = result.wrapped.find((w) => w.node.text === "Hello world");
    expect(hello).toBeDefined();
  });
});
