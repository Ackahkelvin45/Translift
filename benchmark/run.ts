/**
 * Benchmark harness (next-steps #1).
 *
 * Answers "is the precision claim real?" with numbers, not vibes. Two parts:
 *
 *  1. Ground-truth scoring on a small, human-labeled fixture set
 *     (`benchmark/cases` + `benchmark/labels.json`). Every string is labeled
 *     wrap / skip by human judgment, independent of any tool. We then run
 *     TransLift and (if installed) i18next-cli `lint` over the same files and
 *     score each against the labels: true positives, false positives, and —
 *     the metric this whole project is about — SILENT misses (a UI string the
 *     tool neither wraps nor surfaces). TransLift's "unresolved" tier counts as
 *     a *surfaced* miss, not silent.
 *
 *  2. A scale/timing pass on a real repo (Excalidraw, if checked out locally)
 *     reporting raw counts + wall time — no ground truth there, just magnitude.
 *
 * Run: `npm run benchmark`. Pure-local part needs no network; the i18next-cli
 * comparison is skipped gracefully when the package isn't installed.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { walk } from "../src/walker";
import { buildProjectGraph } from "../src/graph-project";
import { run } from "../src/pipeline";
import { resolve as resolveConfig } from "../src/config";
import { Verdict } from "../src/types";

interface Label {
  text: string;
  expect: "wrap" | "skip";
  category: string;
}

interface ToolOutcome {
  /** "wrap" = decided to wrap; "surfaced" = flagged for review; "silent" = neither. */
  result: "wrap" | "surfaced" | "silent";
}

interface Scorecard {
  tool: string;
  tp: number; // expect wrap, wrapped
  fp: number; // expect skip, wrapped
  silentMiss: number; // expect wrap, neither wrapped nor surfaced
  surfacedMiss: number; // expect wrap, surfaced (TransLift "unresolved")
  correctSkip: number; // expect skip, not wrapped
  rows: { text: string; expect: string; category: string; got: string; ok: boolean }[];
}

const BENCH_DIR = __dirname;
const CASES_DIR = path.join(BENCH_DIR, "cases");

function loadLabels(): Label[] {
  const raw = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "labels.json"), "utf-8"));
  return raw.cases as Label[];
}

/* ----------------------------- TransLift ---------------------------------- */

async function transliftOutcomes(): Promise<Map<string, ToolOutcome>> {
  const { files, root } = walk(CASES_DIR);
  const config = resolveConfig({}, null);
  const graphContext = buildProjectGraph(root, files);
  const shared = new Set<string>();
  const byText = new Map<string, ToolOutcome>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const res = await run(file, content, { dryRun: true, usedKeys: shared, config, graphContext });
    for (const n of res.nodes) {
      const result: ToolOutcome["result"] =
        n.verdict === Verdict.Wrap
          ? "wrap"
          : n.verdict === Verdict.Unresolved || n.verdict === Verdict.Escalate || n.verdict === Verdict.FlagDynamic
            ? "surfaced"
            : "silent";
      // First occurrence wins; fixture texts are unique.
      if (!byText.has(n.text)) byText.set(n.text, { result });
    }
  }
  return byText;
}

/* ----------------------------- i18next-cli -------------------------------- */

function i18nextOutcomes(): Map<string, ToolOutcome> | null {
  const probe = spawnSync("npx", ["--no-install", "i18next-cli", "--version"], {
    cwd: CASES_DIR,
    encoding: "utf-8",
  });
  if (probe.status !== 0) return null; // not installed → skip gracefully

  const out = spawnSync("npx", ["--no-install", "i18next-cli", "lint"], {
    cwd: CASES_DIR,
    encoding: "utf-8",
  });
  const text = (out.stdout ?? "") + (out.stderr ?? "");
  // A linter only has two outcomes per string: flagged (≈ "wrap") or nothing
  // (silent). It has no "surfaced for review" tier.
  const flagged = new Set<string>();
  const re = /Found hardcoded string:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) flagged.add(m[1]);

  const byText = new Map<string, ToolOutcome>();
  for (const s of flagged) byText.set(s, { result: "wrap" });
  return byText;
}

/* ------------------------------- scoring ---------------------------------- */

