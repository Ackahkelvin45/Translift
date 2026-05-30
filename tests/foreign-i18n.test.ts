import { describe, expect, it } from "vitest";
import { run } from "../src/pipeline";
import { Verdict } from "../src/types";

// End-to-end (#9): real foreign-i18n constructs must be recognized as
// already-translated and left alone, while genuine hardcoded copy in the same
// file is still found.
const SRC = `
import React from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Trans } from "@lingui/react";

const messages = defineMessages({
  greeting: { id: "app.greeting", defaultMessage: "Hello there" },
});

export function Panel() {
  const { formatMessage } = useIntl();
  return (
    <div>
      <FormattedMessage id="app.title" defaultMessage="Welcome to the app" />
      <Trans>Translated children here</Trans>
      <input placeholder={formatMessage({ id: "app.search", defaultMessage: "Search items" })} />
      <button aria-label="Genuine hardcoded label">Click me now</button>
    </div>
  );
}
`;

describe("#9 foreign-i18n recognition (end-to-end via run())", () => {
  it("does not wrap strings inside react-intl / Lingui constructs", async () => {
    const res = await run("/virtual/Panel.tsx", SRC, { dryRun: true });
    const wrapped = new Set(res.wrapped.map((r) => r.node.text));
    const verdictOf = (text: string) =>
      res.nodes.find((n) => n.text === text)?.verdict;

    // react-intl defaultMessage (component attr + formatMessage object) → skip
    expect(wrapped.has("Welcome to the app")).toBe(false);
    expect(verdictOf("Welcome to the app")).toBe(Verdict.Skip);
    expect(wrapped.has("Search items")).toBe(false);
    expect(verdictOf("Search items")).toBe(Verdict.Skip);
    // defineMessages value → skip
    expect(wrapped.has("Hello there")).toBe(false);
    // Lingui <Trans> children → skip
    expect(wrapped.has("Translated children here")).toBe(false);
    expect(verdictOf("Translated children here")).toBe(Verdict.Skip);
    // message ids never wrap
    expect(wrapped.has("app.title")).toBe(false);
    expect(wrapped.has("app.search")).toBe(false);
  });

  it("still finds genuine hardcoded copy in the same file (recall preserved)", async () => {
    const res = await run("/virtual/Panel.tsx", SRC, { dryRun: true });
    const wrapped = new Set(res.wrapped.map((r) => r.node.text));
    // Plain JSX text and a real aria-label are NOT inside any i18n construct.
    expect(wrapped.has("Click me now")).toBe(true);
    expect(wrapped.has("Genuine hardcoded label")).toBe(true);
  });
});

// Lingui MACRO forms — the dominant real-world Lingui style (proven by the
// Bluesky benchmark: `_(msg`…`)` outnumbers `<Trans>` there). The original #9
// guard recognized only `<Trans>`, so all three of these shapes re-wrapped
// already-translated text — and the tagged-template form additionally CRASHED
// `mutate` (a `replaceWith(callExpression)` on a TaggedTemplateExpression
// `.quasi` violates a babel AST invariant). Regression corpus drawn from real
// Bluesky source shapes.
const LINGUI_MACRO_SRC = `
import React from "react";
import { msg, Plural } from "@lingui/macro";
import { useLingui } from "@lingui/react";

export function Settings() {
  const { _ } = useLingui();
  return (
    <View>
      {/* tagged-template macro, runtime-wrapped — the crash + FP case */}
      <Toggle.Item label={_(msg\`Require alt text before posting\`)} name="alt" />
      {/* descriptor-CALL macro with message/context object keys */}
      <Toggle.Item
        label={_(msg({ context: "icon variant", message: "Light" }))}
        name="light"
      />
      {/* Lingui plural JSX component — one/other hold translated forms */}
      <Plural value={n} one="# contact found" other="# contacts found" />
      {/* genuine hardcoded copy in the same file — recall must survive */}
      <Toggle.Item label="Receive push notifications" name="push" />
    </View>
  );
}
`;

describe("Lingui macro forms (Bluesky regression corpus)", () => {
  it("does not wrap strings inside Lingui macro / plural constructs", async () => {
    const res = await run("/virtual/Settings.tsx", LINGUI_MACRO_SRC, {
      dryRun: true,
    });
    const wrapped = new Set(res.wrapped.map((r) => r.node.text));
    const verdictOf = (text: string) =>
      res.nodes.find((n) => n.text === text)?.verdict;

    // tagged-template macro `_(msg`…`)`
    expect(wrapped.has("Require alt text before posting")).toBe(false);
    expect(verdictOf("Require alt text before posting")).toBe(Verdict.Skip);
    // descriptor-call macro `msg({ message, context })`
    expect(wrapped.has("Light")).toBe(false);
    expect(wrapped.has("icon variant")).toBe(false);
    // <Plural one/other>
    expect(wrapped.has("# contact found")).toBe(false);
    expect(wrapped.has("# contacts found")).toBe(false);
  });

  it("still finds genuine hardcoded copy alongside Lingui macros", async () => {
    const res = await run("/virtual/Settings.tsx", LINGUI_MACRO_SRC, {
      dryRun: true,
    });
    const wrapped = new Set(res.wrapped.map((r) => r.node.text));
    expect(wrapped.has("Receive push notifications")).toBe(true);
  });

  it("mutate does not crash on a `msg`…`` tagged template (babel quasi invariant)", async () => {
    // The original bug: extract threw `TypeError: Property quasi of
    // TaggedTemplateExpression expected node to be of a type ["TemplateLiteral"]`
    // and aborted the whole run. A non-dry-run pass must complete and leave the
    // already-translated macro text untouched in the output.
    const res = await run("/virtual/Settings.tsx", LINGUI_MACRO_SRC, {
      dryRun: false,
    });
    expect(res.modifiedContent).toBeDefined();
    const out = res.modifiedContent ?? "";
    // The macro text is still inside `msg` — NOT double-wrapped in `t(...)`.
    expect(out).toContain("Require alt text before posting");
    expect(out).not.toMatch(/t\(["'][^"']*Require alt text/);
  });
});
