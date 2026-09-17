import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  getLeadingCommentRanges,
  isArrowFunction,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

/** Closed syntax categories enforced mechanically, independent of export visibility. */
type DocumentationKind =
  | "constructor"
  | "function binding"
  | "function property"
  | "function"
  | "function expression"
  | "class"
  | "interface"
  | "type alias"
  | "enum"
  | "method/accessor";

/** One missing associated documentation block; positions are one-based for editors. */
export interface DocumentationDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly kind: DocumentationKind;
  readonly name: string;
}

/** Syntax-classified symbol and the node whose leading trivia owns its documentation. */
interface DocumentationCandidate {
  readonly kind: DocumentationKind;
  readonly name: string;
  readonly owner: Node;
}

/** Non-production directory boundaries, applied to source discovery rather than declaration names. */
const excludedDirectories = new Set([
  "node_modules",
  "vendor",
  "generated",
  "dist",
  "build",
  "out",
  ".wrangler",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
]);

/**
 * Discovers non-ambient TypeScript in every immediate apps/packages workspace's src tree.
 *
 * @param root - Repository root containing apps and packages workspaces.
 * @returns Sorted absolute paths to production TypeScript files.
 */
export function discoverProductionFiles(root: string): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    const directory = join(root, group);
    for (const workspace of readdirSync(directory, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const workspacePath = join(directory, workspace.name);
      const source = readdirSync(workspacePath, { withFileTypes: true }).find(
        (entry) => entry.name === "src" && entry.isDirectory(),
      );
      if (source) collectSourceFiles(join(workspacePath, source.name), files);
    }
  }
  return files.sort();
}

/**
 * Traverses source directories without following symbolic links or generated/test subtrees.
 *
 * @param directory - Source subtree to traverse.
 * @param files - Accumulator receiving discovered absolute source paths.
 */
function collectSourceFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      collectSourceFiles(path, files);
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
}

/**
 * Recognizes an explicit @generated marker only in the file's leading comments.
 *
 * @returns Whether a leading comment contains the generated-file marker.
 */
export function isGeneratedSource(source: SourceFile): boolean {
  return (getLeadingCommentRanges(source.text, 0) ?? []).some((comment) =>
    /(?:^|\s)@generated(?:\s|$)/u.test(
      source.text.slice(comment.pos, comment.end),
    ),
  );
}

/**
 * Removes expression-only wrappers without guessing factory return types.
 *
 * @returns The initializer expression whose declaration kind owns the binding.
 */
