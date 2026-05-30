#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { run, PipelineResult } from "./pipeline";
import { walk } from "./walker";
import { loadConfig } from "./config";
import { buildProjectGraph } from "./graph-project";
import { findUnregisteredSinks, HubReport } from "./hub-analysis";
import { Verdict, UsedTranslationKey } from "./types";

type Catalog = Record<string, Record<string, string>>;

interface Conflict {
  key: string;
  existingValue: string;
  newValue: string;
  file: string;
  line: number;
  column: number;
}

interface DriftReport {
  root: string;
  isSingleFile: boolean;
  results: { file: string; result: PipelineResult }[];
  existingCatalog: Catalog;
  mergedCatalog: Catalog;
  conflicts: Conflict[];
  missing: UsedTranslationKey[];
  orphaned: string[];
  hubs: HubReport;
  hubMinHits: number;
}

const program = new Command();

program
  .name("translift")
  .description("Autonomous i18n extraction CLI");

program
  .command("extract <target>")
  .description("Extract UI strings, wrap in t(), and write en.json")
  .option("--dry-run", "Show what would change without writing to disk", false)
  .option("-v, --verbose", "Include full per-string signals report", false)
  .action(
    async (
      target: string,
      options: { dryRun: boolean; verbose: boolean }
    ) => {
      const report = await gather(target, options.dryRun);
      if (!report.results.length) {
        console.log(`No .tsx / .jsx files found under ${target}.`);
        return;
      }

      printReport(report, options.verbose);

      if (options.dryRun) {
        console.log(`\nDry-run — no files written.`);
        if (!options.verbose) {
          console.log(`(run with --verbose for full per-string signals)`);
        }
        return;
      }

      // Write each touched source file, plus a single merged en.json at root.
      let wroteSources = 0;
      for (const { file, result } of report.results) {
        if (result.modifiedContent && result.wrapped.length > 0) {
          fs.writeFileSync(file, result.modifiedContent);
          wroteSources++;
        }
      }

      const enPath = path.join(report.root, "en.json");
      const nextEn = JSON.stringify(report.mergedCatalog, null, 2);
      const prevEn = safeRead(enPath);
      if (nextEn !== prevEn) {
        fs.writeFileSync(enPath, nextEn);
        console.log(`\nWrote ${wroteSources} file(s) and ${rel(enPath)}`);
      } else if (wroteSources > 0) {
        console.log(`\nWrote ${wroteSources} file(s); ${rel(enPath)} unchanged`);
      } else {
        console.log(`\nNothing to write.`);
      }
    }
  );

program
  .command("audit <target>")
  .description("Read-only drift check: missing, orphaned, conflicts, unwrapped. Non-zero exit on actionable drift.")
  .option("-v, --verbose", "Include full per-string signals report", false)
  .option(
    "--strict",
    "Also fail on [traced] wraps (Pass 2 + weighted Pass 1). Default audit treats those as needing review, not drift.",
    false
  )
  .action(
    async (target: string, options: { verbose: boolean; strict: boolean }) => {
      const report = await gather(target, /* dryRun */ true);
      if (!report.results.length) {
        console.log(`No .tsx / .jsx files found under ${target}.`);
        return;
      }

      printReport(report, options.verbose);

      let directWraps = 0;
      let tracedWraps = 0;
      for (const { result } of report.results) {
        for (const r of result.wrapped) {
          if (isDirectSource(r.node.confidenceSource)) directWraps++;
          else tracedWraps++;
        }
      }

      const isDirty =
        report.conflicts.length > 0 ||
        report.missing.length > 0 ||
        report.orphaned.length > 0 ||
        directWraps > 0 ||
        (options.strict && tracedWraps > 0);

      console.log();
      if (isDirty) {
        console.log(`audit: drift detected.`);
        process.exitCode = 1;
      } else if (tracedWraps > 0) {
        console.log(
          `audit: clean (${tracedWraps} traced wrap${tracedWraps === 1 ? "" : "s"} need review — pass --strict to fail on them).`
        );
      } else {
        console.log(`audit: clean.`);
      }
    }
  );

