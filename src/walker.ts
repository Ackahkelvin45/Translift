import * as fs from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { ReactAdapter } from "./adapters/react";

// Directories we always skip regardless of .gitignore.
const ALWAYS_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

export interface WalkResult {
  /** Absolute path of every file the adapter should process. */
  files: string[];
  /** Resolved root directory (absolute). */
  root: string;
}

export function walk(target: string): WalkResult {
  const absTarget = path.resolve(target);
  const stat = fs.statSync(absTarget);

  // Single-file shortcut keeps the CLI uniform.
  if (stat.isFile()) {
    return { files: [absTarget], root: path.dirname(absTarget) };
  }

  const adapter = new ReactAdapter();
  const ig = loadGitignore(absTarget);
  const files: string[] = [];

  const visit = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (ALWAYS_SKIP.has(entry.name)) continue;

      // ignore expects paths relative to the gitignore root, with forward slashes.
      const rel = path.relative(absTarget, full).split(path.sep).join("/");
      if (rel && ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;

      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && adapter.detect(full)) {
        files.push(full);
      }
    }
  };

  visit(absTarget);
  return { files, root: absTarget };
}

function loadGitignore(root: string): Ignore {
  const ig = ignore();
  // Walk up from the target collecting .gitignore files so a nested run still
  // respects the repo's top-level ignores.
  let cur = root;
  const collected: string[] = [];
  while (true) {
    const candidate = path.join(cur, ".gitignore");
    if (fs.existsSync(candidate)) collected.unshift(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const file of collected) {
    ig.add(fs.readFileSync(file, "utf-8"));
  }
  return ig;
}
