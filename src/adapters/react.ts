import * as crypto from "crypto";
import { parse } from "@babel/parser";
import _traverse, { NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import * as prettier from "prettier";
import {
  StringNode,
  StringKind,
  StringSignals,
  Verdict,
  SinkRegistry,
  UsedTranslationKey,
} from "../types";

// Babel ships ESM/CJS interop dance — unwrap default for runtime.
const traverse: typeof _traverse =
  (_traverse as any).default ?? (_traverse as any);
const generate: typeof _generate =
  (_generate as any).default ?? (_generate as any);

export interface Replacement {
  node: StringNode;
  keyName: string;
}

export interface ExtractResult {
  nodes: StringNode[];
  usedTranslationKeys: UsedTranslationKey[];
}

export interface Adapter {
  detect(filePath: string): boolean;
  extract(fileContent: string, filePath: string): ExtractResult;
  mutate(
    fileContent: string,
    replacements: Replacement[]
  ): Promise<string> | string;
}

const URL_SHAPE = /^(https?:\/\/|\/|\.\/|\.\.\/)/;
const PATH_SHAPE = /^[A-Za-z0-9_\-./]+$/;
const IDENT_SHAPE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const LOGGER_OBJECTS = new Set(["logger", "log", "winston", "pino"]);
const TEST_ASSERTION_METHODS = new Set([
  "toBe",
  "toEqual",
  "toContain",
  "toMatch",
  "toBeTruthy",
  "toBeFalsy",
]);
const TEST_ASSERTION_CALLEES = new Set(["expect", "assert"]);

// Foreign i18n conventions — constructs whose string content is ALREADY
// translated, so we must not re-wrap it (roadmap #9). Matched by name (these are
// highly distinctive; the same hardcoded-convention approach as the sets above).
// NOTE: deliberately excludes `t` — that's the convention TransLift produces.
//   - Calls: react-intl `formatMessage`/`defineMessages`/`defineMessage`,
//     vue-i18n `$t`, i18next `i18n.t` is already a translation callee.
//   - Components: react-intl `<FormattedMessage>`/`<FormattedHTMLMessage>`,
//     Lingui / react-i18next `<Trans>`.
const I18N_CALL_NAMES = new Set([
  "formatMessage",
  "defineMessages",
  "defineMessage",
  "$t",
]);
const I18N_COMPONENT_NAMES = new Set([
  "FormattedMessage",
  "FormattedHTMLMessage",
  "Trans",
]);

export class ReactAdapter implements Adapter {
  detect(filePath: string): boolean {
    // Scan plain `.ts`/`.js` too, not just JSX: real UI copy lives in
    // non-component modules (action definitions, constants, `contextItemLabel:`
    // objects). `.d.ts` is type-only — never UI copy — so it's excluded.
    if (/\.d\.ts$/.test(filePath)) return false;
    return /\.(tsx?|jsx?)$/.test(filePath);
  }

  extract(fileContent: string, filePath: string): ExtractResult {
    const ast = parse(fileContent, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });

    const lines = fileContent.split("\n");
    const nodes: StringNode[] = [];
    const usedTranslationKeys: UsedTranslationKey[] = [];

    const pushNode = (
      text: string,
      loc: { line: number; column: number },
      kind: StringKind,
      signals: StringSignals
    ) => {
      nodes.push({
        id: hashId(filePath, loc.line, loc.column, text),
        text,
        file: filePath,
        line: loc.line,
        column: loc.column,
        kind,
        signals,
        confidence: 0,
        verdict: Verdict.Skip,
        contextSnippet: buildContextSnippet(lines, loc.line),
      });
    };

    // A string literal that's the first arg of `t(...)` or `i18n.t(...)` is
    // a key already in use — record it and refuse to extract it again.
    // Returns true if recorded (caller should skip normal extraction).
    const recordIfTranslationKey = (
      stringValue: string,
      stringNode: t.Node,
      path: NodePath
    ): boolean => {
      const parent = path.parent;
      if (!t.isCallExpression(parent)) return false;
      if (parent.arguments[0] !== stringNode) return false;
      if (!isTranslationCallee(parent.callee)) return false;

      const loc = stringNode.loc?.start;
      if (loc) {
        usedTranslationKeys.push({
          keyName: stringValue,
          file: filePath,
          line: loc.line,
          column: loc.column + 1,
        });
      }
      return true;
    };

    traverse(ast, {
      JSXText: (path) => {
        const value = path.node.value;
        const trimmed = value.trim();
        if (!trimmed) return;
        const loc = path.node.loc?.start ?? { line: 1, column: 0 };
        const signals = buildSignals(path, trimmed, /* fromJsxText */ true);
        pushNode(
          trimmed,
          { line: loc.line, column: loc.column + 1 },
          StringKind.JsxText,
          signals
        );
      },

      StringLiteral: (path) => {
        // Skip strings inside TS type positions — they aren't runtime values.
        if (isInTypeContext(path)) return;

        // `t("key")` / `i18n.t("key")` — already translated, record and skip.
        if (recordIfTranslationKey(path.node.value, path.node, path)) return;

        const text = path.node.value;
        const loc = path.node.loc?.start ?? { line: 1, column: 0 };
        const kind = classifyStringLiteralKind(path);
        const signals = buildSignals(path, text, /* fromJsxText */ false);
        pushNode(
          text,
          { line: loc.line, column: loc.column + 1 },
          kind,
          signals
        );
      },

      TemplateLiteral: (path) => {
        if (isInTypeContext(path)) return;

        const isDynamic = path.node.expressions.length > 0;
        const loc = path.node.loc?.start ?? { line: 1, column: 0 };

        if (isDynamic) {
          // Dynamic key usages (e.g. t(`prefix.${x}`)) stay flagged as dynamic
          // templates — they are *not* recorded as used keys per the spec.
          const text = reconstructTemplateText(path.node);
          const signals = buildSignals(path, text, false);
          pushNode(
            text,
            { line: loc.line, column: loc.column + 1 },
            StringKind.TemplateLiteralDynamic,
            signals
          );
        } else {
          const text = path.node.quasis.map((q) => q.value.cooked ?? "").join("");
          if (!text) return;
          if (recordIfTranslationKey(text, path.node, path)) return;
          const signals = buildSignals(path, text, false);
          pushNode(
            text,
            { line: loc.line, column: loc.column + 1 },
            StringKind.TemplateLiteralStatic,
            signals
          );
        }
      },
    });

    return { nodes, usedTranslationKeys };
  }

  async mutate(
    fileContent: string,
    replacements: Replacement[]
  ): Promise<string> {
    if (replacements.length === 0) return fileContent;

    const ast = parse(fileContent, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      tokens: false,
    });

    // Index replacements by 1-indexed line:column so we can match AST nodes back.
    const byKey = new Map<string, Replacement>();
    for (const r of replacements) {
      byKey.set(locKey(r.node.line, r.node.column), r);
    }

    // Track which enclosing component functions need a `const { t } = useTranslation();`.
    const componentsNeedingHook = new Set<t.Node>();
    let hasReactI18nextImport = false;
    let hasUseTranslationImport = false;

    traverse(ast, {
      ImportDeclaration: (path) => {
        if (path.node.source.value === "react-i18next") {
          hasReactI18nextImport = true;
          const hasUseTranslation = path.node.specifiers.some(
            (s) =>
              t.isImportSpecifier(s) &&
              t.isIdentifier(s.imported) &&
              s.imported.name === "useTranslation"
          );
          if (hasUseTranslation) hasUseTranslationImport = true;
        }
      },

      JSXText: (path) => {
        const loc = path.node.loc?.start;
        if (!loc) return;
        const raw = path.node.value;
        const trimmed = raw.trim();
        if (!trimmed) return;
        const key = locKey(loc.line, loc.column + 1);
        const r = byKey.get(key);
        if (!r) return;

        // Preserve surrounding whitespace by splitting around the trimmed text.
        const leadingWs = raw.slice(0, raw.indexOf(trimmed));
        const trailingWs = raw.slice(raw.indexOf(trimmed) + trimmed.length);

        const replacement: (t.JSXText | t.JSXExpressionContainer)[] = [];
        if (leadingWs) replacement.push(t.jsxText(leadingWs));
        replacement.push(
          t.jsxExpressionContainer(
            t.callExpression(t.identifier("t"), [t.stringLiteral(r.keyName)])
          )
        );
        if (trailingWs) replacement.push(t.jsxText(trailingWs));

        path.replaceWithMultiple(replacement);
        markEnclosingComponent(path, componentsNeedingHook);
      },

      StringLiteral: (path) => {
        const loc = path.node.loc?.start;
        if (!loc) return;
        const key = locKey(loc.line, loc.column + 1);
        const r = byKey.get(key);
        if (!r) return;

        const tCall = t.callExpression(t.identifier("t"), [
          t.stringLiteral(r.keyName),
        ]);

        // If the literal is a JSX attribute value, wrap with {} container.
        if (t.isJSXAttribute(path.parent) && path.parent.value === path.node) {
          path.replaceWith(t.jsxExpressionContainer(tCall));
        } else {
          path.replaceWith(tCall);
        }
        markEnclosingComponent(path, componentsNeedingHook);
      },

      TemplateLiteral: (path) => {
        const loc = path.node.loc?.start;
        if (!loc) return;
        if (path.node.expressions.length > 0) return; // dynamic stays flagged
        const key = locKey(loc.line, loc.column + 1);
        const r = byKey.get(key);
        if (!r) return;

        const tCall = t.callExpression(t.identifier("t"), [
          t.stringLiteral(r.keyName),
        ]);
        path.replaceWith(tCall);
        markEnclosingComponent(path, componentsNeedingHook);
      },
    });

    // Inject `const { t } = useTranslation();` at the top of each touched component body.
    for (const fnNode of componentsNeedingHook) {
      injectUseTranslationHook(fnNode);
    }

    // Add the import if needed.
    if (componentsNeedingHook.size > 0 && !hasUseTranslationImport) {
      const importDecl = t.importDeclaration(
        [
          t.importSpecifier(
            t.identifier("useTranslation"),
            t.identifier("useTranslation")
          ),
        ],
        t.stringLiteral("react-i18next")
      );
      if (hasReactI18nextImport) {
        // Append to an existing import — handled by adding a fresh import for simplicity.
        ast.program.body.unshift(importDecl);
      } else {
        ast.program.body.unshift(importDecl);
      }
    }

    const generated = generate(ast, { retainLines: false, jsescOption: { minimal: true } }, fileContent);

    // Prettier resolves config from the file's directory when given filepath.
    const formatted = await prettier.format(generated.code, {
      parser: "babel-ts",
    });
    return formatted;
  }
}