program.parseAsync();

// ----------------------------------------------------------------------------
// Orchestration
// ----------------------------------------------------------------------------

async function gather(target: string, dryRun: boolean): Promise<DriftReport> {
  const absTarget = path.resolve(target);
  const isSingleFile = fs.statSync(absTarget).isFile();
  const { files, root } = walk(target);

  // Search for translift.config.* starting at the walk root (project root for
  // directory targets, file's parent for single-file invocations), walking up.
  const config = await loadConfig(root);
  if (config.sourcePath) {
    console.log(`config: ${rel(config.sourcePath)}`);
  }

  // One project graph per invocation. Built before any per-file pipeline runs,
  // because Pass 2 needs the full graph (a string declared in file A may flow
  // into a sink in file B). On larger projects this is the dominant CLI cost.
  const graphContext = buildProjectGraph(root, files);

  // Hub analysis runs over the same graph — purely report-only output that
  // surfaces likely UI sinks the user hasn't registered yet. We exclude any
  // configured translation callees (`t`, `i18n.t`, etc.) from the candidate
  // pool — they're the translation primitive, not unregistered sinks.
  const excludedFns = new Set(
    config.translationCallees.map((c) =>
      c.kind === "identifier" ? c.name : c.property
    )
  );
  const hubs = findUnregisteredSinks(
    graphContext.graph,
    config.registry,
    config.discovery.minHits,
    excludedFns
  );

  const sharedSlugSet = new Set<string>();
  const results: { file: string; result: PipelineResult }[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const result = await run(file, content, {
      dryRun,
      usedKeys: sharedSlugSet,
      config,
      graphContext,
    });
    results.push({ file, result });
  }

  const existingCatalog = loadExistingCatalog(root);
  const { mergedCatalog, conflicts } = mergeWithConflictTracking(
    existingCatalog,
    results
  );

  // Drift: pre-existing t() usages cross-checked against the merged catalog.
  const mergedKeySet = flattenCatalog(mergedCatalog);
  const allUsedTranslationKeys = results.flatMap(
    (r) => r.result.usedTranslationKeys
  );
  const missing = allUsedTranslationKeys.filter(
    (u) => !mergedKeySet.has(u.keyName)
  );

  // For orphans, include the keys we're about to add via extract — they'll be
  // used as soon as mutate runs, so they shouldn't be flagged as dead.
  const usedKeySet = new Set(allUsedTranslationKeys.map((u) => u.keyName));
  for (const { result } of results) {
    for (const r of result.wrapped) usedKeySet.add(r.keyName);
  }
  const orphaned = [...mergedKeySet].filter((k) => !usedKeySet.has(k)).sort();

  return {
    root,
    isSingleFile,
    results,
    existingCatalog,
    mergedCatalog,
    conflicts,
    missing,
    orphaned,
    hubs,
    hubMinHits: config.discovery.minHits,
  };
}

// ----------------------------------------------------------------------------
// Catalog helpers
// ----------------------------------------------------------------------------

function loadExistingCatalog(root: string): Catalog {
  const enPath = path.join(root, "en.json");
  if (!fs.existsSync(enPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(enPath, "utf-8"));
    if (parsed && typeof parsed === "object") return parsed as Catalog;
    return {};
  } catch {
    console.warn(`warn: ${rel(enPath)} is not valid JSON — treating as empty.`);
    return {};
  }
}

function flattenCatalog(c: Catalog): Set<string> {
  const out = new Set<string>();
  for (const [ns, slugs] of Object.entries(c)) {
    if (!slugs || typeof slugs !== "object") continue;
    for (const slug of Object.keys(slugs)) {
      out.add(`${ns}.${slug}`);
    }
  }
  return out;
}

