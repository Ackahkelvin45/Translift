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
