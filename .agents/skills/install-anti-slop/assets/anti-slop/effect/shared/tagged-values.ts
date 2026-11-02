import type {
	AnyJsAstNode,
	AnyJsExpression,
	JsBinaryExpression,
	JsCallExpression,
	JsComputedMemberExpression,
	JsPropertyObjectMember,
	JsStaticMemberExpression,
} from "@biomejs/runtime/plugin";

import {
	identifierName,
	stringLiteralValue,
	unwrapParentheses,
} from "../../shared/syntax.ts";

/** A `value._tag` or `value["_tag"]` access. */
export type TagMember = JsStaticMemberExpression | JsComputedMemberExpression;

const equalityOperators = new Set(["==", "===", "!=", "!=="]);
const broadEffectCatchMethods = new Set(["catch", "catchAll", "catchIf"]);
const matchPatternMethods = new Set(["when", "not"]);

/**
 * Function-like nodes whose body is not a function expression argument. In
 * ESTree these wrap a `FunctionExpression` whose parent is a property or method
 * definition, so the search for an enclosing Effect handler stops at them.
 */
const methodLikeKinds = new Set<string>([
	"JS_METHOD_OBJECT_MEMBER",
	"JS_GETTER_OBJECT_MEMBER",
	"JS_SETTER_OBJECT_MEMBER",
	"JS_METHOD_CLASS_MEMBER",
	"JS_GETTER_CLASS_MEMBER",
	"JS_SETTER_CLASS_MEMBER",
	"JS_CONSTRUCTOR_CLASS_MEMBER",
]);

/** Whether the expression, ignoring parentheses, is a string literal. */
export function isStringLiteral(
	expression: AnyJsExpression | undefined,
): boolean {
	return unwrapParentheses(expression)?.kind === "JS_STRING_LITERAL_EXPRESSION";
}

/**
 * The statically named property of `owner.name`, `owner?.name`, or
 * `owner["name"]`. Unlike `memberName`, computed keys must be plain string
 * literals; template literal keys are not recognized.
 */
function literalMemberName(
	expression: AnyJsAstNode | undefined,
): string | undefined {
	if (expression?.kind === "JS_STATIC_MEMBER_EXPRESSION") {
		const member = expression.member;
		return member?.kind === "JS_NAME" ? member.valueToken : undefined;
	}
	if (expression?.kind === "JS_COMPUTED_MEMBER_EXPRESSION") {
		const member = unwrapParentheses(expression.member);
		return member?.kind === "JS_STRING_LITERAL_EXPRESSION"
			? stringLiteralValue(member.valueToken)
			: undefined;
	}
	return undefined;
}

/** The `_tag` member access an expression consists of, ignoring parentheses. */
export function tagMember(
	expression: AnyJsExpression | undefined,
): TagMember | undefined {
	const unwrapped = unwrapParentheses(expression);
	if (
		(unwrapped?.kind === "JS_STATIC_MEMBER_EXPRESSION" ||
			unwrapped?.kind === "JS_COMPUTED_MEMBER_EXPRESSION") &&
		literalMemberName(unwrapped) === "_tag"
	) {
		return unwrapped;
	}
	return undefined;
}

/** The `_tag` access compared for equality with a string literal, such as `value._tag === "Ready"`. */
export function tagMemberFromComparison(
	node: JsBinaryExpression,
): TagMember | undefined {
	if (!equalityOperators.has(node.operatorToken ?? "")) return undefined;
	const left = tagMember(node.left);
	if (left && isStringLiteral(node.right)) return left;
	const right = tagMember(node.right);
	if (right && isStringLiteral(node.left)) return right;
	return undefined;
}

/** Whether a `_tag` access reads a `reason` property's tag, as in `error.reason._tag`. */
export function isReasonTagMember(member: TagMember): boolean {
	return literalMemberName(unwrapParentheses(member.object)) === "reason";
}

/** The nearest ancestor that is not a parenthesized expression. */
export function parentSkippingParentheses(
	node: AnyJsAstNode,
): AnyJsAstNode | undefined {
	for (const ancestor of node.ancestors()) {
		if (ancestor.kind !== "JS_PARENTHESIZED_EXPRESSION") return ancestor;
	}
	return undefined;
}

/** The call expression that receives `node`, possibly parenthesized, as one of its arguments. */
function callReceivingArgument(
	node: AnyJsAstNode,
): JsCallExpression | undefined {
	const list = parentSkippingParentheses(node);
	if (list?.kind !== "JS_CALL_ARGUMENT_LIST") return undefined;
	const call = list.parent?.parent;
	return call?.kind === "JS_CALL_EXPRESSION" ? call : undefined;
}

/** Whether a call's callee is `Owner.method`, with `Owner` a plain identifier and `method` in `methods`. */
function isNamespaceCall(
	call: JsCallExpression,
	owner: string,
	methods: ReadonlySet<string>,
): boolean {
	const callee = unwrapParentheses(call.callee);
	if (callee?.kind !== "JS_STATIC_MEMBER_EXPRESSION") return false;
	const member = callee.member;
	return (
		member?.kind === "JS_NAME" &&
		methods.has(member.valueToken ?? "") &&
		identifierName(callee.object) === owner
	);
}

/**
 * Whether the nearest enclosing function expression or arrow function is an
 * argument of `Effect.catch`, `Effect.catchAll`, or `Effect.catchIf`. Function
 * declarations are looked through; object and class methods, accessors, and
 * constructors end the search.
 */
export function isInsideBroadEffectHandler(node: AnyJsAstNode): boolean {
	for (const ancestor of node.ancestors()) {
		if (
			ancestor.kind === "JS_ARROW_FUNCTION_EXPRESSION" ||
			ancestor.kind === "JS_FUNCTION_EXPRESSION"
		) {
			const call = callReceivingArgument(ancestor);
			return (
				call !== undefined &&
				isNamespaceCall(call, "Effect", broadEffectCatchMethods)
			);
		}
		if (methodLikeKinds.has(ancestor.kind)) return false;
	}
	return false;
}

/**
 * The static name of an object property's key: `name`, `"name"`, or
 * `["name"]`. Other computed keys return `undefined`.
 */
export function propertyName(
	property: JsPropertyObjectMember,
): string | undefined {
	const name = property.name;
	if (name?.kind === "JS_LITERAL_MEMBER_NAME") {
		const value = name.value;
		if (value === undefined) return undefined;
		return value.startsWith('"') || value.startsWith("'")
			? stringLiteralValue(value)
			: value;
	}
	if (name?.kind === "JS_COMPUTED_MEMBER_NAME") {
		const key = unwrapParentheses(name.expression);
		return key?.kind === "JS_STRING_LITERAL_EXPRESSION"
			? stringLiteralValue(key.valueToken)
			: undefined;
	}
	return undefined;
}

/** Whether an object literal is passed directly to `Match.when` or `Match.not` as a pattern. */
export function isMatchPatternObject(node: AnyJsAstNode): boolean {
	const call = callReceivingArgument(node);
	return (
		call !== undefined && isNamespaceCall(call, "Match", matchPatternMethods)
	);
}
