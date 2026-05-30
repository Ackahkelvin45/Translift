import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, resolve } from "../src/config";
import { run } from "../src/pipeline";
import { DEFAULT_REGISTRY } from "../src/registry";

const NOTIFY_SRC = `
import * as React from "react";
export function App() {
  const onClick = () => notify("Saved successfully");
  return <button onClick={onClick}>Save</button>;
}
`;

const TOAST_SRC = `
import * as React from "react";
import { toast } from "react-hot-toast";
export function App() {
  const onClick = () => toast("Saved successfully");
  return <button onClick={onClick}>Save</button>;
}
`;

describe("resolve() — merge semantics", () => {
  it("undefined keeps defaults across every sink array", () => {
    const c = resolve({}, null);
    expect(c.registry.functions).toEqual(DEFAULT_REGISTRY.functions);
    expect(c.registry.components).toEqual(DEFAULT_REGISTRY.components);
    expect(c.registry.attributes).toEqual(DEFAULT_REGISTRY.attributes);
  });

  it("user functions append after defaults", () => {
    const c = resolve(
      { sinks: { functions: [{ name: "notify", uiArgs: [0] }] } },
      null
    );
    expect(c.registry.functions).toEqual([
      ...DEFAULT_REGISTRY.functions,
      { name: "notify", uiArgs: [0] },
    ]);
    expect(c.registry.components).toEqual(DEFAULT_REGISTRY.components);
  });

  it("empty array clears defaults for that sink type only", () => {
    const c = resolve({ sinks: { functions: [] } }, null);
    expect(c.registry.functions).toEqual([]);
    expect(c.registry.components).toEqual(DEFAULT_REGISTRY.components);
    expect(c.registry.attributes).toEqual(DEFAULT_REGISTRY.attributes);
  });

  it("threshold / pass2 / discovery overrides fall through with sensible defaults", () => {
    const c = resolve(
      {
        thresholds: { wrap: 0.9 },
        pass2: { maxDepth: 3 },
        discovery: { minHits: 10 },
      },
      null
    );
    expect(c.thresholds).toEqual({ wrap: 0.9, escalate: 0.25 });
    expect(c.pass2.maxDepth).toBe(3);
    expect(c.discovery.minHits).toBe(10);
  });
});

describe("pipeline picks up the merged registry", () => {
  it("custom function sink wraps notify('...')", async () => {
    const config = resolve(
      { sinks: { functions: [{ name: "notify", uiArgs: [0] }] } },
      null
    );
    const result = await run("/virtual/App.tsx", NOTIFY_SRC, {
      dryRun: true,
      config,
    });
    expect(result.wrapped.map((r) => r.node.text)).toContain(
      "Saved successfully"
    );
  });

  it("without config, notify('...') falls into unresolved", async () => {
    const result = await run("/virtual/App.tsx", NOTIFY_SRC, { dryRun: true });
    expect(result.wrapped.map((r) => r.node.text)).not.toContain(
      "Saved successfully"
    );
    expect(result.unresolved.map((n) => n.text)).toContain(
      "Saved successfully"
    );
  });

  it("default toast sink wraps toast('...') when defaults are intact", async () => {
    const result = await run("/virtual/App.tsx", TOAST_SRC, { dryRun: true });
    expect(result.wrapped.map((r) => r.node.text)).toContain(
      "Saved successfully"
    );
  });

  it("functions: [] kills the default toast sink", async () => {
    const config = resolve({ sinks: { functions: [] } }, null);
    const result = await run("/virtual/App.tsx", TOAST_SRC, {
      dryRun: true,
      config,
    });
    expect(result.wrapped.map((r) => r.node.text)).not.toContain(
      "Saved successfully"
    );
  });
});

describe("loadConfig() — filesystem", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "translift-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file is present", async () => {
    const c = await loadConfig(dir);
    expect(c.sourcePath).toBeNull();
    expect(c.registry.functions).toEqual(DEFAULT_REGISTRY.functions);
  });

  it("loads a JSON config", async () => {
    const cfgPath = path.join(dir, "translift.config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        sinks: { functions: [{ name: "notify", uiArgs: [0] }] },
      })
    );
    const c = await loadConfig(dir);
    expect(c.sourcePath).toBe(cfgPath);
    expect(c.registry.functions.some((f) => f.name === "notify")).toBe(true);
  });

  it("loads a TS config via jiti", async () => {
    const cfgPath = path.join(dir, "translift.config.ts");
    fs.writeFileSync(
      cfgPath,
      `export default { sinks: { functions: [{ name: "notify", uiArgs: [0] }] } };`
    );
    const c = await loadConfig(dir);
    expect(c.sourcePath).toBe(cfgPath);
    expect(c.registry.functions.some((f) => f.name === "notify")).toBe(true);
  });

  it("walks up the directory tree to find a config", async () => {
    const cfgPath = path.join(dir, "translift.config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({}));
    const nested = path.join(dir, "src", "components");
    fs.mkdirSync(nested, { recursive: true });
    const c = await loadConfig(nested);
    expect(c.sourcePath).toBe(cfgPath);
  });
});
