/**
 * Sub-step 3h — hub analysis.
 *
 * After the project graph is built, count incoming `passed_as_arg` and
 * `passed_as_prop` edges whose source is string-bearing (a string literal or
 * a symbol) and whose target is NOT in the user's sink registry. Targets that
 * accumulate ≥ `minHits` are flagged in the audit's "Possible unregistered
 * sinks" section so the developer can decide whether to register them.
 *
 * Report-only — never affects wrap verdicts or audit exit code. Per the spec.
 */
import { GraphNode, ProjectGraph } from "./graph";
import { SinkRegistry } from "./types";

export interface HubSample {
  file: string;
  line: number;
}

export interface HubFinding {
  /** Function name (call-expression callee) or component tag. */
  name: string;
  /** Total edge count — every distinct edge contributes one hit. */
  hits: number;
  /** Up to 3 unique `(file, line)` locations from the call/use sites. */
  samples: HubSample[];
}

export interface HubReport {
  functions: HubFinding[];
  components: HubFinding[];
}

const MAX_SAMPLES = 3;

export function findUnregisteredSinks(
  graph: ProjectGraph,
  registry: SinkRegistry,
  minHits: number,
  /**
   * Function names to skip even if they would otherwise qualify. The CLI
   * passes the configured `translationCallees` names here — they're the
   * translation primitive itself (`t`, `i18n.t`), so suggesting the user
   * "register them as sinks" would be nonsensical.
   */
  excludedFunctions: Set<string> = new Set()
): HubReport {
  const fnAcc = new Map<string, Accumulator>();
  const compAcc = new Map<string, Accumulator>();

  const registeredFns = new Set(registry.functions.map((f) => f.name));
  const registeredComps = new Set(registry.components.map((c) => c.name));

  for (const node of graph.nodes()) {
    for (const edge of graph.edges(node)) {
      if (edge.type === "passed_as_arg") {
        const source = graph.getNode(edge.from);
        if (!isStringBearing(source)) continue;
        const target = graph.getNode(edge.to);
        if (target?.type !== "call-expression") continue;
        if (!target.calleeName) continue;
        if (registeredFns.has(target.calleeName)) continue;
        if (excludedFunctions.has(target.calleeName)) continue;
        bump(fnAcc, target.calleeName, target.file, target.line);
      } else if (edge.type === "passed_as_prop") {
        const source = graph.getNode(edge.from);
        if (!isStringBearing(source)) continue;
        const target = graph.getNode(edge.to);
        if (target?.type !== "jsx-element") continue;
        if (registeredComps.has(target.tagName)) continue;
        bump(compAcc, target.tagName, target.file, target.line);
      }
    }
  }

  return {
    functions: collect(fnAcc, minHits),
    components: collect(compAcc, minHits),
  };
}

interface Accumulator {
  hits: number;
  samples: HubSample[];
  seenLocations: Set<string>;
}

function isStringBearing(n: GraphNode | undefined): boolean {
  return !!n && (n.type === "string-literal" || n.type === "symbol");
}

function bump(
  acc: Map<string, Accumulator>,
  key: string,
  file: string,
  line: number
): void {
  let entry = acc.get(key);
  if (!entry) {
    entry = { hits: 0, samples: [], seenLocations: new Set() };
    acc.set(key, entry);
  }
  entry.hits++;
  const locKey = `${file}:${line}`;
  if (!entry.seenLocations.has(locKey) && entry.samples.length < MAX_SAMPLES) {
    entry.seenLocations.add(locKey);
    entry.samples.push({ file, line });
  }
}

function collect(
  acc: Map<string, Accumulator>,
  minHits: number
): HubFinding[] {
  const out: HubFinding[] = [];
  for (const [name, entry] of acc) {
    if (entry.hits < minHits) continue;
    out.push({ name, hits: entry.hits, samples: entry.samples });
  }
  // Highest-hit findings first so they grab the user's attention.
  return out.sort((a, b) => b.hits - a.hits);
}
