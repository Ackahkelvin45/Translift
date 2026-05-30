/**
 * F4 — TypeChecker baseline smoke tests.
 *
 * Pure infrastructure: nothing in the pipeline calls `getComponentPropTypes`
 * yet (F5/F6 will). These tests prove three things the layer above relies on:
 *
 *   1. The TypeChecker is actually wired — querying a typed component returns
 *      its real prop shape (names, string-ness, required-ness).
 *   2. Graceful degradation — untyped / unresolvable tags return `undefined`,
 *      never throw.
 *   3. The per-symbol cache short-circuits repeated usages of the same tag.
 */
import { describe, expect, it } from "vitest";
import { Project, SyntaxKind, ts } from "ts-morph";
import {
  PropTypeInfo,
  getComponentPropTypes,
  inferStringPropNames,
  isUiPropName,
  makeTypeInfoCache,
} from "../src/type-info";

function mkProject(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

/** Grab the first JSX tag (self-closing or opening) in a source file. */
function firstTag(project: Project, file: string) {
  const sf = project.getSourceFileOrThrow(file);
  return (
    sf.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) ??
    sf.getFirstDescendantByKind(SyntaxKind.JsxOpeningElement)
  );
}

function byName(props: PropTypeInfo[], name: string): PropTypeInfo | undefined {
  return props.find((p) => p.name === name);
}

describe("getComponentPropTypes — typed component", () => {
  const project = mkProject({
    "/Toast.tsx": `
      interface ToastProps {
        message: string;
        title?: string;
        duration: number;
        onClose?: () => void;
      }
      export function Toast(props: ToastProps) { return null as any; }
    `,
    "/App.tsx": `
      import { Toast } from "./Toast";
      export const App = () => <Toast message="hi" duration={3} />;
    `,
  });

  const tag = firstTag(project, "/App.tsx")!;
  const props = getComponentPropTypes(tag);

  it("resolves the component's prop names", () => {
    expect(props).toBeDefined();
    expect(props!.map((p) => p.name).sort()).toEqual([
      "duration",
      "message",
      "onClose",
      "title",
    ]);
  });

  it("flags string-typed props (and only those) as isString", () => {
    expect(byName(props!, "message")!.isString).toBe(true);
    expect(byName(props!, "title")!.isString).toBe(true);
    expect(byName(props!, "duration")!.isString).toBe(false);
    expect(byName(props!, "onClose")!.isString).toBe(false);
  });

  it("marks optional props as not required", () => {
    expect(byName(props!, "message")!.required).toBe(true);
    expect(byName(props!, "duration")!.required).toBe(true);
    expect(byName(props!, "title")!.required).toBe(false);
    expect(byName(props!, "onClose")!.required).toBe(false);
  });
});

describe("getComponentPropTypes — string-literal union prop", () => {
  it("treats a union of string literals as string-like", () => {
    const project = mkProject({
      "/Badge.tsx": `
        interface BadgeProps { variant: "info" | "warn" | "error"; }
        export function Badge(props: BadgeProps) { return null as any; }
      `,
      "/Use.tsx": `
        import { Badge } from "./Badge";
        export const Use = () => <Badge variant="info" />;
      `,
    });
    const props = getComponentPropTypes(firstTag(project, "/Use.tsx")!);
    expect(byName(props!, "variant")!.isString).toBe(true);
  });

  it("does not treat string | number as string-like", () => {
    const project = mkProject({
      "/Mixed.tsx": `
        interface MixedProps { value: string | number; }
        export function Mixed(props: MixedProps) { return null as any; }
      `,
      "/Use.tsx": `
        import { Mixed } from "./Mixed";
        export const Use = () => <Mixed value="x" />;
      `,
    });
    const props = getComponentPropTypes(firstTag(project, "/Use.tsx")!);
    expect(byName(props!, "value")!.isString).toBe(false);
  });
});

describe("getComponentPropTypes — graceful degradation", () => {
  it("returns undefined for an untyped (any-prop) component", () => {
    const project = mkProject({
      "/Untyped.tsx": `
        export function Untyped(props) { return null; }
      `,
      "/Use.tsx": `
        import { Untyped } from "./Untyped";
        export const Use = () => <Untyped label="hi" />;
      `,
    });
    const props = getComponentPropTypes(firstTag(project, "/Use.tsx")!);
    expect(props).toBeUndefined();
  });

  it("returns undefined for an unresolvable tag, never throws", () => {
    const project = mkProject({
      "/Use.tsx": `export const Use = () => <Missing label="hi" />;`,
    });
    expect(() =>
      getComponentPropTypes(firstTag(project, "/Use.tsx")!)
    ).not.toThrow();
    expect(getComponentPropTypes(firstTag(project, "/Use.tsx")!)).toBeUndefined();
  });
});

