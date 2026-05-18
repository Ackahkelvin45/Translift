import { StringNode, StringKind, Verdict, SinkRegistry } from "./types";

// Confidence thresholds. Tuned against Phase 0 fixtures; revisit as the corpus grows.
const HIGH_CONFIDENCE = 0.75;
const LOW_CONFIDENCE = 0.25;

export function score(
  node: StringNode,
  registry: SinkRegistry
): { confidence: number; verdict: Verdict } {
  const s = node.signals;

  // Hard skips — decisive non-UI signals.
  if (s.inConsoleCall) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inLoggerCall) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inTestAssertion) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inImportPath) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.inUrlShape) return { confidence: 1.0, verdict: Verdict.Skip };
  if (s.isCodeIdentifier && !s.inJsxText) {
    return { confidence: 0.9, verdict: Verdict.Skip };
  }

  // Hard wraps — decisive UI signals.
  if (s.inJsxText && node.kind === StringKind.JsxText) {
    return { confidence: 1.0, verdict: Verdict.Wrap };
  }

  // Dynamic template literals — surface to developer.
  if (node.kind === StringKind.TemplateLiteralDynamic) {
    return { confidence: 1.0, verdict: Verdict.FlagDynamic };
  }

  // Attribute sinks.
  if (s.inJsxAttribute) {
    const attrSink = registry.attributes.find(a => a.name === s.inJsxAttribute);
    if (attrSink) {
      const element = s.attributeElement ?? "";
      const blocked = attrSink.notOnElements?.includes(element) ?? false;
      const allowed = attrSink.onElements
        ? attrSink.onElements.includes(element)
        : true;
      if (allowed && !blocked) return { confidence: 0.95, verdict: Verdict.Wrap };
      if (blocked) return { confidence: 0.9, verdict: Verdict.Skip };
    }
  }

  // Function call sinks.
  if (s.inFunctionSink) {
    const fnSink = registry.functions.find(f => f.name === s.inFunctionSink!.name);
    if (fnSink) {
      const argMatch =
        fnSink.uiArgs === "all" || fnSink.uiArgs.includes(s.inFunctionSink.argIndex);
      if (argMatch) return { confidence: 0.95, verdict: Verdict.Wrap };
    }
  }

  // Weighted scoring for ambiguous strings. Coefficients are priors, not measurements.
  let weighted = 0;

  if (s.enclosingFunctionIsComponent) weighted += 0.3;
  if (s.componentName) weighted += 0.1;
  if (s.inJsxAttribute) weighted += 0.2;
  if (node.text.length > 3 && /\s/.test(node.text)) weighted += 0.2;
  if (/^[A-Z]/.test(node.text)) weighted += 0.05;
  if (/[.!?]$/.test(node.text)) weighted += 0.1;

  if (s.inThrowStatement) weighted -= 0.2;
  if (node.text.length < 4) weighted -= 0.2;
  if (/^[a-z][a-zA-Z]*$/.test(node.text)) weighted -= 0.2;
  if (/^[A-Z_]+$/.test(node.text)) weighted -= 0.3;
  if (/^\d+$/.test(node.text)) weighted -= 0.5;

  weighted = Math.max(0, Math.min(1, weighted));

  if (weighted >= HIGH_CONFIDENCE) {
    return { confidence: weighted, verdict: Verdict.Wrap };
  }
  if (weighted <= LOW_CONFIDENCE) {
    return { confidence: 1 - weighted, verdict: Verdict.Skip };
  }
  return { confidence: weighted, verdict: Verdict.Escalate };
}