// === Helpers ===

function hashId(file: string, line: number, column: number, text: string): string {
  return crypto
    .createHash("sha1")
    .update(`${file}:${line}:${column}:${text}`)
    .digest("hex")
    .slice(0, 12);
}

function buildContextSnippet(lines: string[], line: number): string {
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 1);
  return lines.slice(start, end).join("\n");
}

function locKey(line: number, column: number): string {
  return `${line}:${column}`;
}

function reconstructTemplateText(node: t.TemplateLiteral): string {
  let out = "";
  node.quasis.forEach((q, i) => {
    out += q.value.cooked ?? "";
    if (i < node.expressions.length) {
      const expr = node.expressions[i];
      if (t.isIdentifier(expr)) out += `\${${expr.name}}`;
      else out += "${...}";
    }
  });
  return out;
}

function classifyStringLiteralKind(path: NodePath<t.StringLiteral>): StringKind {
  const parent = path.parent;
  if (t.isJSXAttribute(parent)) return StringKind.JsxAttribute;
  if (t.isObjectProperty(parent) && parent.value === path.node) {
    return StringKind.ObjectProperty;
  }
  if (t.isCallExpression(parent) && parent.arguments.includes(path.node as any)) {
    return StringKind.CallArgument;
  }
  return StringKind.StringLiteral;
}

