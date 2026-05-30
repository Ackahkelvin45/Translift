# TransLift

Autonomous i18n extraction CLI. Phase 0 — proof of concept.

See `translift-phase-0-spec.md` for the full spec.

## Quick start

```bash
npm install
npm run build
node dist/cli.js extract fixtures/phase-0 --dry-run
# or, without building: npx ts-node src/cli.ts extract fixtures/phase-0 --dry-run
```

## Commands

```bash
translift extract <target> [--dry-run] [-v]   # wrap UI strings in t() and write en.json
translift audit   <target> [--strict] [-v]    # read-only drift check; non-zero exit on drift
translift explain <target> "<string>"         # why a string was wrapped / skipped / escalated
```

### `explain` — why did this string get that verdict?

Every wrap/skip/escalate decision is auditable. `explain` finds a string and
shows the decisive reason, the weighted-score breakdown (when relevant), and —
for cross-file cases — the path it traced through the project graph into its
sink:

```
$ translift explain ./src "Payment failed completely."

"Payment failed completely."   lib.tsx:1:25
  verdict: WRAP  (confidence 0.35)
  why:
    • traced through the project graph to component:Toast at depth 2

  trace:
    ◆ "Payment failed completely."  (lib.tsx:1)
    │
    ▼ assigned to errorMsg in lib.tsx:1
    │
    ▼ passed as prop 'message' to <Toast> in App.tsx:2
    ✅ sink: component:Toast
```

It also explains skips (`console.log`, identifier-shape, blocked attribute
sinks), weighted escalations (with the per-signal `+`/`−` breakdown), and
flags whether a sink matched via an aliased import or an unwrapped wrapper.

## Configuration

TransLift's default sink registry covers common React patterns (`<Toast>`, `aria-label`, `toast()` from `react-hot-toast`/`sonner`, etc.). If your codebase uses different component or function names for UI output, register them in a config file at the project root.

### Where the config lives

Drop one of these at your project root:

```
translift.config.ts    ← recommended (typed)
translift.config.mts
translift.config.cts
translift.config.js
translift.config.mjs
translift.config.cjs
translift.config.json
```

TransLift walks up from the directory you point `extract` / `audit` at, so a config at the repo root is picked up even when you scan a subfolder. When a config is found, the CLI prints `config: <path>` at the top of the report.

### Example

```ts
// translift.config.ts
import { defineConfig } from "translift/config";

export default defineConfig({
  sinks: {
    components: [
      { name: "Notify", uiProps: "all-children" },
      { name: "ConfirmDialog", uiProps: ["title", "body"] },
    ],
    functions: [
      { name: "showError", uiArgs: [0] },
      { name: "track", importFrom: "@/analytics", uiArgs: [1] },
    ],
    attributes: [
      { name: "data-tooltip" },
    ],
  },
});
```

The `defineConfig` helper is an identity function — it only exists to give you autocomplete. Plain `export default { ... }` works too.

### Merge semantics

Every sink array follows the same rule:

| You write | Result |
|---|---|
| (key omitted) | Defaults kept as-is |
| `[]` | Defaults cleared for that sink type |
| `[items]` | Defaults kept, your items appended |

So:

```ts
// Adds `notify` alongside default `toast`, `alert`, `confirm`:
export default defineConfig({
  sinks: { functions: [{ name: "notify", uiArgs: [0] }] },
});

// Replaces defaults entirely — only `notify` is a function sink now:
export default defineConfig({
  sinks: { functions: [] },
});
// then add yours back in a follow-up array, or omit the key to keep defaults.
```

Defaults take priority on first-match lookups, so appending an entry with the same name as a default won't override it. To replace a default, clear with `[]` and re-list what you want.

### JSON variant

For projects that prefer not to add a TS config file:

```json
{
  "sinks": {
    "functions": [{ "name": "showError", "uiArgs": [0] }]
  }
}
```

### Full schema

```ts
interface TransliftConfig {
  sinks?: {
    components?: {
      name: string;
      importFrom?: string;         // require the component to be imported from this module
      uiProps?: string[] | "all-children";  // which props carry copy; omit to infer (see below)
      inferUiProps?: boolean;      // default true; set false to disable inference for this entry
      matchFile?: string;          // micromatch glob on the component's *declaration* file
    }[];
    attributes?: { name: string; onElements?: string[]; notOnElements?: string[] }[];
    functions?: {
      name: string;
      importFrom?: string;
      uiArgs: number[] | "all";
      matchFile?: string;
    }[];
    translationCallees?: (
      | { kind: "identifier"; name: string }            // bare t(...)
      | { kind: "member"; object: string; property: string }  // i18n.t(...)
    )[];
  };
  thresholds?: { wrap?: number; escalate?: number };
  pass2?: { maxDepth?: number };       // cross-file trace depth (Phase 2 Step 3)
  discovery?: { minHits?: number };    // hub-analysis threshold (Phase 2 Step 3)
}
```

`thresholds`, `pass2`, and `discovery` are accepted today but only consumed once the corresponding Phase 2 features land.

### Inferred `uiProps`

For a component sink, `uiProps` declares which props carry user-facing strings:

- `"all-children"` — every prop is treated as a UI sink.
- `["title", "body"]` — only the listed props.
- **omitted** — TransLift infers the prop list from the component's TypeScript type: it enumerates string-typed props and keeps the ones that look like copy, excluding structural props (`className`, `id`, `href`, `style`, …), event handlers (`onClick`, …), `data-*`, and `aria-*` other than `aria-label` / `aria-description`.

Inference needs the component's types to resolve. When they can't (untyped JS, missing imports, a wrapper the checker can't see), the entry simply matches no prop — nothing is wrapped, nothing crashes. An explicit `uiProps` always wins over inference; set `inferUiProps: false` to opt a single entry out of inference while leaving `uiProps` omitted (it then matches no prop).

```ts
// Both of these are equivalent if Banner's props type is `{ message: string; className?: string }`:
{ name: "Banner" }                    // infers ["message"] (className is blocklisted)
{ name: "Banner", uiProps: ["message"] }  // explicit
```

### Wrapper / HOC components

Register the *underlying* component once and TransLift follows wrappers built on
it. If `Toast` is registered, a wrapper declared as any of:

```ts
const StyledToast = styled(Toast)`…`;       // styled-components / emotion
const MemoToast   = memo(Toast);            // React.memo
const Tracked     = withTracking(Modal);    // custom HOC
const Connected   = connect(mapState)(Toast); // curried HOC
```

…is recognized when used as `<StyledToast message={…} />`, because the
declaration's call arguments are unwrapped back to the registered inner
component. Prop gating still applies (using the wrapper's own resolved prop
type), and the inner entry's `importFrom` / `matchFile` constraints are checked
against the wrapped component's origin. Each wrapper match prints an advisory so
the heuristic is visible.

Wrappers that don't take the component as a call argument — e.g.
`forwardRef((props, ref) => …)` or a hand-written component that internally
renders another — aren't unwrapped; register those directly.
