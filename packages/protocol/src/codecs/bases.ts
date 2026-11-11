import {
	BASE_VALIDATION_LIMITS,
	BaseContentSchema,
	BaseValidationResultSchema,
} from "@protocol/schemas/bases";
import type { BaseValidationResult } from "@protocol/types/bases";
import { Composer, CST, Lexer, Parser } from "yaml";

/** Stops byte counting as soon as the input exceeds its UTF-8 budget. */
function exceedsUtf8ByteLimit(content: string, limit: number): boolean {
	let bytes = 0;
	for (let index = 0; index < content.length; index += 1) {
		const code = content.charCodeAt(index);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = content.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 3;
		} else bytes += 3;
		if (bytes > limit) return true;
	}
	return false;
}

/** Public CST token type inferred from the parser's supported iterator API. */
type Token =
	ReturnType<Parser["parse"]> extends Generator<infer Item, void, unknown>
		? Item
		: never;

/** Creates the same bounded result shape for every rejected input. */
function invalid(diagnostic: string): BaseValidationResult {
	return BaseValidationResultSchema.parse({
		valid: false,
		level: "structural-only",
		diagnostics: [
			diagnostic.slice(0, BASE_VALIDATION_LIMITS.diagnosticCharacters),
		],
	});
}

/** Check a supplied YAML CST token forest against depth, node, and forbidden-token limits. */
export function checkCstBounds(tokens: Token[]): string | undefined {
	const pending: Array<{ token: Token; depth: number }> = [];
	for (const token of tokens) pending.push({ token, depth: 1 });
	let nodes = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		nodes += 1;
		if (nodes > BASE_VALIDATION_LIMITS.nodes)
			return "YAML syntax node limit exceeded";
		if (current.depth > BASE_VALIDATION_LIMITS.depth)
			return "YAML structure depth limit exceeded";
		const token = current.token;
		if (token.type === "alias") return "YAML aliases are not supported";
		if (token.type === "anchor") return "YAML anchors are not supported";
		if (token.type === "tag") return "YAML tags are not supported";
		if (token.type === "document") {
			for (const part of token.start)
				pending.push({ token: part, depth: current.depth + 1 });
			if (token.value)
				pending.push({ token: token.value, depth: current.depth + 1 });
		}
		if (token.type === "block-map") {
			for (const item of token.items) {
				for (const part of item.start)
					pending.push({ token: part, depth: current.depth + 1 });
				if (item.key)
					pending.push({ token: item.key, depth: current.depth + 1 });
				if (item.value)
					pending.push({ token: item.value, depth: current.depth + 1 });
				for (const part of item.sep ?? [])
					pending.push({ token: part, depth: current.depth + 1 });
			}
		}
		if (token.type === "block-seq") {
			for (const item of token.items)
				if (item.value)
					pending.push({ token: item.value, depth: current.depth + 1 });
		}
		if (token.type === "flow-collection") {
			for (const item of token.items) {
				for (const part of item.start)
					pending.push({ token: part, depth: current.depth + 1 });
				if (item.key)
					pending.push({ token: item.key, depth: current.depth + 1 });
				if (item.value)
					pending.push({ token: item.value, depth: current.depth + 1 });
				for (const part of item.sep ?? [])
					pending.push({ token: part, depth: current.depth + 1 });
			}
		}
		if (token.type === "block-scalar")
			for (const part of token.props)
				pending.push({ token: part, depth: current.depth + 1 });
	}
	return undefined;
}

/** Validate bounded native Base YAML structure without evaluating expressions or returning note data. */
export function validateBaseContent(content: string): BaseValidationResult {
	if (exceedsUtf8ByteLimit(content, BASE_VALIDATION_LIMITS.bytes))
		return invalid("Base YAML exceeds 65536 UTF-8 bytes");
	try {
		const lexer = new Lexer();
		const parser = new Parser();
		const tokens: Token[] = [];
		let tokenCount = 0;
		let lineIndicators = 0;
		for (const lexeme of lexer.lex(content)) {
			if (parser.stack.length > BASE_VALIDATION_LIMITS.stack)
				return invalid("YAML parser stack limit exceeded");
			tokenCount += 1;
			if (tokenCount > BASE_VALIDATION_LIMITS.tokens)
				return invalid("YAML lexical token limit exceeded");
			const type = CST.tokenType(lexeme);
			if (type === "newline") lineIndicators = 0;
			if (
				type === "seq-item-ind" ||
				type === "explicit-key-ind" ||
				type === "map-value-ind"
			) {
				lineIndicators += 1;
				if (lineIndicators > BASE_VALIDATION_LIMITS.indicatorsPerLine)
					return invalid("YAML line indicator limit exceeded");
			}
			if (type === "anchor" || type === "tag")
				return invalid(`YAML ${type}s are not supported`);
			for (const token of parser.next(lexeme)) tokens.push(token);
			if (parser.stack.length > BASE_VALIDATION_LIMITS.stack)
				return invalid("YAML parser stack limit exceeded");
		}
		for (const token of parser.end()) tokens.push(token);
		if (parser.stack.length > BASE_VALIDATION_LIMITS.stack)
			return invalid("YAML parser stack limit exceeded");
		const cstError = checkCstBounds(tokens);
		if (cstError) return invalid(cstError);
		const composer = new Composer({
			uniqueKeys: true,
			resolveKnownTags: false,
		});
		const documents = [...composer.compose(tokens, true, content.length)];
		if (documents.length !== 1)
			return invalid("Base YAML must contain one document");
		const document = documents[0];
		if (!document || document.errors.length > 0)
			return invalid("Base YAML syntax is invalid");
		const value: unknown = document.toJS({ maxAliasCount: 0 });
		const result = BaseContentSchema.safeParse(value);
		if (!result.success) return invalid("Base structure is invalid");
		return BaseValidationResultSchema.parse({
			valid: true,
			level: "structural-only",
			diagnostics: [],
		});
	} catch {
		return invalid("Base YAML parser failed");
	}
}
