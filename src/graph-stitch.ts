/**
 * Sub-step 3c — cross-file stitching.
 *
 * Adds `imports` edges from a consumer module → the original declaration of
 * each imported symbol. These edges are metadata only — Pass 2's BFS does
 * NOT traverse them; it walks the four string-flow edge types. The `imports`
 * edges exist so downstream features (hub analysis, `importFrom` matching on
 * function sinks, future import-export validation) can answer "where does this
 * symbol live and how was it brought in?" in O(1).
 *
 * Why cross-file traces work without the BFS touching `imports`:
 * `graph-build.ts`'s `identifierDeclarationId` chases through ts-morph's
 * alias chain (`getAliasedSymbol`), so a `passed_as_prop` edge written from
 * file B already lands on the original declaration's node in file A. The
 * BFS therefore crosses file boundaries naturally; the `imports` edge is
 * audit/discovery metadata, not a routing primitive.
 */
import {
  ExportSpecifier,
  Identifier,
  ImportSpecifier,
  Node,
  SourceFile,
  Symbol as TsSymbol,
} from "ts-morph";
import { ProjectGraph, nodeId } from "./graph";

export function stitchFileImports(sf: SourceFile, graph: ProjectGraph): void {
  if (isExternalFile(sf)) return;
  const consumerModuleId = nodeId(sf.getFilePath(), 0);

  for (const imp of sf.getImportDeclarations()) {
    const targetFile = imp.getModuleSpecifierSourceFile();
    if (!targetFile || isExternalFile(targetFile)) continue;
    const specifier = imp.getModuleSpecifierValue();
    const targetModuleId = nodeId(targetFile.getFilePath(), 0);

    // `import * as ns from "..."` — the whole module is what's imported.
    const nsImport = imp.getNamespaceImport();
    if (nsImport) {
      graph.addEdge({
        type: "imports",
        from: consumerModuleId,
        to: targetModuleId,
        specifier,
      });
    }

    // `import X from "..."` — resolve default export's declaration.
    const defaultImport = imp.getDefaultImport();
    if (defaultImport) {
      const declId = resolveImportTargetId(defaultImport);
      if (declId) {
        graph.addEdge({
          type: "imports",
          from: consumerModuleId,
          to: declId,
          specifier,
        });
      }
    }

    // `import { A, B as C } from "..."` — one edge per named import.
    // String-name imports (`import { "foo" as bar }`) are skipped — they're
    // rare and would require a different resolution path.
    for (const named of imp.getNamedImports()) {
      const nameNode = named.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      const declId = resolveImportTargetId(nameNode);
      if (declId) {
        graph.addEdge({
          type: "imports",
          from: consumerModuleId,
          to: declId,
          specifier,
        });
      }
    }
    // Side-effect imports (`import "./styles.css"`) intentionally produce no
    // edge — there's no symbol or module-of-interest on the other end.
  }
}

/**
 * Given an identifier in an import position, return the graph node id of the
 * original declaration it refers to — chasing through barrel re-exports until
 * we hit a real declaration.
 */
function resolveImportTargetId(id: Identifier): string | null {
  const sym = id.getSymbol();
  if (!sym) return null;
  const original = chaseAlias(sym);
  const decls = original.getDeclarations();
  if (decls.length === 0) return null;
  const decl = decls[0];
  if (isExternalFile(decl.getSourceFile())) return null;
  return declarationGraphNodeId(decl);
}

/**
 * Map a declaration node to the graph node id `graph-build.ts` would have
 * given its symbol. Kept in sync with `addNodeIfRelevant` there — if that
 * function changes which declarations become symbol nodes, this must change
 * in lockstep.
 */
function declarationGraphNodeId(decl: Node): string | null {
  if (
    Node.isVariableDeclaration(decl) ||
    Node.isFunctionDeclaration(decl) ||
    Node.isParameterDeclaration(decl)
  ) {
    const name = decl.getNameNode();
    if (name && Node.isIdentifier(name)) {
      return nodeId(decl.getSourceFile().getFilePath(), name.getStart());
    }
  }
  return null;
}

function chaseAlias(sym: TsSymbol): TsSymbol {
  let cur = sym;
  for (let i = 0; i < 10; i++) {
    const next = cur.getAliasedSymbol();
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

function isExternalFile(sf: SourceFile): boolean {
  return sf.getFilePath().includes("/node_modules/");
}