describe("getComponentPropTypes — caching", () => {
  it("populates one cache entry per symbol across repeated usages", () => {
    const project = mkProject({
      "/Toast.tsx": `
        interface ToastProps { message: string; }
        export function Toast(props: ToastProps) { return null as any; }
      `,
      "/App.tsx": `
        import { Toast } from "./Toast";
        export const A = () => <Toast message="a" />;
        export const B = () => <Toast message="b" />;
      `,
    });
    const sf = project.getSourceFileOrThrow("/App.tsx");
    const tags = sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
    expect(tags).toHaveLength(2);

    const cache = makeTypeInfoCache();
    const first = getComponentPropTypes(tags[0], cache);
    expect(cache.size).toBe(1);
    const second = getComponentPropTypes(tags[1], cache);
    // Both usages resolve to the same declared symbol → one cache entry.
    expect(cache.size).toBe(1);
    expect(first).toEqual(second);
  });

  it("caches negative results so failures are not re-queried", () => {
    const project = mkProject({
      "/Untyped.tsx": `export function Untyped(props) { return null; }`,
      "/Use.tsx": `
        import { Untyped } from "./Untyped";
        export const Use = () => <Untyped label="hi" />;
      `,
    });
    const cache = makeTypeInfoCache();
    expect(getComponentPropTypes(firstTag(project, "/Use.tsx")!, cache)).toBeUndefined();
    // A negative result is cached as `null`, not absent.
    expect(cache.size).toBe(1);
    expect([...cache.values()][0]).toBeNull();
  });
});

describe("isUiPropName — F5b blocklist", () => {
  it("accepts plausible copy-bearing prop names", () => {
    for (const ok of ["message", "title", "label", "placeholder", "content", "description", "aria-label", "aria-description"]) {
      expect(isUiPropName(ok)).toBe(true);
    }
  });

  it("rejects structural / non-copy string props", () => {
    for (const bad of ["className", "id", "htmlFor", "key", "href", "src", "type", "role", "name", "style"]) {
      expect(isUiPropName(bad)).toBe(false);
    }
  });

  it("rejects event handlers, data-*, and non-label aria-*", () => {
    expect(isUiPropName("onClick")).toBe(false);
    expect(isUiPropName("onChange")).toBe(false);
    expect(isUiPropName("data-testid")).toBe(false);
    expect(isUiPropName("data-foo")).toBe(false);
    expect(isUiPropName("aria-hidden")).toBe(false);
    expect(isUiPropName("aria-labelledby")).toBe(false);
  });

  it("rejects SVG / CSS presentation attributes (real-codebase false positives)", () => {
    // These reached Pass 2's type-driven uiProps inference and wrongly wrapped
    // geometry/style values on the real Excalidraw checkout (`d="M39.9…"`,
    // `viewBox="0 0 40 40"`, `transform="translate(…)"`, `size="var(…)"`).
    for (const svg of ["d", "viewBox", "transform", "gradientTransform", "points", "fill", "stroke", "cx", "cy", "r", "x", "y", "width", "height", "offset", "size", "preserveAspectRatio"]) {
      expect(isUiPropName(svg)).toBe(false);
    }
  });
});

describe("inferStringPropNames — F5b", () => {
  it("returns only string-typed, non-blocklisted prop names", () => {
    const project = mkProject({
      "/Banner.tsx": `
        interface BannerProps {
          message: string;
          subtitle?: string;
          id: string;
          className?: string;
          count: number;
          onClick?: () => void;
        }
        export function Banner(props: BannerProps) { return null as any; }
      `,
      "/Use.tsx": `
        import { Banner } from "./Banner";
        export const Use = () => <Banner message="a" id="b" />;
      `,
    });
    const names = inferStringPropNames(firstTag(project, "/Use.tsx")!);
    expect(names!.sort()).toEqual(["message", "subtitle"]);
  });

  it("returns undefined when the component is untyped", () => {
    const project = mkProject({
      "/Untyped.tsx": `export function Untyped(props) { return null; }`,
      "/Use.tsx": `
        import { Untyped } from "./Untyped";
        export const Use = () => <Untyped message="a" />;
      `,
    });
    expect(inferStringPropNames(firstTag(project, "/Use.tsx")!)).toBeUndefined();
  });
});