function mergeWithConflictTracking(
  existing: Catalog,
  results: { file: string; result: PipelineResult }[]
): { mergedCatalog: Catalog; conflicts: Conflict[] } {
  // Start from a deep copy of existing so untouched keys (other files,
  // prior runs) survive intact.
  const merged: Catalog = {};
  for (const [ns, slugs] of Object.entries(existing)) {
    if (slugs && typeof slugs === "object") merged[ns] = { ...slugs };
  }

  const conflicts: Conflict[] = [];

  for (const { result } of results) {
    for (const r of result.wrapped) {
      const dot = r.keyName.indexOf(".");
      const ns = r.keyName.slice(0, dot);
      const slug = r.keyName.slice(dot + 1);
      const incoming = r.node.text;
      const existingValue = merged[ns]?.[slug];

      if (existingValue === undefined) {
        if (!merged[ns]) merged[ns] = {};
        merged[ns][slug] = incoming;
      } else if (existingValue !== incoming) {
        // Existing wins — preserve the human edit, record the divergence.
        conflicts.push({
          key: r.keyName,
          existingValue,
          newValue: incoming,
          file: r.node.file,
          line: r.node.line,
          column: r.node.column,
        });
      }
    }
  }

  return { mergedCatalog: merged, conflicts };
}

// ----------------------------------------------------------------------------
// Reporting
// ----------------------------------------------------------------------------

function printReport(report: DriftReport, verbose: boolean) {
  const { results, root, isSingleFile, conflicts, missing, orphaned, hubs, hubMinHits } = report;

  const totals = {
    wrap: 0,
    skip: 0,
    dynamic: 0,
    unresolved: 0,
  };
  for (const { result } of results) {
    totals.wrap += result.wrapped.length;
    totals.skip += result.nodes.filter((n) => n.verdict === Verdict.Skip).length;
    totals.dynamic += result.flaggedDynamic.length;
    totals.unresolved += result.unresolved.length;
  }

  console.log(
    `\nTransLift — ${rel(root)} (${results.length} file${results.length === 1 ? "" : "s"})`
  );
  console.log(
    `${totals.wrap} wrap · ${totals.skip} skip · ${totals.dynamic} dynamic · ${totals.unresolved} unresolved · ${conflicts.length} conflict · ${missing.length} missing · ${orphaned.length} orphan`
  );

  // Per-file detail is verbose-only. Default keeps the report scannable on
  // large projects (240-file Excalidraw runs were hundreds of lines).
  if (verbose) {
    for (const { file, result } of results) {
      if (
        result.wrapped.length === 0 &&
        result.flaggedDynamic.length === 0 &&
        result.unresolved.length === 0
      )
        continue;

      console.log(`\n${rel(file)}`);

      if (result.wrapped.length > 0) {
        console.log(`  wrap:`);
        for (const r of capped(result.wrapped)) {
          const loc = `:${r.node.line}`.padEnd(6);
          const key = r.keyName.padEnd(38);
          const text = JSON.stringify(r.node.text);
          console.log(`    ${loc} ${key} ${text}${tagFor(r.node)}`);
          if (r.node.trace) {
            for (const step of r.node.trace.path) {
              console.log(`           └─ ${step}`);
            }
            if (r.node.trace.sink) {
              const [kind, name] = r.node.trace.sink.split(":");
              console.log(
                `           └─ ${name} registered as sink (config: ${kind}s)`
              );
            }
          }
        }
        printOverflow(result.wrapped.length, "more wrap");
      }
      if (result.flaggedDynamic.length > 0) {
        console.log(`  dynamic (needs review):`);
        for (const n of capped(result.flaggedDynamic)) {
          console.log(`    :${n.line}  ${JSON.stringify(n.text)}`);
        }
        printOverflow(result.flaggedDynamic.length, "more dynamic");
      }
      if (result.unresolved.length > 0) {
        console.log(`  unresolved (needs review):`);
        for (const n of capped(result.unresolved)) {
          console.log(
            `    :${n.line}  ${JSON.stringify(n.text)}  (confidence ${n.confidence.toFixed(2)})`
          );
        }
        printOverflow(result.unresolved.length, "more unresolved");
      }
    }
  } else if (totals.wrap + totals.dynamic + totals.unresolved > 0) {
    console.log(`(run with --verbose to see per-file details)`);
  }

  if (conflicts.length > 0) {
    console.log(`\nConflicts (existing en.json values preserved):`);
    const v = sliceSection(conflicts, verbose);
    for (const c of v.shown) {
      console.log(
        `  ${c.key}  ${JSON.stringify(c.existingValue)} ≠ ${JSON.stringify(c.newValue)}  (${rel(c.file)}:${c.line}:${c.column})`
      );
    }
    printSectionOverflow(v.overflow);
  }

  if (missing.length > 0) {
    console.log(`\nMissing keys (used in source, absent from en.json):`);
    const v = sliceSection(missing, verbose);
    for (const u of v.shown) {
      console.log(`  ${u.keyName}  (${rel(u.file)}:${u.line}:${u.column})`);
    }
    printSectionOverflow(v.overflow);
  }

  if (orphaned.length > 0) {
    console.log(`\nOrphaned keys (in en.json, not used in source):`);
    if (isSingleFile) {
      console.log(
        `  warning: orphaned key detection is only reliable when run against the project root,`
      );
      console.log(
        `           since keys may be used in files outside this scan.`
      );
    }
    const v = sliceSection(orphaned, verbose);
    for (const k of v.shown) console.log(`  ${k}`);
    printSectionOverflow(v.overflow);
  }

  if (hubs.functions.length > 0 || hubs.components.length > 0) {
    console.log(
      `\nPossible unregistered sinks (≥ ${hubMinHits} string-bearing hits):`
    );
    const f = sliceSection(hubs.functions, verbose);
    for (const fn of f.shown) {
      console.log(`  function ${fn.name}  (${fn.hits} hits)`);
      for (const s of fn.samples) console.log(`    ${rel(s.file)}:${s.line}`);
    }
    printSectionOverflow(f.overflow, "more functions");
    const c = sliceSection(hubs.components, verbose);
    for (const cp of c.shown) {
      console.log(`  component <${cp.name}>  (${cp.hits} hits)`);
      for (const s of cp.samples) console.log(`    ${rel(s.file)}:${s.line}`);
    }
    printSectionOverflow(c.overflow, "more components");
  }

  if (verbose) {
    console.log(`\n--- Full report (every string + signals) ---`);
    for (const { file, result } of results) {
      console.log(`\n# ${rel(file)}`);
      console.log(JSON.stringify(result.nodes, null, 2));
    }
  }
}

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------

