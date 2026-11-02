import type { AnyJsAstNode, JsUnaryExpression } from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import { stringLiteralValue, unwrapParentheses } from "../shared/syntax.ts";

/**
 * Allow `typeof` inside functions whose return type is a type predicate
 * (`value is T`) or assertion signature (`asserts value is T`). Biome plugins
 * take no options, so a vendoring team that wants this exception edits this
 * constant to `true`.
 */
const ALLOW_IN_TYPE_GUARDS = false;

/** Function-like nodes that can never be type guards. */
const OTHER_FUNCTION_KINDS = new Set<string>([
	"JS_CONSTRUCTOR_CLASS_MEMBER",
	"JS_GETTER_CLASS_MEMBER",
	"JS_GETTER_OBJECT_MEMBER",
	"JS_SETTER_CLASS_MEMBER",
	"JS_SETTER_OBJECT_MEMBER",
]);

/** Whether the nearest enclosing function declares a type predicate or assertion signature. */
function isInsideTypeGuard(node: AnyJsAstNode): boolean {
	for (const ancestor of node.ancestors()) {
		if (OTHER_FUNCTION_KINDS.has(ancestor.kind)) return false;
		if (
			ancestor.kind === "JS_ARROW_FUNCTION_EXPRESSION" ||
			ancestor.kind === "JS_FUNCTION_DECLARATION" ||
			ancestor.kind === "JS_FUNCTION_EXPORT_DEFAULT_DECLARATION" ||
			ancestor.kind === "JS_FUNCTION_EXPRESSION" ||
			ancestor.kind === "JS_METHOD_CLASS_MEMBER" ||
			ancestor.kind === "JS_METHOD_OBJECT_MEMBER"
		) {
			const kind = ancestor.returnTypeAnnotation?.ty?.kind;
			return (
				kind === "TS_PREDICATE_RETURN_TYPE" || kind === "TS_ASSERTS_RETURN_TYPE"
			);
		}
	}
	return false;
}

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

/** Whether `typeof` safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: JsUnaryExpression): boolean {
	let parent = node.parent;
	while (parent?.kind === "JS_PARENTHESIZED_EXPRESSION") parent = parent.parent;
	if (parent?.kind !== "JS_BINARY_EXPRESSION") return false;
	if (!EQUALITY_OPERATORS.has(parent.operatorToken ?? "")) return false;
	return [parent.left, parent.right].some((operand) => {
		const unwrapped = unwrapParentheses(operand);
		return (
			unwrapped?.kind === "JS_STRING_LITERAL_EXPRESSION" &&
			stringLiteralValue(unwrapped.valueToken) === "undefined"
		);
	});
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeof = defineRule({
	query: ast("JS_UNARY_EXPRESSION"),
	run(node) {
		if (node.operatorToken !== "typeof" || isExistenceProbe(node)) return;
		if (ALLOW_IN_TYPE_GUARDS && isInsideTypeGuard(node)) return;
		report(
			"noRuntimeTypeof",
			node,
			"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		);
	},
});
