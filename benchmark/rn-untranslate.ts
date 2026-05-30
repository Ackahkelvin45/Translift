/**
 * React Native recall harness (roadmap N1 — Bluesky RN adapter claim).
 *
 * Bluesky adopted Lingui too early for clean pre-i18n git archaeology, so we
 * synthesize the pre-i18n state instead: take real Bluesky RN files and
 * mechanically UN-translate the Lingui constructs back to hardcoded form. The
 * set of Lingui messages we strip IS the exact ground truth of what a correct
 * extractor should re-find. We then run TransLift over the reconstructed
 * hardcoded source and measure recall.
 *
 * Conversions (only the unambiguous, single-line-text cases — anything with
 * interpolation/JSX children is SKIPPED and excluded from ground truth, so we
 * never credit/penalize a tool for a shape this harness can't faithfully
 * reconstruct):
 *   <Trans>Plain text</Trans>           -> Plain text            (JSX text)
 *   {_(msg`Plain text`)}                -> {"Plain text"}        (expr container)
 *   attr={_(msg`Plain text`)}           -> attr="Plain text"     (JSX attribute)
 *   prop: _(msg`Plain text`)            -> prop: "Plain text"    (object property)
 *
 * Usage: ts-node benchmark/rn-untranslate.ts <srcDir> <outDir>
 *   writes converted files to <outDir>, prints ground-truth count, and writes
 *   <outDir>/ground-truth.json (array of strings).
 */
import * as fs from "fs";
import * as path from "path";
import { parse as babelParse } from "@babel/parser";

/** Does the converted source still parse? Regex JSX rewriting can break nesting;
 *  a file we mangled must be dropped (its strings excluded from ground truth) so
 *  we never penalize the tool for our own bad reconstruction. */
function parses(code: string): boolean {
  try {
    babelParse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    return true;
  } catch {
    return false;
  }
}

function walkTsx(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walkTsx(p, acc);
    } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

// A "plain text" Lingui message: letters/spaces/basic punctuation, no template
// expression (`${`), no nested JSX, no leading/trailing braces. Conservative on
// purpose — we'd rather drop a hard case than reconstruct it wrong.
const PLAIN = /^[^`${}<>]+$/;

interface Conv {
  content: string;
  truth: string[];
}

function untranslate(src: string): Conv {
  const truth = new Set<string>();
  let out = src;

  // 1) <Trans>Plain text</Trans>  -> Plain text
  out = out.replace(/<Trans>([^<>{}]+?)<\/Trans>/g, (m, text) => {
    const t = String(text).trim();
    if (t && PLAIN.test(t)) {
      truth.add(t);
      return t;
    }
    return m;
  });

  // 2) attr={_(msg`Plain text`)}  -> attr="Plain text"
  out = out.replace(
    /([A-Za-z_][\w]*)=\{_\(msg`([^`]+?)`\)\}/g,
    (m, attr, text) => {
      const t = String(text).trim();
      if (t && PLAIN.test(t)) {
        truth.add(t);
        return `${attr}="${t}"`;
      }
      return m;
    }
  );

  // 3) prop: _(msg`Plain text`)  -> prop: "Plain text"
  out = out.replace(
    /([A-Za-z_][\w]*):\s*_\(msg`([^`]+?)`\)/g,
    (m, prop, text) => {
      const t = String(text).trim();
      if (t && PLAIN.test(t)) {
        truth.add(t);
        return `${prop}: "${t}"`;
      }
      return m;
    }
  );

  // 4) standalone {_(msg`Plain text`)}  -> {"Plain text"}  (JSX expr container)
  out = out.replace(/\{_\(msg`([^`]+?)`\)\}/g, (m, text) => {
    const t = String(text).trim();
    if (t && PLAIN.test(t)) {
      truth.add(t);
      return `{"${t}"}`;
    }
    return m;
  });

  return { content: out, truth: [...truth] };
}

function main() {
  const [srcDir, outDir] = process.argv.slice(2);
  if (!srcDir || !outDir) {
    console.error("usage: rn-untranslate.ts <srcDir> <outDir>");
    process.exit(1);
  }
  const files = walkTsx(path.resolve(srcDir));
  const allTruth = new Set<string>();
  let converted = 0;
  let dropped = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf-8");
    const { content, truth } = untranslate(src);
    if (truth.length === 0) continue;
    // Drop files our regex conversion left unparseable — they'd otherwise inflate
    // the denominator with strings the tool never had a chance to see.
    if (!parses(content)) {
      dropped++;
      continue;
    }
    converted++;
    truth.forEach((t) => allTruth.add(t));
    const rel = path.relative(path.resolve(srcDir), f);
    const dest = path.join(path.resolve(outDir), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  if (dropped) console.log(`dropped ${dropped} file(s) our conversion broke (excluded from ground truth)`);
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(
    path.join(path.resolve(outDir), "ground-truth.json"),
    JSON.stringify([...allTruth], null, 2)
  );
  console.log(
    `converted ${converted}/${files.length} files; ground truth: ${allTruth.size} strings`
  );
}

main();
