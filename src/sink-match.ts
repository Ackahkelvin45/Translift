/**
 * Shared sink-matching helpers used by Pass 1 ([src/scoring.ts](./scoring.ts))
 * and Pass 2 ([src/pass2.ts](./pass2.ts)) to keep the two callers honest about
 * how registry entries are evaluated.
 *
 * Currently exposes the `matchFile` glob check (F1 of
 * [sink-registry-fixes-plan.md](../sink-registry-fixes-plan.md)). Future fixes
 * (importFrom enforcement, propsType shape matching) land here too — anywhere
 * an answer is needed in *both* passes.
 */
import micromatch from "micromatch";

/**
 * F6 — the resolved identity of a component that a wrapper/HOC declaration
 * unwraps to. `const StyledToast = styled(Toast)` yields one target for the
 * inner `Toast`, carrying its canonical name plus the declaration-file /
 * import-specifier needed to evaluate a registry entry's `matchFile` /
 * `importFrom` constraints. Produced by the project graph, consumed by Pass 2's
 * `matchSink`.
 */
export interface WrapperTarget {
  /** Canonical (alias-chased) name of the wrapped component. */
  name: string;
  /** Absolute declaration file of the wrapped component; `undefined` for `node_modules`. */
  declarationFile?: string;
  /** Module specifier the wrapped component was imported from, if any. */
  importSpecifier?: string;
}

/**
 * Returns true if the sink entry's `matchFile` glob (if any) accepts the
 * declaration file path. Unspecified glob → always accepts.
 *
 * Declarations from `node_modules` are explicitly rejected when a glob is set
 * — third-party packages should be allowed via `importFrom`, not by path glob.
 * (Our graph already treats node_modules as dead-ends so a graph-resolved
 * declaration path inside node_modules is rare, but we defend against it.)
 */
export function matchFilePathOk(
  declarationFile: string | undefined,
  glob: string | undefined
): boolean {
  if (!glob) return true;
  if (!declarationFile) return false;
  if (declarationFile.includes("/node_modules/")) return false;
  return micromatch.isMatch(declarationFile, glob);
}
