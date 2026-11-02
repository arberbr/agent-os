import type { AnyJsAstNode } from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";

const FORBIDDEN_SYMBOL_NAME = "shape";

/**
 * The identifier spelled by a name node, or `undefined` when the node is
 * spelled as a string or numeric literal (`{ "shape": 1 }`), which is data
 * rather than a symbol name.
 */
function symbolName(node: AnyJsAstNode): string | undefined {
	switch (node.kind) {
		case "JS_IDENTIFIER_BINDING":
		case "JS_IDENTIFIER_ASSIGNMENT":
		case "TS_IDENTIFIER_BINDING":
			return node.nameToken;
		case "JS_REFERENCE_IDENTIFIER":
		case "JS_LABEL":
		case "JSX_NAME":
		case "JSX_REFERENCE_IDENTIFIER":
			return node.valueToken;
		case "JS_NAME":
		case "JS_PRIVATE_NAME":
			// `owner.shape` and `owner.#shape` name a member owned by another value.
			return node.parent?.kind === "JS_STATIC_MEMBER_EXPRESSION"
				? undefined
				: node.valueToken;
		case "JS_PRIVATE_CLASS_MEMBER_NAME":
			return node.idToken;
		case "TS_TYPE_PARAMETER_NAME":
			return node.identToken;
		case "JS_LITERAL_MEMBER_NAME":
		case "JS_LITERAL_EXPORT_NAME":
		case "TS_LITERAL_ENUM_MEMBER_NAME":
			return isIdentifierSpelling(node.value) ? node.value : undefined;
		default:
			return undefined;
	}
}

function isIdentifierSpelling(text: string | undefined): boolean {
	return text !== undefined && !/^["'0-9.]/.test(text);
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noShapeInSymbolNames = defineRule({
	query: ast(
		"JS_IDENTIFIER_BINDING",
		"JS_IDENTIFIER_ASSIGNMENT",
		"JS_REFERENCE_IDENTIFIER",
		"JS_NAME",
		"JS_LABEL",
		"JS_PRIVATE_NAME",
		"JS_PRIVATE_CLASS_MEMBER_NAME",
		"JS_LITERAL_MEMBER_NAME",
		"JS_LITERAL_EXPORT_NAME",
		"TS_IDENTIFIER_BINDING",
		"TS_TYPE_PARAMETER_NAME",
		"TS_LITERAL_ENUM_MEMBER_NAME",
		"JSX_NAME",
		"JSX_REFERENCE_IDENTIFIER",
	),
	run(node) {
		const name = symbolName(node);
		if (
			name === undefined ||
			!name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME)
		)
			return;
		report(
			"noShapeInSymbolNames",
			node,
			`Rename symbol "${name}" for its domain role; "shape" describes structure rather than ownership.`,
		);
	},
});