function rel(p: string): string {
  return path.relative(process.cwd(), p) || p;
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Per-file cap (wrap/dynamic/unresolved lists inside one file in --verbose). */
const PER_SECTION_CAP = 5;
/** Project-wide cap for default (non-verbose) mode. --verbose shows all. */
const GLOBAL_SECTION_CAP = 10;

function capped<T>(items: T[]): T[] {
  return items.slice(0, PER_SECTION_CAP);
}

function printOverflow(total: number, label: string): void {
  const overflow = total - PER_SECTION_CAP;
  if (overflow > 0) {
    console.log(`    ... and ${overflow} ${label}`);
  }
}

function sliceSection<T>(
  items: T[],
  verbose: boolean
): { shown: T[]; overflow: number } {
  if (verbose) return { shown: items, overflow: 0 };
  const shown = items.slice(0, GLOBAL_SECTION_CAP);
  return { shown, overflow: items.length - shown.length };
}

function printSectionOverflow(overflow: number, label: string = "more"): void {
  if (overflow > 0) {
    console.log(`  ... and ${overflow} ${label} (--verbose to see all)`);
  }
}

function isDirectSource(
  source: import("./types").ConfidenceSource | undefined
): boolean {
  return (
    source === "jsx-text" ||
    source === "attribute-sink" ||
    source === "function-sink"
  );
}

function tagFor(node: import("./types").StringNode): string {
  const src = node.confidenceSource;
  if (!src) return " [direct]"; // defensive — every wrap should have a source
  if (isDirectSource(src)) return " [direct]";
  if (src === "traced" && node.trace) {
    return ` [traced, depth ${node.trace.depth}]`;
  }
  // `weighted` (Pass 1 weighted-score wrap) — tagged [traced] per spec, no depth.
  return " [traced]";
}
