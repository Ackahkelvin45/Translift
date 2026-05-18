#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { run, PipelineResult } from "./pipeline";
import { walk } from "./walker";
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
  .action(async (target: string, options: { verbose: boolean }) => {
    const report = await gather(target, /* dryRun */ true);
    if (!report.results.length) {
      console.log(`No .tsx / .jsx files found under ${target}.`);
      return;
    }

    printReport(report, options.verbose);

    const wouldWrapCount = report.results.reduce(
      (n, r) => n + r.result.wrapped.length,
      0
    );

    const isDirty =
      report.conflicts.length > 0 ||
      report.missing.length > 0 ||
      report.orphaned.length > 0 ||
      wouldWrapCount > 0;

    console.log();
    if (isDirty) {
      console.log(`audit: drift detected.`);
      process.exitCode = 1;
    } else {
      console.log(`audit: clean.`);
    }
  });

program.parseAsync();

// ----------------------------------------------------------------------------
// Orchestration
// ----------------------------------------------------------------------------

async function gather(target: string, dryRun: boolean): Promise<DriftReport> {
  const absTarget = path.resolve(target);
  const isSingleFile = fs.statSync(absTarget).isFile();
  const { files, root } = walk(target);

  const sharedSlugSet = new Set<string>();
  const results: { file: string; result: PipelineResult }[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const result = await run(file, content, {
      dryRun,
      usedKeys: sharedSlugSet,
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
  const { results, root, isSingleFile, conflicts, missing, orphaned } = report;

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
      for (const r of result.wrapped) {
        const loc = `:${r.node.line}`.padEnd(6);
        const key = r.keyName.padEnd(38);
        console.log(`    ${loc} ${key} ${JSON.stringify(r.node.text)}`);
      }
    }
    if (result.flaggedDynamic.length > 0) {
      console.log(`  dynamic (needs review):`);
      for (const n of result.flaggedDynamic) {
        console.log(`    :${n.line}  ${JSON.stringify(n.text)}`);
      }
    }
    if (result.unresolved.length > 0) {
      console.log(`  unresolved (needs review):`);
      for (const n of result.unresolved) {
        console.log(
          `    :${n.line}  ${JSON.stringify(n.text)}  (confidence ${n.confidence.toFixed(2)})`
        );
      }
    }
  }

  if (conflicts.length > 0) {
    console.log(`\nConflicts (existing en.json values preserved):`);
    for (const c of conflicts) {
      console.log(
        `  ${c.key}  ${JSON.stringify(c.existingValue)} ≠ ${JSON.stringify(c.newValue)}  (${rel(c.file)}:${c.line}:${c.column})`
      );
    }
  }

  if (missing.length > 0) {
    console.log(`\nMissing keys (used in source, absent from en.json):`);
    for (const u of missing) {
      console.log(`  ${u.keyName}  (${rel(u.file)}:${u.line}:${u.column})`);
    }
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
    for (const k of orphaned) {
      console.log(`  ${k}`);
    }
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