function isInTypeContext(path: NodePath): boolean {
  return !!path.findParent(
    (p) =>
      p.isTSTypeAnnotation() ||
      p.isTSLiteralType() ||
      p.isTSTypeAliasDeclaration() ||
      p.isTSInterfaceDeclaration() ||
      p.isTSTypeReference()
  );
}

function buildSignals(
  path: NodePath,
  text: string,
  fromJsxText: boolean
): StringSignals {
  const inJsxText = fromJsxText;

  // JSX attribute detection.
  let inJsxAttribute: string | null = null;
  let attributeElement: string | null = null;
  const attrPath = path.findParent((p) => p.isJSXAttribute()) as
    | NodePath<t.JSXAttribute>
    | null;
  if (attrPath) {
    const nameNode = attrPath.node.name;
    if (t.isJSXIdentifier(nameNode)) inJsxAttribute = nameNode.name;
    else if (t.isJSXNamespacedName(nameNode))
      inJsxAttribute = `${nameNode.namespace.name}:${nameNode.name.name}`;

    const openingPath = attrPath.findParent((p) => p.isJSXOpeningElement()) as
      | NodePath<t.JSXOpeningElement>
      | null;
    if (openingPath) {
      const elName = openingPath.node.name;
      if (t.isJSXIdentifier(elName)) attributeElement = elName.name;
      else if (t.isJSXMemberExpression(elName)) {
        attributeElement = jsxMemberExprToString(elName);
      }
    }
  }

  // Call expression ancestry checks.
  let inConsoleCall = false;
  let inLoggerCall = false;
  let inTestAssertion = false;
  let inImportPath = false;
  let enclosingI18n = false;
  let inFunctionSink: { name: string; argIndex: number } | null = null;

  // Direct parent: import declaration or require() call.
  const directParent = path.parent;
  if (t.isImportDeclaration(directParent)) inImportPath = true;
  if (
    t.isCallExpression(directParent) &&
    t.isIdentifier(directParent.callee) &&
    directParent.callee.name === "require"
  ) {
    inImportPath = true;
  }

  // Walk ancestors for call/throw context.
  let cursor: NodePath | null = path.parentPath;
  while (cursor) {
    if (cursor.isCallExpression()) {
      const callee = cursor.node.callee;

      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
        if (callee.object.name === "console") inConsoleCall = true;
        if (LOGGER_OBJECTS.has(callee.object.name)) inLoggerCall = true;
        if (
          t.isIdentifier(callee.property) &&
          TEST_ASSERTION_METHODS.has(callee.property.name)
        ) {
          inTestAssertion = true;
        }
      }
      if (t.isIdentifier(callee) && TEST_ASSERTION_CALLEES.has(callee.name)) {
        inTestAssertion = true;
      }

      // Foreign i18n call: `formatMessage({…})`, `intl.formatMessage(…)`,
      // `defineMessages({…})`. The callee is either a bare identifier or the
      // property of a member expression (`intl.formatMessage`).
      const calleeName = t.isIdentifier(callee)
        ? callee.name
        : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
          ? callee.property.name
          : null;
      if (calleeName && I18N_CALL_NAMES.has(calleeName)) enclosingI18n = true;

      // Function-sink match — only if the string is a direct argument of this call.
      if (!inFunctionSink) {
        const argIdx = findArgIndex(cursor.node, path.node);
        if (argIdx >= 0 && t.isIdentifier(callee)) {
          inFunctionSink = { name: callee.name, argIndex: argIdx };
        }
      }
    }
    cursor = cursor.parentPath;
  }

  const inThrowStatement = !!path.findParent((p) => p.isThrowStatement());

  // Foreign i18n component: the string is inside `<FormattedMessage …>` or
  // `<Trans>…</Trans>` — as an attribute (`defaultMessage=`) or as message
  // children. Either way it's already translated.
  if (!enclosingI18n) {
    const i18nEl = path.findParent(
      (p) =>
        p.isJSXElement() &&
        isI18nComponentName((p.node as t.JSXElement).openingElement.name)
    );
    if (i18nEl) enclosingI18n = true;
  }

  // URL / path shape.
  const inUrlShape =
    URL_SHAPE.test(text) ||
    (PATH_SHAPE.test(text) && text.includes("/") && !/\s/.test(text));

  const isCodeIdentifier = IDENT_SHAPE.test(text) && text.length < 25;

  // Prop name: StringLiteral → (JSXExpressionContainer) → JSXAttribute.
  let propName: string | null = null;
  if (attrPath) propName = inJsxAttribute;

  // Object-property key: `{ contextItemLabel: "Delete" }`. Only the DIRECT value
  // (immediate parent is the ObjectProperty) qualifies — a string buried in an
  // expression on the value side has a different parent and is left null.
  let objectPropertyKey: string | null = null;
  if (t.isObjectProperty(directParent) && directParent.value === path.node) {
    if (t.isIdentifier(directParent.key)) objectPropertyKey = directParent.key.name;
    else if (t.isStringLiteral(directParent.key)) objectPropertyKey = directParent.key.value;
  }

  // Enclosing component discovery.
  const { componentName, enclosingFunctionIsComponent } =
    findEnclosingComponent(path);

  return {
    inJsxText,
    inJsxAttribute,
    attributeElement,
    inConsoleCall,
    inLoggerCall,
    inThrowStatement,
    inTestAssertion,
    inImportPath,
    inUrlShape,
    isCodeIdentifier,
    propName,
    objectPropertyKey,
    enclosingI18n,
    componentName,
    enclosingFunctionIsComponent,
    inFunctionSink,
  };
}

