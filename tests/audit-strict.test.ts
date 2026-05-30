/**
 * Sub-step 3g — `audit --strict` exit-code semantics.
 *
 * Invokes the real CLI via subprocess so we exercise the exact argparse +
 * exit-code path users see. Uses a temp fixture: a cross-file trace where
 * Pass 2 produces a `[traced]` wrap and `t("...")` already exists in the
 * source so the catalog is otherwise clean.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let TMP: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "translift-audit-strict-"));

  // /lib.tsx declares a string at module scope — Pass 1 will Escalate it.
  fs.writeFileSync(
    path.join(TMP, "lib.tsx"),
    `export const errorMsg = "Payment failed.";\n`
  );

  // /app.tsx uses it as a prop on <Toast> (a default-registered component sink),
  // so Pass 2 will trace it and tag the wrap [traced].
  fs.writeFileSync(
    path.join(TMP, "App.tsx"),
    [
      `import * as React from "react";`,
      `import { errorMsg } from "./lib";`,
      ``,
      `export const App = () => <Toast message={errorMsg} />;`,
      ``,
    ].join("\n")
  );
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function runAudit(args: string[]): { code: number; stdout: string } {
  const cliPath = path.resolve(__dirname, "..", "src", "cli.ts");
  const out = spawnSync(
    "npx",
    ["ts-node", cliPath, "audit", TMP, ...args],
    { encoding: "utf-8" }
  );
  return { code: out.status ?? -1, stdout: (out.stdout ?? "") + (out.stderr ?? "") };
}

describe("audit --strict", () => {
  it("default audit treats [traced] wraps as needing review, not drift → exit 0", () => {
    const { code, stdout } = runAudit([]);
    expect(stdout).toMatch(/audit: clean/);
    expect(stdout).toMatch(/traced wrap.*need review.*--strict/);
    expect(code).toBe(0);
  });

  it("--strict treats [traced] wraps as drift → exit 1", () => {
    const { code, stdout } = runAudit(["--strict"]);
    expect(stdout).toMatch(/audit: drift detected/);
    expect(code).toBe(1);
  });
});