function unwrapExpression(node: Node): Node {
  if (
    isParenthesizedExpression(node) ||
    isSatisfiesExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

/**
 * Associates expression names with an enclosing direct binding through wrappers.
 *
 * @returns Whether a variable or class property already documents the expression.
 */
function hasBindingOwner(node: Node): boolean {
  let owner = node.parent;
  while (
    isParenthesizedExpression(owner) ||
    isSatisfiesExpression(owner) ||
    isAsExpression(owner) ||
    isTypeAssertion(owner)
  ) {
    owner = owner.parent;
  }
  return isVariableDeclaration(owner) || isPropertyDeclaration(owner);
}

/**
 * Classifies only direct function/class initializers, not arbitrary factory values.
 *
 * @returns The bound declaration category, or undefined for an ordinary value.
 */
function bindingKind(node: Node): "class" | "function" | undefined {
  const expression = unwrapExpression(node);
  if (isClassExpression(expression)) return "class";
  if (isArrowFunction(expression) || isFunctionExpression(expression))
    return "function";
  return undefined;
}

/**
 * Classifies durable named syntax; data properties, schemas and constants require semantic review.
 *
 * @returns The documentation candidate, or undefined for an exempt syntax category.
 */
function candidate(node: Node): DocumentationCandidate | undefined {
  if (isConstructorDeclaration(node)) {
    return { kind: "constructor", name: "constructor", owner: node };
  }
  if (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    node.initializer &&
    bindingKind(node.initializer)
  ) {
    const statement = node.parent.parent;
    return {
      kind:
        bindingKind(node.initializer) === "class"
          ? "class"
          : "function binding",
      name: node.name.text,
      owner: isVariableStatement(statement) ? statement : node,
    };
  }
  if (
    isPropertyDeclaration(node) &&
    node.initializer &&
    bindingKind(node.initializer)
  ) {
    return {
      kind:
        bindingKind(node.initializer) === "class"
          ? "class"
          : "function property",
      name: node.name.getText(),
      owner: node,
    };
  }
  if (isFunctionDeclaration(node) && node.name)
    return { kind: "function", name: node.name.text, owner: node };
  if (isFunctionExpression(node) && node.name && !hasBindingOwner(node))
    return { kind: "function expression", name: node.name.text, owner: node };
  if (
    (isClassDeclaration(node) ||
      (isClassExpression(node) && !hasBindingOwner(node))) &&
    node.name
  )
    return { kind: "class", name: node.name.text, owner: node };
  if (isInterfaceDeclaration(node))
    return { kind: "interface", name: node.name.text, owner: node };
  if (isTypeAliasDeclaration(node))
    return { kind: "type alias", name: node.name.text, owner: node };
  if (isEnumDeclaration(node))
    return { kind: "enum", name: node.name.text, owner: node };
  if (
    isMethodSignatureDeclaration(node) ||
    ((isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
      !isObjectLiteralExpression(node.parent))
  ) {
    return { kind: "method/accessor", name: node.name.getText(), owner: node };
  }
  return undefined;
}

/**
 * Requires the last leading comment to be a doc block adjacent to the declaration, including its modifiers/decorators.
 *
 * @returns Whether an adjacent leading TSDoc block belongs to this declaration.
 */
function hasAssociatedDocumentation(node: Node, source: SourceFile): boolean {
  const trivia = source.text.slice(node.pos, node.getStart(source));
  const comment = getLeadingCommentRanges(trivia, 0)?.at(-1);
  return (
    comment !== undefined &&
    trivia.slice(comment.pos, comment.pos + 3) === "/**" &&
    trivia.slice(comment.end).trim() === ""
  );
}

/**
 * Reports presence only, never prose quality; anonymous callbacks and inline object methods are exempt.
 *
 * @returns Missing documentation diagnostics in source traversal order.
 */
export function inspectDocumentation(
  source: SourceFile,
  file: string,
): DocumentationDiagnostic[] {
  if (isGeneratedSource(source)) return [];
  const diagnostics: DocumentationDiagnostic[] = [];
  /** Walks named declarations even inside function bodies, without classifying ordinary locals. */
  const visit = (node: Node): void => {
    const declaration = candidate(node);
    if (declaration && !hasAssociatedDocumentation(declaration.owner, source)) {
      diagnostics.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        kind: declaration.kind,
        name: declaration.name,
      });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return diagnostics;
}

/**
 * Checks discovered production files using the installed TypeScript 7 compiler snapshot.
 * Missing compiler source files fail loudly rather than silently reducing coverage.
 * The unstable API is confined here and protected by fixture-based regression tests.
 *
 * @param root - Repository root containing the TypeScript project and production workspaces.
 * @returns The discovered file count and all missing-documentation diagnostics.
 */
export function checkDocumentation(root: string): {
  files: number;
  diagnostics: DocumentationDiagnostic[];
} {
  const directory = resolve(root);
  const files = discoverProductionFiles(directory);
  const api = new API({ cwd: directory });
  try {
    const snapshot = api.updateSnapshot({
      openProjects: [join(directory, "tsconfig.json")],
    });
    const project = snapshot.getProject(join(directory, "tsconfig.json"));
    if (!project)
      throw new Error(
        "Documentation check could not load the root TypeScript project.",
      );
    const diagnostics = files.flatMap((file) => {
      const source = project.program.getSourceFile(file);
      if (!source)
        throw new Error(
          `Documentation check could not parse ${file}. Include it in tsconfig.json.`,
        );
      return inspectDocumentation(
        source,
        relative(directory, file).split(sep).join("/"),
      );
    });
    return { files: files.length, diagnostics };
  } finally {
    api.close();
  }
}