function score(tool: string, labels: Label[], outcomes: Map<string, ToolOutcome>): Scorecard {
  const card: Scorecard = {
    tool,
    tp: 0,
    fp: 0,
    silentMiss: 0,
    surfacedMiss: 0,
    correctSkip: 0,
    rows: [],
  };
  for (const l of labels) {
    const got = outcomes.get(l.text)?.result ?? "silent";
    let ok = false;
    if (l.expect === "wrap") {
      if (got === "wrap") (card.tp++, (ok = true));
      else if (got === "surfaced") card.surfacedMiss++;
      else card.silentMiss++;
    } else {
      if (got === "wrap") card.fp++;
      else (card.correctSkip++, (ok = true));
    }
    card.rows.push({ text: l.text, expect: l.expect, category: l.category, got, ok });
  }
  return card;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

function summarize(card: Scorecard): string {
  const wraps = card.tp + card.surfacedMiss + card.silentMiss; // expect-wrap total
  const precisionDen = card.tp + card.fp;
  return [
    `**${card.tool}**`,
    `precision ${pct(card.tp, precisionDen)} (TP ${card.tp} / FP ${card.fp})`,
    `recall ${pct(card.tp, wraps)} (TP ${card.tp} / ${wraps})`,
    `**silent misses: ${card.silentMiss}**`,
    `surfaced-for-review: ${card.surfacedMiss}`,
  ].join(" · ");
}

/* ------------------------------- scale ------------------------------------ */

function scaleRun(): string {
  const repo = path.join(process.cwd(), "excalidraw", "packages", "excalidraw");
  if (!fs.existsSync(repo)) return "_Excalidraw checkout not present — skipped._";
  const t0 = Date.now();
  const out = spawnSync("npx", ["ts-node", "src/cli.ts", "extract", repo, "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const line = ((out.stdout ?? "") + (out.stderr ?? ""))
    .split("\n")
    .find((l) => l.includes("wrap · "));
  return `TransLift on Excalidraw (~240 files): \`${line?.trim() ?? "n/a"}\` in ${secs}s wall.`;
}

/* ------------------------------- report ----------------------------------- */

async function main() {
  const labels = loadLabels();
  const tl = score("TransLift", labels, await transliftOutcomes());
  const i18nOut = i18nextOutcomes();
  const i18n = i18nOut ? score("i18next-cli lint", labels, i18nOut) : null;

  const lines: string[] = [];
  lines.push("# TransLift benchmark");
  lines.push("");
  lines.push(`Ground-truth set: **${labels.length} labeled strings** in \`benchmark/cases\`.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- ${summarize(tl)}`);
  if (i18n) lines.push(`- ${summarize(i18n)}`);
  else lines.push("- _i18next-cli not installed — comparison skipped (`npm i -D i18next-cli`)._");
  lines.push("");

  // Per-string table.
  lines.push("## Per-string");
  lines.push("");
  const cols = i18n ? "| string | expect | TransLift | i18next-cli |" : "| string | expect | TransLift |";
  const sep = i18n ? "|---|---|---|---|" : "|---|---|---|";
  lines.push(cols);
  lines.push(sep);
  const i18nByText = new Map(i18n?.rows.map((r) => [r.text, r]) ?? []);
  for (const r of tl.rows) {
    const tlCell = `${r.got}${r.ok ? " ✓" : r.got === "silent" ? " ✗ silent" : " ⚠"}`;
    if (i18n) {
      const ir = i18nByText.get(r.text)!;
      const iCell = `${ir.got}${ir.ok ? " ✓" : ir.got === "silent" ? " ✗ silent" : " ⚠"}`;
      lines.push(`| ${trunc(r.text)} | ${r.expect} | ${tlCell} | ${iCell} |`);
    } else {
      lines.push(`| ${trunc(r.text)} | ${r.expect} | ${tlCell} |`);
    }
  }
  lines.push("");
  lines.push("## Scale");
  lines.push("");
  lines.push(scaleRun());
  lines.push("");

  const report = lines.join("\n");
  console.log(report);
  fs.writeFileSync(path.join(BENCH_DIR, "RESULTS.md"), report + "\n");
  console.log(`\n(written to benchmark/RESULTS.md)`);
}

function trunc(s: string, max = 40): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
