import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { type DocNode, DocNodeKind, TSDocParser } from "@microsoft/tsdoc";

/** One mechanical documentation defect at a source declaration. */
export interface DocumentationFinding {
	path: string;
	line: number;
	declaration: string;
	rule: string;
	message: string;
}

/** Named syntax forms whose contracts do not depend on export visibility. */
const DECLARATION_KINDS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_signature",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"method_definition",
	"method_signature",
	"abstract_method_signature",
]);

/** Zod operations that return values or configuration instead of runtime schemas. */
const ZOD_VALUE_OPERATIONS = new Set([
	"parse",
	"parseAsync",
	"safeParse",
	"safeParseAsync",
	"encode",
	"encodeAsync",
	"safeEncode",
	"safeEncodeAsync",
	"decode",
	"decodeAsync",
	"safeDecode",
	"safeDecodeAsync",
	"flattenError",
	"treeifyError",
	"prettifyError",
	"formatError",
	"toJSONSchema",
	"config",
	"registry",
	"getErrorMap",
	"setErrorMap",
]);

/** Ignore the sole versioned runtime artifact. New generated paths need explicit review. */
const GENERATED_PATH =
	"apps/worker/src/infrastructure/sqlite/schema.generated.ts";

/** Walk syntax children, including parser error nodes that must not hide declarations. */
function* walk(node: SgNode): Generator<SgNode> {
	yield node;
	for (const child of node.children()) yield* walk(child);
}

/** Find named contracts and semantic bindings without treating ordinary locals as APIs. */
function declarationName(node: SgNode): string | undefined {
	const name = node.field("name")?.text();
	if (!name) return undefined;
	if (DECLARATION_KINDS.has(String(node.kind()))) {
		if (
			name === "constructor" &&
			node.field("body")?.namedChildren().length === 0
		)
			return undefined;
		return name;
	}
	if (node.kind() !== "variable_declarator") return undefined;
	let value = node.field("value");
	while (
		value &&
		[
			"as_expression",
			"satisfies_expression",
			"parenthesized_expression",
		].includes(String(value.kind()))
	) {
		value = value.namedChildren()[0] ?? null;
	}
	if (!value) return undefined;
	const functionValue = [
		"arrow_function",
		"function_expression",
		"generator_function",
	].includes(String(value.kind()));
	const exported = node.parent()?.parent()?.kind() === "export_statement";
	const operation = value.field("function")?.field("property")?.text() ?? "";
	const schema =
		value.kind() === "call_expression" &&
		/^z\./.test(value.text()) &&
		!ZOD_VALUE_OPERATIONS.has(operation);
	const constant = /^[A-Z][A-Z_0-9]*$/.test(name);
	return functionValue || exported || schema || constant ? name : undefined;
}

/** Attach only the immediately preceding TSDoc block to its declaration wrapper. */
function leadingComment(node: SgNode): SgNode | undefined {
	let anchor = node;
	if (node.kind() === "variable_declarator") {
		const parent = node.parent();
		if (
			!parent ||
			parent
				.namedChildren()
				.filter((child) => child.kind() === "variable_declarator")[0]
				?.id() !== node.id()
		)
			return undefined;
		anchor = parent;
	}
	if (anchor.parent()?.kind() === "export_statement")
		anchor = anchor.parent() ?? anchor;
	const previous = anchor.prev();
	return previous?.kind() === "comment" && previous.text().startsWith("/**")
		? previous
		: undefined;
}

/** Detect actual summary text rather than counting tags or formatting nodes. */
function hasSummary(node: DocNode): boolean {
	if (
		node.kind === DocNodeKind.PlainText &&
		"text" in node &&
		typeof node.text === "string" &&
		node.text.trim()
	)
		return true;
	if (node.kind === DocNodeKind.CodeSpan || node.kind === DocNodeKind.LinkTag)
		return true;
	return node.getChildNodes().some(hasSummary);
}

/** Inspect declaration comments without claiming to validate their semantic truth. */
export function checkDocumentation(
	path: string,
	source: string,
): DocumentationFinding[] {
	if (path.replaceAll("\\", "/") === GENERATED_PATH) return [];
	const nodes = [...walk(parse(Lang.TypeScript, source).root())];
	const findings: DocumentationFinding[] = [];
	const parser = new TSDocParser();
	for (const node of nodes) {
		if (node.kind() === "ERROR") {
			findings.push({
				path,
				line: node.range().start.line + 1,
				declaration: "source",
				rule: "syntax",
				message: "Cannot inventory malformed TypeScript.",
			});
		}
		if (node.kind() === "comment" && node.text().startsWith("/**")) {
			for (const diagnostic of parser.parseString(node.text()).log.messages) {
				const prefix = node.text().slice(0, diagnostic.textRange.pos);
				findings.push({
					path,
					line: node.range().start.line + prefix.split("\n").length,
					declaration: "comment",
					rule: "tsdoc",
					message: diagnostic.unformattedText,
				});
			}
		}
		const name = declarationName(node);
		if (!name) continue;
		const comment = leadingComment(node);
		if (!comment) {
			findings.push({
				path,
				line: node.range().start.line + 1,
				declaration: name,
				rule: "missing",
				message: "Add a useful declaration contract.",
			});
		} else if (
			!hasSummary(parser.parseString(comment.text()).docComment.summarySection)
		) {
			findings.push({
				path,
				line: node.range().start.line + 1,
				declaration: name,
				rule: "empty",
				message: "Document the declaration role or constraint, not tags alone.",
			});
		}
	}
	return findings;
}