function findArgIndex(call: t.CallExpression, node: t.Node): number {
  return call.arguments.findIndex((a) => a === node);
}

/** Match `t(...)` and `i18n.t(...)` — the i18n call shapes we treat as "already translated". */
function isTranslationCallee(callee: t.Node): boolean {
  if (t.isIdentifier(callee) && callee.name === "t") return true;
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object) &&
    callee.object.name === "i18n" &&
    t.isIdentifier(callee.property) &&
    callee.property.name === "t"
  ) {
    return true;
  }
  return false;
}

function jsxMemberExprToString(node: t.JSXMemberExpression): string {
  const parts: string[] = [];
  let cur: t.JSXMemberExpression | t.JSXIdentifier = node;
  while (t.isJSXMemberExpression(cur)) {
    parts.unshift(cur.property.name);
    cur = cur.object as any;
  }
  if (t.isJSXIdentifier(cur)) parts.unshift(cur.name);
  return parts.join(".");
}

/** Is this JSX element name a recognized foreign-i18n component? */
function isI18nComponentName(name: t.JSXOpeningElement["name"]): boolean {
  if (t.isJSXIdentifier(name)) return I18N_COMPONENT_NAMES.has(name.name);
  // `Intl.FormattedMessage` etc. — match on the final property.
  if (t.isJSXMemberExpression(name)) {
    return I18N_COMPONENT_NAMES.has(name.property.name);
  }
  return false;
}

