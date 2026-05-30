/**
 * RN recall scorer (roadmap N1). Runs TransLift over the un-translated RN slice
 * (see rn-untranslate.ts) and scores recall against the reconstructed ground
 * truth. Lives in benchmark/ so the ../src imports resolve like the other harness
 * scripts. Usage: ts-node benchmark/rn-recall.ts <outDir>
 */
import * as fs from "fs";
import * as path from "path";
import { walk } from "../src/walker";
import { buildProjectGraph } from "../src/graph-project";
import { run } from "../src/pipeline";
import { resolve as resolveConfig } from "../src/config";
import { Verdict } from "../src/types";

async function main() {
  const root = path.resolve(process.argv[2] ?? "/tmp/rn_out");
  const truth: string[] = JSON.parse(
    fs.readFileSync(path.join(root, "ground-truth.json"), "utf-8")
  );
  const { files } = walk(root);
  const config = resolveConfig({}, null);
  const graph = buildProjectGraph(root, files);
  const shared = new Set<string>();
  const rank: Record<string, number> = { wrap: 3, surfaced: 2, silent: 1 };
  const byText = new Map<string, string>();
  for (const f of files) {
    if (f.endsWith("ground-truth.json")) continue;
    const content = fs.readFileSync(f, "utf-8");
    const res = await run(f, content, {
      dryRun: true,
      usedKeys: shared,
      config,
      graphContext: graph,
    });
    for (const n of res.nodes) {
      const r =
        n.verdict === Verdict.Wrap
          ? "wrap"
          : n.verdict === Verdict.Unresolved ||
              n.verdict === Verdict.Escalate ||
              n.verdict === Verdict.FlagDynamic
            ? "surfaced"
            : "silent";
      const k = n.text.trim().toLowerCase();
      const prev = byText.get(k);
      if (!prev || rank[r] > rank[prev]) byText.set(k, r);
    }
  }
  let wrap = 0;
  let surfaced = 0;
  const misses: string[] = [];
  for (const t of truth) {
    const g = byText.get(t.trim().toLowerCase()) ?? "silent";
    if (g === "wrap") wrap++;
    else if (g === "surfaced") surfaced++;
    else misses.push(t);
  }
  const out = [
    `RN_GROUND_TRUTH=${truth.length}`,
    `RN_RECALL_WRAP=${wrap}`,
    `RN_SURFACED=${surfaced}`,
    `RN_SILENT_MISS=${misses.length}`,
    `RN_RECALL_PCT=${Math.round((100 * wrap) / truth.length)}`,
  ].join("\n");
  fs.writeFileSync(
    "/tmp/rn_score.txt",
    out + "\n\nMISSES:\n" + misses.map((m) => "- " + m).join("\n") + "\n"
  );
  console.log(out);
}

main();
