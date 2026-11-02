import type { AnyJsExpression } from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import { unwrapParentheses } from "../shared/syntax.ts";

function isEmptyObjectExpression(
	expression: AnyJsExpression | undefined,
): boolean {
	const unwrapped = unwrapParentheses(expression);
	return (
		unwrapped?.kind === "JS_OBJECT_EXPRESSION" && unwrapped.members.length === 0
	);
}

function isConditionalEmptyObjectSpread(
	expression: AnyJsExpression | undefined,
): boolean {
	const conditional = unwrapParentheses(expression);
	return (
		conditional?.kind === "JS_CONDITIONAL_EXPRESSION" &&
		(isEmptyObjectExpression(conditional.consequent) ||
			isEmptyObjectExpression(conditional.alternate))
	);
}

/** Ban conditional empty-object spreads without changing their omission semantics. No fix is offered. */
export const noConditionalEmptyObjectSpread = defineRule({
	query: ast("JS_SPREAD"),
	run(node) {
		if (node.parent?.kind !== "JS_OBJECT_MEMBER_LIST") return;
		if (isConditionalEmptyObjectSpread(node.argument)) {
			report(
				"noConditionalEmptyObjectSpread",
				node,
				"This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.",
			);
		}
	},
});
