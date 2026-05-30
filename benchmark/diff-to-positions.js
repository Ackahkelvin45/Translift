/**
 * Tool-agnostic diff→positions (roadmap N1/E5). Parse a tool's git-diff write
 * output into {file,line,col,text} wrap positions by re-reading the modified
 * files and locating each added translation call (callees configurable). Lets
 * i18next-cli / a18n output be scored by the same lingui-fp.ts region check as
 * TransLift, so all tools are measured identically.
 *
 * Usage: node benchmark/diff-to-positions.js <root> <calleesCsv>
 *   writes /tmp/positions.json, prints WRAP_POSITIONS=<n>.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const t = require("@babel/types");

const [root, calleesCsv] = process.argv.slice(2);
const callees = new Set((calleesCsv || "t,a18n").split(","));
const changed = execSync(`git -C ${root} diff --name-only -- '*.tsx' '*.ts'`, {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const positions = [];
for (const rel of changed) {
  const file = path.join(root, rel);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let ast;
  try {
    ast = parse(src, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });
  } catch {
    continue;
  }
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      const name = t.isIdentifier(c)
        ? c.name
        : t.isMemberExpression(c) && t.isIdentifier(c.property)
          ? c.property.name
          : null;
      if (!name || !callees.has(name)) return;
      const strArgs = p.node.arguments
        .filter((a) => t.isStringLiteral(a))
        .map((a) => a.value);
      // i18next emits t(key, default); a18n emits a18n(text). Prefer the 2nd
      // string arg (the human default) when present.
      const text = strArgs.length > 1 ? strArgs[1] : strArgs[0];
      const loc = p.node.loc?.start;
      if (loc) positions.push({ file, line: loc.line, col: loc.column, text });
    },
  });
}
fs.writeFileSync("/tmp/positions.json", JSON.stringify(positions, null, 2));
console.log("WRAP_POSITIONS=" + positions.length);
