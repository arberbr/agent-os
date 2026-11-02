import type {
	AnyJsAstNode,
	TsAsAssignment,
	TsAsExpression,
	TsTypeAssertionAssignment,
	TsTypeAssertionExpression,
} from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";

/**
 * A type assertion on a value or on an assignment target. Biome gives
 * `(x as T) = value` its own node kinds, where ESTree reuses the expression.
 */
type TypeAssertion =
	| TsAsExpression
	| TsTypeAssertionExpression
	| TsAsAssignment
	| TsTypeAssertionAssignment;

function isTypeAssertion(
	node: AnyJsAstNode | undefined,
): node is TypeAssertion {
	return (
		node?.kind === "TS_AS_EXPRESSION" ||
		node?.kind === "TS_TYPE_ASSERTION_EXPRESSION" ||
		node?.kind === "TS_AS_ASSIGNMENT" ||
		node?.kind === "TS_TYPE_ASSERTION_ASSIGNMENT"
	);
}

function isParenthesized(node: AnyJsAstNode | undefined): boolean {
	return (
		node?.kind === "JS_PARENTHESIZED_EXPRESSION" ||
		node?.kind === "JS_PARENTHESIZED_ASSIGNMENT"
	);
}

/** The asserted operand, with redundant parentheses removed. */
function assertedOperand(node: TypeAssertion): AnyJsAstNode | undefined {
	let operand: AnyJsAstNode | undefined =
		node.kind === "TS_AS_EXPRESSION" ||
		node.kind === "TS_TYPE_ASSERTION_EXPRESSION"
			? node.expression
			: node.assignment;
	while (
		operand?.kind === "JS_PARENTHESIZED_EXPRESSION" ||
		operand?.kind === "JS_PARENTHESIZED_ASSIGNMENT"
	) {
		operand =
			operand.kind === "JS_PARENTHESIZED_EXPRESSION"
				? operand.expression
				: operand.assignment;
	}
	return operand;
}

function isConstAssertion(node: TypeAssertion): boolean {
	const type = node.ty;
	return (
		type?.kind === "TS_REFERENCE_TYPE" &&
		type.name?.kind === "JS_REFERENCE_IDENTIFIER" &&
		type.name.valueToken === "const"
	);
}

/**
 * Whether no assertion wraps this one. An assertion's only expression child is
 * the asserted operand, so a parent assertion reached through parentheses
 * always asserts this chain.
 */
function isOutermostAssertionInChain(node: TypeAssertion): boolean {
	let parent = node.parent;
	while (isParenthesized(parent)) parent = parent?.parent;
	return !isTypeAssertion(parent);
}

function isForbiddenAssertionChain(node: TypeAssertion): boolean {
	let assertionCount = 0;
	let hasNonConstAssertion = false;
	let current: AnyJsAstNode | undefined = node;
	while (isTypeAssertion(current)) {
		assertionCount += 1;
		hasNonConstAssertion ||= !isConstAssertion(current);
		current = assertedOperand(current);
	}
	return assertionCount > 1 && hasNonConstAssertion;
}

/** Disallow nested TypeScript type assertions, while permitting chains made only of const assertions. */
export const noChainedTypeAssertions = defineRule({
	query: ast(
		"TS_AS_EXPRESSION",
		"TS_TYPE_ASSERTION_EXPRESSION",
		"TS_AS_ASSIGNMENT",
		"TS_TYPE_ASSERTION_ASSIGNMENT",
	),
	run(node) {
		if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node))
			return;
		report(
			"noChainedTypeAssertions",
			node,
			"This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
		);
	},
});
