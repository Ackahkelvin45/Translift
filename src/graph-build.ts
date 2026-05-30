/**
 * Sub-step 3b — per-file extraction.
 *
 * Walks one source file via ts-morph and contributes nodes + intra-file edges
 * to a `ProjectGraph`. Cross-file `imports` edges are added later by
 * `graph-stitch.ts` (sub-step 3c).
 *
 * Design notes:
 *
 * - Two descendant walks: first emit nodes, then emit edges. The split lets
 *   edge emitters look up nodes by id without ordering dependencies.
 * - Edges only fire when both endpoints are graph-node-shaped (string literals
 *   or identifier references that resolve to a declared symbol). Calls,
 *   templates with interpolations, object literals, etc. are not "origins" —
 *   they don't flow into the four tracked edges.
 * - `passed_as_arg` lands on the call-expression node, not the callee's body.
 *   Per the spec, the BFS in Pass 2 terminates when the call-expression matches
 *   a registered function sink; we never traverse into the callee.
 */
import {
  CallExpression,
  Identifier,
  JsxAttribute,
  JsxOpeningElement,
  JsxSelfClosingElement,
  Node,
  ReturnStatement,
  SourceFile,
  SyntaxKind,
  VariableDeclaration,
} from "ts-morph";
import {
  CallExpressionNode,
  GraphNode,
  JsxElementNode,
  ModuleNode,
  ProjectGraph,
  StringLiteralNode,
  SymbolNode,
  nodeId,
} from "./graph";

export function buildFileGraph(sf: SourceFile, graph: ProjectGraph): void {
  const filePath = sf.getFilePath();

  // Module node — one per file, anchored at offset 0.
  graph.addNode({
    id: nodeId(filePath, 0),
    type: "module",
    file: filePath,
    line: 1,
    column: 0,
  });

  // Pass A — emit every node before any edge so edge emitters can look up by id.
  sf.forEachDescendant((node) => {
    addNodeIfRelevant(node, graph);
  });

  // Pass B — emit intra-file edges.
  sf.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) addAssignedToEdge(node, graph);
    else if (Node.isCallExpression(node)) addPassedAsArgEdges(node, graph);
    else if (Node.isJsxAttribute(node)) addPassedAsPropEdge(node, graph);
    else if (Node.isReturnStatement(node)) addReturnedFromEdge(node, graph);
    else if (Node.isArrowFunction(node)) addImplicitReturnEdge(node, graph);
  });
}

/* -------------------------------------------------------------------------- */
/* Pass A — node emission                                                     */
/* -------------------------------------------------------------------------- */

function addNodeIfRelevant(node: Node, graph: ProjectGraph): void {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const n: StringLiteralNode = {
      ...locOf(node),
      id: idOf(node),
      type: "string-literal",
      text: node.getLiteralText(),
    };
    graph.addNode(n);
    return;
  }

  if (Node.isJsxText(node)) {
    const text = node.getText().trim();
    if (text.length === 0) return; // Whitespace-only JSX text is not a string.
    const n: StringLiteralNode = {
      ...locOf(node),
      id: idOf(node),
      type: "string-literal",
      text,
    };
    graph.addNode(n);
    return;
  }

  if (Node.isVariableDeclaration(node)) {
    const sym = symbolNodeForVariable(node);
    if (sym) graph.addNode(sym);
    return;
  }

  if (Node.isFunctionDeclaration(node)) {
    const name = node.getNameNode();
    if (!name) return; // anonymous declarations have no symbol node
    const text = name.getText();
    if (text === "") return; // parser-tolerated anonymous form
    graph.addNode({
      ...locOf(name),
      id: idOf(name),
      type: "symbol",
      name: text,
    });
    return;
  }

  if (Node.isParameterDeclaration(node)) {
    const name = node.getNameNode();
    if (!name.isKind(SyntaxKind.Identifier)) return; // skip destructured params
    const text = name.getText();
    if (text === "") return;
    graph.addNode({
      ...locOf(name),
      id: idOf(name),
      type: "symbol",
      name: text,
    });
    return;
  }

  if (Node.isCallExpression(node)) {
    const meta = resolveSymbolMetadata(node.getExpression());
    const n: CallExpressionNode = {
      ...locOf(node),
      id: idOf(node),
      type: "call-expression",
      calleeName: calleeNameOf(node),
      calleeResolvedName: meta.resolvedName,
      calleeDeclarationFile: meta.declarationFile,
      calleeImportSpecifier: meta.importSpecifier,
    };
    graph.addNode(n);
    return;
  }

  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    const tagNode = node.getTagNameNode();
    const meta = resolveSymbolMetadata(tagNode);
    const n: JsxElementNode = {
      ...locOf(node),
      id: idOf(node),
      type: "jsx-element",
      tagName: tagNode.getText(),
      tagResolvedName: meta.resolvedName,
      tagDeclarationFile: meta.declarationFile,
      tagImportSpecifier: meta.importSpecifier,
    };
    graph.addNode(n);
    return;
  }
}

