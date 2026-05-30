/**
 * Lingui re-translation FP scorer (Bluesky benchmark, roadmap N1).
 *
 * Mirrors the Mattermost react-intl FP measurement, but for Lingui. A
 * "re-translation FP" is a wrap a tool emits on text that is ALREADY translated
 * — i.e. it lands inside a Lingui construct:
 *   - <Trans>…</Trans> / <Plural> / <Select> / <SelectOrdinal>  (JSX children)
 *   - msg`…` / t`…` / plural`…`  (tagged-template macros)
 *   - _( … ) / i18n._( … ) / t( … ) / i18n.t( … )  (call macros)
 *
 * Tool-agnostic by design (roadmap E5): it detects translated regions once via
 * babel, then scores a list of {file,line} wrap positions against them. For
 * TransLift we feed positions straight from the pipeline; for i18next-cli / a18n
 * we feed positions parsed from the diff they write.
 *
 * Usage:
 *   ts-node benchmark/lingui-fp.ts translift <targetDir>
 *   ts-node benchmark/lingui-fp.ts score    <targetDir> <positionsJson>
 */
import { parse as babelParse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import * as fs from "fs";
import * as path from "path";
import { walk } from "../src/walker";
import { buildProjectGraph } from "../src/graph-project";
import { run } from "../src/pipeline";
import { resolve as resolveConfig } from "../src/config";
import { Verdict } from "../src/types";

interface Region {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

const LINGUI_JSX = new Set(["Trans", "Plural", "Select", "SelectOrdinal"]);
// Tagged-template macros: here `t` is unambiguously Lingui (`` t`Hello` ``).
const LINGUI_TAG_CALLEES = new Set(["t", "msg", "plural", "select", "selectOrdinal"]);
// Call-form Lingui markers. Bare `t` is DELIBERATELY EXCLUDED — `t(key, default)`
// is also i18next's OUTPUT callee, so counting it as a Lingui region would make
// every i18next wrap self-match as a false positive. A re-translation FP is a
// wrap landing inside an UNAMBIGUOUS already-translated construct: `msg(...)`,
// `_(...)` (useLingui runtime), `plural/select(...)`, `defineMessage(...)`, or a
// `<Trans>/<Plural>` element / Lingui tagged template.
const LINGUI_CALL_CALLEES = new Set(["msg", "_", "plural", "select", "selectOrdinal", "defineMessage"]);

function calleeName(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && t.isIdentifier(node.property)) return node.property.name; // i18n._ , i18n.t
  return null;
}

/** Collect line ranges of every Lingui-translated construct in one file. */
function linguiRegions(content: string, filename: string): Region[] {
  const regions: Region[] = [];
  let ast;
  try {
    ast = babelParse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy", "classProperties"],
      errorRecovery: true,
    });
  } catch {
    return regions;
  }
  const push = (node: t.Node) => {
    if (node.loc)
      regions.push({
        startLine: node.loc.start.line,
        startCol: node.loc.start.column,
        endLine: node.loc.end.line,
        endCol: node.loc.end.column,
      });
  };
  traverse(ast, {
    JSXElement(p) {
      const name = p.node.openingElement.name;
      if (t.isJSXIdentifier(name) && LINGUI_JSX.has(name.name)) push(p.node);
    },
    TaggedTemplateExpression(p) {
      const n = calleeName(p.node.tag);
      if (n && LINGUI_TAG_CALLEES.has(n)) push(p.node);
    },
    CallExpression(p) {
      const n = calleeName(p.node.callee);
      if (n && LINGUI_CALL_CALLEES.has(n)) push(p.node);
    },
  });
  return regions;
}

/** Column-precise containment: the wrap's start must fall within the region span. */
function inRegion(line: number, col: number, regions: Region[]): boolean {
  return regions.some((r) => {
    if (line < r.startLine || line > r.endLine) return false;
    if (line === r.startLine && col < r.startCol) return false;
    if (line === r.endLine && col > r.endCol) return false;
    return true;
  });
}

interface WrapPos {
  file: string;
  line: number;
  col: number;
  text?: string;
}

/** Score a set of wrap positions: how many land inside an existing Lingui region. */
function scorePositions(root: string, positions: WrapPos[]) {
  const regionCache = new Map<string, Region[]>();
  const regionsFor = (file: string): Region[] => {
    if (!regionCache.has(file)) {
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      regionCache.set(file, content ? linguiRegions(content, file) : []);
    }
    return regionCache.get(file)!;
  };
  let fp = 0;
  let genuine = 0;
  const fpSamples: WrapPos[] = [];
  const genuineSamples: WrapPos[] = [];
  for (const p of positions) {
    if (inRegion(p.line, p.col ?? 0, regionsFor(p.file))) {
      fp++;
      if (fpSamples.length < 15) fpSamples.push(p);
    } else {
      genuine++;
      if (genuineSamples.length < 15) genuineSamples.push(p);
    }
  }
  return { total: positions.length, fp, genuine, fpSamples, genuineSamples };
}

async function transliftPositions(root: string): Promise<WrapPos[]> {
  const { files } = walk(root);
  const config = resolveConfig({}, null);
  const graphContext = buildProjectGraph(root, files);
  const shared = new Set<string>();
  const positions: WrapPos[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const res = await run(file, content, { dryRun: true, usedKeys: shared, config, graphContext });
    for (const n of res.nodes as any[]) {
      if (n.verdict === Verdict.Wrap) {
        positions.push({ file, line: n.line ?? 0, col: n.column ?? 0, text: n.text });
      }
    }
  }
  return positions;
}

function rel(root: string, f: string) {
  return path.relative(root, f);
}

async function main() {
  const [mode, target, posJson] = process.argv.slice(2);
  if (!mode || !target) {
    console.error("usage: lingui-fp.ts <translift|score> <targetDir> [positionsJson]");
    process.exit(1);
  }
  const root = path.resolve(target);

  let positions: WrapPos[];
  let label: string;
  if (mode === "translift") {
    positions = await transliftPositions(root);
    label = "TransLift (extract, dry-run)";
  } else if (mode === "score") {
    positions = JSON.parse(fs.readFileSync(posJson, "utf-8"));
    label = `external (${path.basename(posJson)})`;
  } else {
    console.error("unknown mode " + mode);
    process.exit(1);
    return;
  }

  const s = scorePositions(root, positions);
  const out: string[] = [];
  out.push(`# Lingui re-translation FP — ${label}`);
  out.push("");
  out.push(`target: \`${root}\``);
  out.push(`total wraps emitted: **${s.total}**`);
  out.push(`re-translation FP (wrap inside existing Lingui region): **${s.fp}**`);
  out.push(`wraps outside any Lingui region (candidate genuine hardcoded): ${s.genuine}`);
  out.push("");
  out.push("## sample FP (already-translated, re-wrapped)");
  for (const p of s.fpSamples) out.push(`- ${rel(root, p.file)}:${p.line}:${p.col}  ${p.text ? JSON.stringify(p.text) : ""}`);
  out.push("");
  out.push("## sample genuine (outside Lingui regions)");
  for (const p of s.genuineSamples) out.push(`- ${rel(root, p.file)}:${p.line}:${p.col}  ${p.text ? JSON.stringify(p.text) : ""}`);
  const report = out.join("\n");
  console.log(report);
  fs.writeFileSync(path.join(path.dirname(posJson ?? "/tmp/x"), "lingui-fp-out.md"), report + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
