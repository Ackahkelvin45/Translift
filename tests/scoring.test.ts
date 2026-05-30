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
    objectPropertyKey: null,
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

describe("score — #2 IDENT_SHAPE: registered sink beats the identifier skip", () => {
  const notifyReg: SinkRegistry = {
    components: [],
    attributes: [],
    functions: [{ name: "notify", uiArgs: [0] }],
  };

  it("wraps an identifier-shaped string when it's a registered function-sink arg", () => {
    // "Saved" matches IDENT_SHAPE (isCodeIdentifier). Pre-fix it was hard-skipped
    // before the function-sink check ever ran — the silent miss this fixes.
    const r = score(
      mkNode("Saved", StringKind.CallArgument, {
        isCodeIdentifier: true,
        inFunctionSink: { name: "notify", argIndex: 0 },
      }),
      notifyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("function-sink");
  });

  it("still skips an identifier-shaped string that is NOT a registered sink", () => {
    const r = score(
      mkNode("Config", StringKind.StringLiteral, { isCodeIdentifier: true }),
      notifyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
    expect(r.source).toBeUndefined();
  });

  it("console.log still wins over a registered sink (decisive non-UI skip stays on top)", () => {
    const r = score(
      mkNode("Saved", StringKind.CallArgument, {
        inConsoleCall: true,
        inFunctionSink: { name: "notify", argIndex: 0 },
      }),
      notifyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("a dynamic template in a sink arg is still flagged, not wrapped", () => {
    const r = score(
      mkNode("Saved ${x}", StringKind.TemplateLiteralDynamic, {
        inFunctionSink: { name: "notify", argIndex: 0 },
      }),
      notifyReg
    );
    expect(r.verdict).toBe(Verdict.FlagDynamic);
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

describe("score — attribute-sink IDENT_SHAPE twin (registered attr beats the identifier skip)", () => {
  const ariaReg: SinkRegistry = {
    components: [],
    attributes: [{ name: "aria-label" }],
    functions: [],
  };

  it("wraps an identifier-shaped DIRECT attribute value in a registered sink", () => {
    // `aria-label="Shade"` — "Shade" is identifier-shaped, so pre-fix the
    // isCodeIdentifier skip fired before the attribute-sink check (the silent
    // miss i18next-cli caught). The string is the direct value (kind=JsxAttribute).
    const r = score(
      mkNode("Shade", StringKind.JsxAttribute, {
        isCodeIdentifier: true,
        inJsxAttribute: "aria-label",
        attributeElement: "div",
      }),
      ariaReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("attribute-sink");
  });

  it("still SKIPS an identifier-shaped string buried in the attribute expression", () => {
    // `title={shape === "rectangle" ? … }` — "rectangle" carries inJsxAttribute
    // (the signal walks to any JSX ancestor) but it's a comparison operand, NOT
    // the attribute's text (kind=StringLiteral). Wrapping it would be a false
    // positive. The identifier skip must still claim it.
    const r = score(
      mkNode("rectangle", StringKind.StringLiteral, {
        isCodeIdentifier: true,
        inJsxAttribute: "aria-label",
        attributeElement: "button",
      }),
      ariaReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
    expect(r.source).toBeUndefined();
  });

  it("still SKIPS an identifier-shaped DIRECT value when the attr is NOT registered", () => {
    const r = score(
      mkNode("Shade", StringKind.JsxAttribute, {
        isCodeIdentifier: true,
        inJsxAttribute: "data-mode", // not in the registry
        attributeElement: "div",
      }),
      ariaReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("preserves the notOnElements block path for a direct value", () => {
    const blockedReg: SinkRegistry = {
      components: [],
      attributes: [{ name: "aria-label", notOnElements: ["svg"] }],
      functions: [],
    };
    const r = score(
      mkNode("Decorative", StringKind.JsxAttribute, {
        inJsxAttribute: "aria-label",
        attributeElement: "svg",
      }),
      blockedReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("still wraps a NON-identifier string buried in a registered attribute (baseline preserved)", () => {
    // e.g. `title={t("toolBar.rectangle")}` — not identifier-shaped (has a dot),
    // so it wrapped before this fix and must keep doing so (out of scope here).
    const r = score(
      mkNode("toolBar.rectangle", StringKind.CallArgument, {
        inJsxAttribute: "aria-label",
        attributeElement: "button",
      }),
      ariaReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("attribute-sink");
  });
});

describe("score — gated object-property sinks (real-codebase recall)", () => {
  it("wraps an identifier-shaped value under a copy-bearing key (contextItemLabel)", () => {
    // `contextItemLabel: "Delete"` — "Delete" is identifier-shaped, so without
    // this branch it dies on the IDENT_SHAPE skip (the dominant recall miss on
    // pre-i18n Excalidraw). Key matches the `*Label` suffix.
    const r = score(
      mkNode("Delete", StringKind.ObjectProperty, {
        isCodeIdentifier: true,
        objectPropertyKey: "contextItemLabel",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("object-property-sink");
  });

  it("wraps a multi-word label under a copy-bearing key (label)", () => {
    const r = score(
      mkNode("Send to Back", StringKind.ObjectProperty, {
        objectPropertyKey: "label",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("object-property-sink");
  });

  it("does NOT wrap a structural/code key (type)", () => {
    const r = score(
      mkNode("rectangle", StringKind.ObjectProperty, {
        isCodeIdentifier: true,
        objectPropertyKey: "type",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
    expect(r.source).toBeUndefined();
  });

  it("does NOT wrap a sibling code `value` next to a copy-bearing `text`", () => {
    // `{ value: "Helvetica", text: "Normal" }` — only `text` carries copy.
    const r = score(
      mkNode("Helvetica", StringKind.ObjectProperty, {
        isCodeIdentifier: true,
        objectPropertyKey: "value",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("only fires for the DIRECT property value, not a string buried in the value expression", () => {
    // `{ label: cond ? "Copy" : "Cut" }` — "Copy" is a conditional operand, so
    // the adapter leaves objectPropertyKey null (kind is StringLiteral). It must
    // still hit the identifier skip, not the object-property sink.
    const r = score(
      mkNode("Copy", StringKind.StringLiteral, {
        isCodeIdentifier: true,
        objectPropertyKey: null,
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
    expect(r.source).toBeUndefined();
  });

  it("does NOT wrap a translation-key-shaped value under label (value-shape guard)", () => {
    // `label: "labels.alignTop"` — the value is already a key; wrapping it would
    // double-key it. Drove ~77 false positives on current Excalidraw.
    const r = score(
      mkNode("labels.alignTop", StringKind.ObjectProperty, {
        objectPropertyKey: "label",
      }),
      emptyReg
    );
    expect(r.verdict).not.toBe(Verdict.Wrap);
  });

  it("does NOT treat the data-polysemous `text` key as a sink", () => {
    // Object `text:` overwhelmingly holds element content / data, not UI copy
    // (50 FPs on Excalidraw). Excluded from the object-key set by design — the
    // recall cost is a couple of font-option labels, deemed worth it.
    const r = score(
      mkNode("Start", StringKind.ObjectProperty, {
        isCodeIdentifier: true,
        objectPropertyKey: "text",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Skip);
  });

  it("does NOT treat the data-polysemous `title` key as a sink", () => {
    const r = score(
      mkNode("Player A", StringKind.ObjectProperty, {
        objectPropertyKey: "title",
      }),
      emptyReg
    );
    expect(r.verdict).not.toBe(Verdict.Wrap);
  });

  it("wraps real copy under the message family", () => {
    const r = score(
      mkNode("Couldn't enter fullscreen", StringKind.ObjectProperty, {
        objectPropertyKey: "errorMessage",
      }),
      emptyReg
    );
    expect(r.verdict).toBe(Verdict.Wrap);
    expect(r.source).toBe("object-property-sink");
  });
});

describe("score — SVG/CSS value-shape skip (real-codebase false positives)", () => {
  // Each value sat in a JSX attribute and was reaching a Wrap verdict. The
  // value-shape penalty (-0.6) plus the structural prop-name penalty keep them
  // out of the Wrap band. `customThing` is a generic (unblocklisted) prop so the
  // value shape is the decisive signal under test.
  const cases: Array<[string, string]> = [
    ["M39.9 32.889a.326.326 0 0 0-.279-.056c-2.094-3.083", "d"],
    ["0 0 40 40", "viewBox"],
    ["0 0 450 55", "viewBox"],
    ["translate(-144.023 -51.76)", "transform"],
    ["var(--icon-size, 1rem)", "size"],
  ];

  for (const [value, prop] of cases) {
    it(`does not wrap ${prop}="${value.slice(0, 24)}…"`, () => {
      const r = score(
        mkNode(value, StringKind.JsxAttribute, {
          enclosingFunctionIsComponent: true,
          componentName: "Icon",
          inJsxAttribute: "customThing",
        }),
        emptyReg
      );
      expect(r.verdict).not.toBe(Verdict.Wrap);
    });
  }

  it("does NOT penalize a real sentence that merely starts with a capital letter", () => {
    // Guard: the value-shape heuristic must not catch ordinary copy.
    const r = score(
      mkNode("Move element to front", StringKind.JsxAttribute, {
        enclosingFunctionIsComponent: true,
        inJsxAttribute: "aria-label",
      }),
      { components: [], attributes: [{ name: "aria-label" }], functions: [] }
    );
    expect(r.verdict).toBe(Verdict.Wrap);
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
