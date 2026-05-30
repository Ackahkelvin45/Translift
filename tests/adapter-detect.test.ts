import { describe, expect, it } from "vitest";
import { ReactAdapter } from "../src/adapters/react";

// `detect` decides which files the walker scans for extraction. It covers all
// JS/TS source (UI copy lives in plain `.ts` action/constant modules, not just
// JSX) but excludes type-only `.d.ts`.
describe("ReactAdapter.detect — scanned file types", () => {
  const adapter = new ReactAdapter();

  it("scans JSX and plain TS/JS source", () => {
    for (const f of ["a.tsx", "a.jsx", "a.ts", "a.js", "dir/b.ts"]) {
      expect(adapter.detect(f)).toBe(true);
    }
  });

  it("excludes type-only .d.ts declarations", () => {
    expect(adapter.detect("types.d.ts")).toBe(false);
    expect(adapter.detect("global.d.ts")).toBe(false);
  });

  it("ignores non-source files", () => {
    for (const f of ["a.css", "a.json", "a.md", "a.svg"]) {
      expect(adapter.detect(f)).toBe(false);
    }
  });
});
