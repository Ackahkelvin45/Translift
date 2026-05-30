import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several integration tests spawn the real CLI (`npx ts-node src/cli.ts …`)
    // or build a full ts-morph project graph. The cold start of the first such
    // test routinely exceeds vitest's default 5s under CI/CPU contention — the
    // source of the audit-strict timeout flake. 30s gives ample headroom
    // without masking a genuine hang.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
