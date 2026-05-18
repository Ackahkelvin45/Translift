import { ReactAdapter, Replacement } from "./adapters/react";
import { score } from "./scoring";
import { trace } from "./pass2";
import { DEFAULT_REGISTRY } from "./registry";
import { Verdict, StringNode, UsedTranslationKey } from "./types";

export interface PipelineResult {
  nodes: StringNode[];
  modifiedContent: string | null;
  keys: Record<string, Record<string, string>>;
  wrapped: Replacement[];
  unresolved: StringNode[];
  flaggedDynamic: StringNode[];
  /** Pre-existing `t("...")` / `i18n.t("...")` call sites found in source. */
  usedTranslationKeys: UsedTranslationKey[];
}

export async function run(
  filePath: string,
  fileContent: string,
  options: { dryRun: boolean; usedKeys?: Set<string> }
): Promise<PipelineResult> {
  const adapter = new ReactAdapter();

  // Pass 1 — extract and score.
  const { nodes, usedTranslationKeys } = adapter.extract(fileContent, filePath);
  for (const node of nodes) {
    const { confidence, verdict } = score(node, DEFAULT_REGISTRY);
    node.confidence = confidence;
    node.verdict = verdict;
  }

  // Pass 2 — trace escalated strings.
  for (const node of nodes) {
    if (node.verdict === Verdict.Escalate) {
      const result = trace(node, nodes, DEFAULT_REGISTRY);
      node.trace = result;
      node.verdict = result.sink ? Verdict.Wrap : Verdict.Unresolved;
    }
  }

  const toWrap = nodes.filter((n) => n.verdict === Verdict.Wrap);
  const unresolved = nodes.filter((n) => n.verdict === Verdict.Unresolved);
  const flaggedDynamic = nodes.filter((n) => n.verdict === Verdict.FlagDynamic);

  const keys: Record<string, Record<string, string>> = {};
  // When a shared set is passed in, key uniqueness is enforced across files.
  const usedKeys = options.usedKeys ?? new Set<string>();
  const replacements: Replacement[] = toWrap.map((node) => {
    const { namespace, slug } = generateKey(node);
    const keyName = uniqueKey(`${namespace}.${slug}`, usedKeys);
    const dot = keyName.indexOf(".");
    const ns = keyName.slice(0, dot);
    const sl = keyName.slice(dot + 1);
    if (!keys[ns]) keys[ns] = {};
    keys[ns][sl] = node.text;
    return { node, keyName };
  });

  const modifiedContent = options.dryRun
    ? null
    : await adapter.mutate(fileContent, replacements);

  return {
    nodes,
    modifiedContent,
    keys,
    wrapped: replacements,
    unresolved,
    flaggedDynamic,
    usedTranslationKeys,
  };
}

function generateKey(node: StringNode): { namespace: string; slug: string } {
  // Phase 0 scheme: namespace = enclosing component (lowercased) or "common".
  // Slug = first 4 alphanum words of the text. Joined as `${namespace}.${slug}`
  // for the runtime `t()` call; en.json nests them as { [namespace]: { [slug]: text } }.
  const namespace = node.signals.componentName?.toLowerCase() ?? "common";
  const slug =
    node.text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join("_") || "key";
  return { namespace, slug };
}

function uniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const finalKey = `${base}_${i}`;
  used.add(finalKey);
  return finalKey;
}
