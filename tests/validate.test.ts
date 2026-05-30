import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  validateStringNodes,
} from "../src/validate";
import {
  StringKind,
  StringNode,
  StringSignals,
  Verdict,
} from "../src/types";

function validSignals(): StringSignals {
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
    enclosingI18n: false,
    componentName: null,
    enclosingFunctionIsComponent: false,
    inFunctionSink: null,
  };
}

function validNode(overrides: Partial<StringNode> = {}): StringNode {
  return {
    id: "abc",
    text: "Hi",
    file: "/a.tsx",
    line: 1,
    column: 0,
    kind: StringKind.StringLiteral,
    signals: validSignals(),
    confidence: 0.5,
    verdict: Verdict.Skip,
    contextSnippet: "",
    ...overrides,
  };
}

describe("validateStringNodes — happy path", () => {
  it("accepts an empty array", () => {
    expect(() => validateStringNodes([], "/a.tsx")).not.toThrow();
  });

  it("accepts a well-formed StringNode", () => {
    expect(() => validateStringNodes([validNode()], "/a.tsx")).not.toThrow();
  });

  it("accepts optional confidenceSource of any valid variant", () => {
    expect(() =>
      validateStringNodes(
        [
          validNode({ verdict: Verdict.Wrap, confidenceSource: "jsx-text" }),
          validNode({ verdict: Verdict.Wrap, confidenceSource: "traced" }),
        ],
        "/a.tsx"
      )
    ).not.toThrow();
  });
});

describe("validateStringNodes — rejects malformed input", () => {
  it("non-array input throws", () => {
    expect(() => validateStringNodes("nope" as unknown, "/a.tsx")).toThrow(
      SchemaValidationError
    );
  });

  it("missing required field reports which field", () => {
    const broken = { ...validNode() } as Partial<StringNode>;
    delete broken.text;
    expect(() => validateStringNodes([broken], "/a.tsx")).toThrow(/text/);
  });

  it("wrong type on numeric field reports clearly", () => {
    const broken = validNode({ line: "not a number" as unknown as number });
    expect(() => validateStringNodes([broken], "/a.tsx")).toThrow(/line/);
  });

  it("invalid verdict value rejected", () => {
    const broken = validNode({ verdict: "BOGUS" as Verdict });
    expect(() => validateStringNodes([broken], "/a.tsx")).toThrow(/verdict/);
  });

  it("invalid confidenceSource value rejected", () => {
    const broken = validNode({
      verdict: Verdict.Wrap,
      confidenceSource: "imaginary" as never,
    });
    expect(() => validateStringNodes([broken], "/a.tsx")).toThrow(
      /confidenceSource/
    );
  });

  it("malformed signals.inFunctionSink rejected with field name", () => {
    const broken = validNode({
      signals: {
        ...validSignals(),
        inFunctionSink: { name: "toast" } as never, // missing argIndex
      },
    });
    expect(() => validateStringNodes([broken], "/a.tsx")).toThrow(
      /inFunctionSink/
    );
  });

  it("error message names the file path and index", () => {
    const broken = [validNode(), validNode({ line: NaN })];
    let err: Error | null = null;
    try {
      validateStringNodes(broken, "/x.tsx");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err!.message).toContain("/x.tsx");
    expect(err!.message).toContain("#1"); // second index
  });
});
