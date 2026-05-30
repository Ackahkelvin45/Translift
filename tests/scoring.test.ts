import { describe, expect, it } from "vitest";
import { score } from "../src/scoring";
import {
  SinkRegistry,
  StringKind,
  StringNode,
  StringSignals,
  Verdict,
} from "../src/types";

function emptySignals(overrides: Partial<StringSignals> = {}): StringSignals {
  return {
    inJsxText: false,
    inJsxAttribute: null,
    attributeElement: null,
    inConsoleCall: false,
    inLoggerCall: false,
    inThrowStatement: false,
    inTestAssertion: false,
    inImportPath: false,
    inUrlShape: false,
    isCodeIdentifier: false,
    propName: null,
    componentName: null,
    enclosingFunctionIsComponent: false,
    inFunctionSink: null,
    ...overrides,
  };
}

function mkNode(
  text: string,
  kind: StringKind,
  signals: Partial<StringSignals> = {}
): StringNode {
  return {
    id: "n",
    text,
    file: "/a.tsx",
    line: 1,
    column: 0,
    kind,
    signals: emptySignals(signals),
    confidence: 0,
    verdict: Verdict.Skip,
    contextSnippet: "",
  };
}

const emptyReg: SinkRegistry = {
  components: [],
  attributes: [],
  functions: [],
};

describe("score — confidence source for hard-rule wraps", () => {
  it("JSX text → source: jsx-text", () => {
    const r = score(mkNode("Hello", StringKind.JsxText, { inJsxText: true }), emptyReg);
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("jsx-text");
  });

  it("attribute sink match → source: attribute-sink", () => {
    const reg: SinkRegistry = {
      components: [],
      attributes: [{ name: "aria-label" }],
      functions: [],
    };
    const r = score(
      mkNode("Open menu", StringKind.JsxAttribute, {
        inJsxAttribute: "aria-label",
        attributeElement: "button",
      }),
      reg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("attribute-sink");
  });

  it("function sink match → source: function-sink", () => {
    const reg: SinkRegistry = {
      components: [],
      attributes: [],
      functions: [{ name: "toast", uiArgs: [0] }],
    };
    const r = score(
      mkNode("Saved", StringKind.CallArgument, {
        inFunctionSink: { name: "toast", argIndex: 0 },
      }),
      reg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("function-sink");
  });
});

describe("score — confidence source for weighted wraps", () => {
  it("Pass 1 weighted-score Wrap → source: weighted", () => {
    // Long, sentence-shaped, capitalized, inside a component, period at end.
    // Boosts: enclosingFunctionIsComponent +0.3, has-space +0.2, capitalized +0.05, period +0.1 = 0.65 (Escalate).
    // componentName +0.1 and the F7 UI-copy prop boost for `title` (+0.35) push
    // it past HIGH_CONFIDENCE (0.75) → clamped Wrap. (emptyReg here, so `title`
    // is not a registered attribute sink and falls through to weighted.)
    const r = score(
      mkNode("Welcome to TransLift!", StringKind.StringLiteral, {
        enclosingFunctionIsComponent: true,
        componentName: "App",
        inJsxAttribute: "title",  // unregistered attribute → boosts weighted, not direct
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("weighted");
  });
});

describe("score — F7 prop-name heuristics (P4)", () => {
  it("boosts a UI-copy prop name toward Wrap", () => {
    // +0.3 component +0.35 (label, F7) +0.2 space +0.05 cap = 0.9 → Wrap.
    const r = score(
      mkNode("Reset the zoom level", StringKind.JsxAttribute, {
        enclosingFunctionIsComponent: true,
        inJsxAttribute: "label", // not a registered attribute sink (emptyReg)
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("weighted");
  });

  it("recognizes the *Label / *Message suffix convention", () => {
    const r = score(
      mkNode("Reset the zoom level", StringKind.JsxAttribute, {
        enclosingFunctionIsComponent: true,
        inJsxAttribute: "buttonLabel",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
  });

  it("penalizes structural prop names down to Skip", () => {
    // +0.3 component -0.3 (className, F7) +0.2 space = 0.2 → Skip.
    const r = score(
      mkNode("some flex layout wrapper", StringKind.JsxAttribute, {
        enclosingFunctionIsComponent: true,
        inJsxAttribute: "className",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("leaves an unknown/generic prop at the pre-F7 +0.2 (Escalate band)", () => {
    // +0.2 generic attr +0.2 space +0.05 cap = 0.45 → Escalate.
    const r = score(
      mkNode("Reset zoom now", StringKind.JsxAttribute, {
        inJsxAttribute: "customThing",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Escalate);
  });
});

describe("score — non-wrap verdicts have no source", () => {
  it("Skip has no source", () => {
    const r = score(
      mkNode("console", StringKind.StringLiteral, { inConsoleCall: true }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
    expect(r.source).toBeUndefined();
  });

  it("FlagDynamic has no source", () => {
    const r = score(
      mkNode("Hi ${x}", StringKind.TemplateLiteralDynamic),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.FlagDynamic);
    expect(r.source).toBeUndefined();
  });

  it("Escalate has no source (Pass 2 will assign 'traced' if it resolves)", () => {
    // Boosts: enclosingFunctionIsComponent +0.3, has-space +0.2, period +0.1 = 0.6 (Escalate band).
    const r = score(
      mkNode("Some message here.", StringKind.StringLiteral, {
        enclosingFunctionIsComponent: true,
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Escalate);
    expect(r.source).toBeUndefined();
  });
});
