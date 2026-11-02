import type { AnyJsExpression } from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";
import { report } from "../../shared/report.ts";
import { unwrapParentheses } from "../../shared/syntax.ts";
import { parentSkippingParentheses } from "../shared/tagged-values.ts";

const equalityOperators = new Set(["==", "===", "!=", "!=="]);
const literalKinds = new Set<string>([
	"JS_STRING_LITERAL_EXPRESSION",
	"JS_NUMBER_LITERAL_EXPRESSION",
	"JS_BIGINT_LITERAL_EXPRESSION",
	"JS_BOOLEAN_LITERAL_EXPRESSION",
	"JS_NULL_LITERAL_EXPRESSION",
	"JS_REGEX_LITERAL_EXPRESSION",
]);

/** A literal token or an untagged template literal without substitutions. */
function isLiteral(expression: AnyJsExpression | undefined): boolean {
	if (expression === undefined) return false;
	if (literalKinds.has(expression.kind)) return true;
	return (
		expression.kind === "JS_TEMPLATE_EXPRESSION" &&
		!expression.tag &&
		expression.elements.every(
			(element) => element.kind === "JS_TEMPLATE_CHUNK_ELEMENT",
		)
	);
}

/** The source text of the value an equality test compares against a literal. */
function comparedValue(test: AnyJsExpression | undefined): string | undefined {
	const expression = unwrapParentheses(test);
	if (
		expression?.kind !== "JS_BINARY_EXPRESSION" ||
		!equalityOperators.has(expression.operatorToken ?? "")
	) {
		return undefined;
	}
	const left = unwrapParentheses(expression.left);
	const right = unwrapParentheses(expression.right);
	if (isLiteral(left)) return right?.text;
	if (isLiteral(right)) return left?.text;
	return undefined;
}

/** Use Match from Effect for chained literal ternaries over the same value. */
export const preferEffectMatch = defineRule({
	query: ast("JS_CONDITIONAL_EXPRESSION"),
	run(node) {
		if (parentSkippingParentheses(node)?.kind === "JS_CONDITIONAL_EXPRESSION")
			return;
		const value = comparedValue(node.test);
		if (value === undefined) return;

		let alternate = unwrapParentheses(node.alternate);
		let literalChecks = 1;
		while (alternate?.kind === "JS_CONDITIONAL_EXPRESSION") {
			if (comparedValue(alternate.test) !== value) return;
			literalChecks += 1;
			alternate = unwrapParentheses(alternate.alternate);
		}

		if (literalChecks > 1) {
			report(
				"preferEffectMatch",
				node,
				"Use Match from Effect instead of a chained literal ternary.",
			);
		}
	},
});
