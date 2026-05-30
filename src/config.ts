import * as fs from "fs";
import * as path from "path";
import { createJiti } from "jiti";
import {
  AttributeSink,
  ComponentSink,
  FunctionSink,
  SinkRegistry,
} from "./types";
import { DEFAULT_REGISTRY } from "./registry";

export type TranslationCallee =
  | { kind: "identifier"; name: string }
  | { kind: "member"; object: string; property: string };

export interface TransliftConfig {
  sinks?: {
    components?: ComponentSink[];
    attributes?: AttributeSink[];
    functions?: FunctionSink[];
    translationCallees?: TranslationCallee[];
  };
  thresholds?: { wrap?: number; escalate?: number };
  pass2?: { maxDepth?: number };
  discovery?: { minHits?: number };
}

export interface ResolvedConfig {
  registry: SinkRegistry;
  translationCallees: TranslationCallee[];
  thresholds: { wrap: number; escalate: number };
  pass2: { maxDepth: number };
  discovery: { minHits: number };
  sourcePath: string | null;
}

const CONFIG_BASENAMES = [
  "translift.config.ts",
  "translift.config.mts",
  "translift.config.cts",
  "translift.config.js",
  "translift.config.mjs",
  "translift.config.cjs",
  "translift.config.json",
];

const DEFAULT_TRANSLATION_CALLEES: TranslationCallee[] = [
  { kind: "identifier", name: "t" },
  { kind: "member", object: "i18n", property: "t" },
];

const DEFAULT_THRESHOLDS = { wrap: 0.75, escalate: 0.25 };
const DEFAULT_PASS2 = { maxDepth: 5 };
const DEFAULT_DISCOVERY = { minHits: 5 };

/** Identity helper that gives users autocomplete in `translift.config.ts`. */
export function defineConfig(c: TransliftConfig): TransliftConfig {
  return c;
}

/** Walk up from `startDir` looking for any supported config filename. */
export function findConfigPath(startDir: string): string | null {
  let cur = path.resolve(startDir);
  while (true) {
    for (const name of CONFIG_BASENAMES) {
      const candidate = path.join(cur, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export async function loadConfig(
  startDir: string = process.cwd()
): Promise<ResolvedConfig> {
  const configPath = findConfigPath(startDir);
  const raw = configPath ? await readConfigFile(configPath) : {};
  return resolve(raw, configPath);
}

async function readConfigFile(configPath: string): Promise<TransliftConfig> {
  if (configPath.endsWith(".json")) {
    const text = fs.readFileSync(configPath, "utf-8");
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object"
        ? (parsed as TransliftConfig)
        : {};
    } catch (err) {
      throw new Error(
        `translift: failed to parse ${configPath} as JSON: ${(err as Error).message}`
      );
    }
  }
  const jiti = createJiti(configPath, { interopDefault: true });
  const mod = (await jiti.import(configPath)) as unknown;
  const user = extractDefaultExport(mod);
  if (!user || typeof user !== "object") {
    throw new Error(
      `translift: ${configPath} did not export a config object (use \`export default defineConfig({...})\`)`
    );
  }
  return user as TransliftConfig;
}

function extractDefaultExport(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in (mod as object)) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

/** Merge user config over defaults. Pure — exported so tests can hit it directly. */
export function resolve(
  user: TransliftConfig,
  sourcePath: string | null
): ResolvedConfig {
  const userSinks = user.sinks ?? {};
  const registry: SinkRegistry = {
    components: mergeArray<ComponentSink>(
      DEFAULT_REGISTRY.components,
      userSinks.components
    ),
    attributes: mergeArray<AttributeSink>(
      DEFAULT_REGISTRY.attributes,
      userSinks.attributes
    ),
    functions: mergeArray<FunctionSink>(
      DEFAULT_REGISTRY.functions,
      userSinks.functions
    ),
  };
  const translationCallees = mergeArray<TranslationCallee>(
    DEFAULT_TRANSLATION_CALLEES,
    userSinks.translationCallees
  );

  return {
    registry,
    translationCallees,
    thresholds: {
      wrap: user.thresholds?.wrap ?? DEFAULT_THRESHOLDS.wrap,
      escalate: user.thresholds?.escalate ?? DEFAULT_THRESHOLDS.escalate,
    },
    pass2: { maxDepth: user.pass2?.maxDepth ?? DEFAULT_PASS2.maxDepth },
    discovery: { minHits: user.discovery?.minHits ?? DEFAULT_DISCOVERY.minHits },
    sourcePath,
  };
}

// Merge semantics, documented:
//   undefined → keep defaults
//   []        → clear defaults (escape hatch for opting out)
//   [items]   → append after defaults (defaults still win on first-match lookups)
function mergeArray<T>(defaults: T[], user: T[] | undefined): T[] {
  if (user === undefined) return [...defaults];
  if (user.length === 0) return [];
  return [...defaults, ...user];
}