function findEnclosingComponent(path: NodePath): {
  componentName: string | null;
  enclosingFunctionIsComponent: boolean;
} {
  const componentPath = findEnclosingComponentPath(path);
  if (!componentPath) {
    return { componentName: null, enclosingFunctionIsComponent: false };
  }
  return {
    componentName: functionDisplayName(componentPath),
    enclosingFunctionIsComponent: true,
  };
}

/**
 * Climb out through nested handlers/callbacks until we find a component-shaped
 * function: one whose declared name is PascalCase, or whose body returns JSX.
 * Returns null if no such ancestor exists (e.g. a string in a top-level helper).
 */
function findEnclosingComponentPath(path: NodePath): NodePath | null {
  let cursor: NodePath | null = path.getFunctionParent();
  while (cursor) {
    if (isComponentFunction(cursor)) return cursor;
    cursor = cursor.getFunctionParent();
  }
  return null;
}

function isComponentFunction(fnPath: NodePath): boolean {
  const name = functionDisplayName(fnPath);
  if (name && /^[A-Z]/.test(name)) return true;
  return functionReturnsJsx(fnPath);
}

function functionDisplayName(fnPath: NodePath): string | null {
  if (fnPath.isFunctionDeclaration() && fnPath.node.id) {
    return fnPath.node.id.name;
  }
  const parent = fnPath.parentPath;
  if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return null;
}

function functionReturnsJsx(fnPath: NodePath): boolean {
  const body = (fnPath.node as any).body;
  if (!body) return false;
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return true;

  let found = false;
  fnPath.traverse({
    ReturnStatement(p) {
      const arg = p.node.argument;
      if (arg && (t.isJSXElement(arg) || t.isJSXFragment(arg))) found = true;
    },
    // Don't descend into nested functions — their returns aren't ours.
    Function(p) {
      if (p !== fnPath) p.skip();
    },
  });
  return found;
}

function markEnclosingComponent(path: NodePath, set: Set<t.Node>) {
  const fnPath = findEnclosingComponentPath(path);
  if (!fnPath) return;
  set.add(fnPath.node);
}

function injectUseTranslationHook(fnNode: t.Node) {
  const hookStmt = t.variableDeclaration("const", [
    t.variableDeclarator(
      t.objectPattern([
        t.objectProperty(
          t.identifier("t"),
          t.identifier("t"),
          false,
          true
        ),
      ]),
      t.callExpression(t.identifier("useTranslation"), [])
    ),
  ]);

  const body = (fnNode as any).body;
  if (t.isBlockStatement(body)) {
    // Don't double-insert.
    const already = body.body.some(
      (stmt) =>
        t.isVariableDeclaration(stmt) &&
        stmt.declarations.some(
          (d) =>
            t.isCallExpression(d.init) &&
            t.isIdentifier(d.init.callee) &&
            d.init.callee.name === "useTranslation"
        )
    );
    if (!already) body.body.unshift(hookStmt);
  } else if (t.isExpression(body)) {
    // Arrow with expression body → wrap in block.
    (fnNode as any).body = t.blockStatement([hookStmt, t.returnStatement(body)]);
  }
}