export interface SymbolMetadata {
  resolvedName?: string;
  declarationFile?: string;
  importSpecifier?: string;
}

/**
 * For an identifier reference (callee expression or JSX tag), pull everything
 * we know about its underlying symbol in one pass:
 *
 * - `resolvedName`: the canonical exported name after alias-chasing — so
 *   `showToast` (aliased from `toast` in `react-hot-toast`) resolves to `toast`.
 *   Equal to the source-code name when no aliasing happened.
 * - `declarationFile`: absolute path of the original declaration's source file.
 *   `undefined` for `node_modules` declarations (treated as external).
 * - `importSpecifier`: the literal module specifier (e.g. `"react-hot-toast"`)
 *   that brought the symbol into the consumer file. `undefined` for locally-
 *   declared symbols.
 *
 * Returns an empty object when the reference isn't a plain identifier (or a
 * resolvable property access). Callers should treat empty as "no metadata
 * known; constraint-style sink checks must skip gracefully."
 */
export function resolveSymbolMetadata(expr: Node): SymbolMetadata {
  if (!Node.isIdentifier(expr)) {
    if (Node.isPropertyAccessExpression(expr)) {
      // `obj.method(...)` — the importable thing is `obj`. Resolve from there.
      const obj = expr.getExpression();
      if (Node.isIdentifier(obj)) return resolveSymbolMetadata(obj);
    }
    return {};
  }
  const sym = expr.getSymbol();
  if (!sym) return {};

  // Walk to the canonical export to get the "resolved" name.
  const original = chaseAlias(sym);
  const originalDecl = original.getDeclarations()[0];
  if (!originalDecl) return {};

  const file = originalDecl.getSourceFile().getFilePath();
  const declarationFile = file.includes("/node_modules/") ? undefined : file;
  const resolvedName = original.getName();

  // The LOCAL declaration (before chasing) tells us *how* the symbol got into
  // the consumer file. If it's an ImportSpecifier / ImportClause / NamespaceImport,
  // walking up gives us the ImportDeclaration with its module specifier.
  const localDecl = sym.getDeclarations()[0];
  const importDecl = localDecl?.getFirstAncestorByKind(
    SyntaxKind.ImportDeclaration
  );
  const importSpecifier = importDecl?.getModuleSpecifierValue();

  return { resolvedName, declarationFile, importSpecifier };
}

/* -------------------------------------------------------------------------- */
/* Pass B — edge emission                                                     */
/* -------------------------------------------------------------------------- */

function addAssignedToEdge(varDecl: VariableDeclaration, graph: ProjectGraph): void {
  const name = varDecl.getNameNode();
  if (!name.isKind(SyntaxKind.Identifier)) return;
  const target = idOf(name);

  const init = varDecl.getInitializer();
  const source = originNodeId(init);
  if (!source) return;
  graph.addEdge({ type: "assigned_to", from: source, to: target });
}

function addPassedAsArgEdges(call: CallExpression, graph: ProjectGraph): void {
  const callId = idOf(call);
  const args = call.getArguments();
  args.forEach((arg, argIndex) => {
    const source = originNodeId(arg);
    if (!source) return;
    graph.addEdge({
      type: "passed_as_arg",
      from: source,
      to: callId,
      argIndex,
    });
  });
}

function addPassedAsPropEdge(attr: JsxAttribute, graph: ProjectGraph): void {
  const element = attr.getFirstAncestor(
    (n): n is JsxOpeningElement | JsxSelfClosingElement =>
      Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n)
  );
  if (!element) return;
  const elementId = idOf(element);
  const propName = attr.getNameNode().getText();

  const initializer = attr.getInitializer();
  if (!initializer) return; // boolean props like <Toast open /> have no value

  // Two shapes: literal-valued (message="hi") or expression-valued (message={...}).
  let source: string | null = null;
  if (initializer.getKind() === SyntaxKind.StringLiteral) {
    source = idOf(initializer);
  } else if (Node.isJsxExpression(initializer)) {
    source = originNodeId(initializer.getExpression());
  }
  if (!source) return;

  graph.addEdge({
    type: "passed_as_prop",
    from: source,
    to: elementId,
    propName,
  });
}

function addReturnedFromEdge(ret: ReturnStatement, graph: ProjectGraph): void {
  const expr = ret.getExpression();
  const source = originNodeId(expr);
  if (!source) return;
  const target = enclosingFunctionSymbolId(ret);
  if (!target) return;
  graph.addEdge({ type: "returned_from", from: source, to: target });
}

/**
 * Arrow functions with expression bodies (`const fn = () => "x"`) have no
 * `ReturnStatement` — the body expression itself is the implicit return.
 */
function addImplicitReturnEdge(
  arrow: import("ts-morph").ArrowFunction,
  graph: ProjectGraph
): void {
  const body = arrow.getBody();
  if (Node.isBlock(body)) return; // explicit returns handled elsewhere
  const source = originNodeId(body);
  if (!source) return;
  const target = enclosingFunctionSymbolId(body);
  if (!target) return;
  graph.addEdge({ type: "returned_from", from: source, to: target });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Returns the graph-node id for a value that can be the source of an edge —
 * either a string literal (the literal itself) or an identifier reference
 * (the symbol's declaration site). Anything else returns `null` and is
 * effectively dropped — those values can't be traced.
 */
function originNodeId(expr: Node | undefined): string | null {
  if (!expr) return null;
  const kind = expr.getKind();
  if (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return idOf(expr);
  }
  if (Node.isIdentifier(expr)) {
    return identifierDeclarationId(expr);
  }
  return null;
}

function identifierDeclarationId(id: Identifier): string | null {
  const sym = id.getSymbol();
  if (!sym) return null;
  // Chase through import aliases and barrel re-exports to the original
  // declaration. Without this, cross-file edges would land on local
  // ImportSpecifier nodes which are not in the graph — and the BFS would
  // dead-end at the file boundary.
  const original = chaseAlias(sym);
  const decls = original.getDeclarations();
  if (decls.length === 0) return null;
  const decl = decls[0];

  if (
    Node.isVariableDeclaration(decl) ||
    Node.isFunctionDeclaration(decl) ||
    Node.isParameterDeclaration(decl)
  ) {
    const name = decl.getNameNode();
    if (!name) return null;
    if (Node.isIdentifier(name)) return idOf(name);
  }
  return null;
}

export function chaseAlias(sym: import("ts-morph").Symbol): import("ts-morph").Symbol {
  let cur = sym;
  // Bounded; chained re-exports beyond ~10 hops would be pathological.
  for (let i = 0; i < 10; i++) {
    const next = cur.getAliasedSymbol();
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

function symbolNodeForVariable(varDecl: VariableDeclaration): SymbolNode | null {
  const name = varDecl.getNameNode();
  if (!name.isKind(SyntaxKind.Identifier)) return null;
  return {
    ...locOf(name),
    id: idOf(name),
    type: "symbol",
    name: name.getText(),
  };
}

function enclosingFunctionSymbolId(node: Node): string | null {
  const fn =
    node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ??
    node.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
    node.getFirstAncestorByKind(SyntaxKind.FunctionExpression);
  if (!fn) return null;

  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getNameNode();
    return name ? idOf(name) : null;
  }
  // ArrowFunction / FunctionExpression — symbol comes from the enclosing
  // `const fn = (...) => ...` declaration, if any.
  const v = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!v) return null;
  const name = v.getNameNode();
  if (!name.isKind(SyntaxKind.Identifier)) return null;
  return idOf(name);
}

function calleeNameOf(call: CallExpression): string | null {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getNameNode().getText();
  }
  return null;
}

function idOf(node: Node): string {
  return nodeId(node.getSourceFile().getFilePath(), node.getStart());
}

function locOf(node: Node): {
  file: string;
  line: number;
  column: number;
} {
  const sf = node.getSourceFile();
  const lc = sf.compilerNode.getLineAndCharacterOfPosition(node.getStart());
  return {
    file: sf.getFilePath(),
    line: lc.line + 1,
    column: lc.character,
  };
}

// Tag-safety: ensures any GraphNode our emitters create has both `id` and `type`
// after merging the locOf() spread. Caught at the call sites if you forget.
type _GraphNodeCheck = GraphNode extends { id: string; type: string }
  ? true
  : never;
const _check: _GraphNodeCheck = true;
void _check;
