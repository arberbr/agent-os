import type {
	AnyJsAstNode,
	AnyJsExpression,
	JsCallExpression,
	SemanticModel,
} from "@biomejs/runtime/plugin";

/** Removes redundant parentheses around an expression. */
export function unwrapParentheses(
	expression: AnyJsExpression | undefined,
): AnyJsExpression | undefined {
	let current = expression;
	while (current?.kind === "JS_PARENTHESIZED_EXPRESSION") {
		current = current.expression;
	}
	return current;
}

/** The unquoted contents of a string literal token such as `"get"` or `'get'`. */
export function stringLiteralValue(
	literal: string | undefined,
): string | undefined {
	if (literal === undefined || literal.length < 2) return undefined;
	const quote = literal[0];
	if ((quote !== '"' && quote !== "'") || literal.at(-1) !== quote)
		return undefined;
	const body = literal.slice(1, -1);
	return body.includes("\\") ? undefined : body;
}

/**
 * The statically known property name of a member expression: `owner.name`,
 * `owner?.name`, `owner["name"]`, and ``owner[`name`]``. Private names and
 * dynamic keys return `undefined`.
 */
export function memberName(
	expression: AnyJsAstNode | undefined,
): string | undefined {
	if (expression?.kind === "JS_STATIC_MEMBER_EXPRESSION") {
		const member = expression.member;
		return member?.kind === "JS_NAME" ? member.valueToken : undefined;
	}
	if (expression?.kind === "JS_COMPUTED_MEMBER_EXPRESSION") {
		return staticStringValue(unwrapParentheses(expression.member));
	}
	return undefined;
}

/** The object of a static or computed member expression. */
export function memberObject(
	expression: AnyJsAstNode | undefined,
): AnyJsExpression | undefined {
	if (
		expression?.kind === "JS_STATIC_MEMBER_EXPRESSION" ||
		expression?.kind === "JS_COMPUTED_MEMBER_EXPRESSION"
	) {
		return unwrapParentheses(expression.object);
	}
	return undefined;
}

/** The value of a string literal or substitution-free template literal. */
export function staticStringValue(
	expression: AnyJsAstNode | undefined,
): string | undefined {
	if (expression?.kind === "JS_STRING_LITERAL_EXPRESSION") {
		return stringLiteralValue(expression.valueToken);
	}
	if (expression?.kind === "JS_TEMPLATE_EXPRESSION" && !expression.tag) {
		const elements = expression.elements;
		if (elements.length === 0) return "";
		if (
			elements.length === 1 &&
			elements[0]?.kind === "JS_TEMPLATE_CHUNK_ELEMENT"
		) {
			const chunk = elements[0].templateChunkToken;
			return chunk?.includes("\\") ? undefined : chunk;
		}
	}
	return undefined;
}

/** The identifier name of `name` or `(name)`, or `undefined` for other expressions. */
export function identifierName(
	expression: AnyJsAstNode | undefined,
): string | undefined {
	const unwrapped =
		expression?.kind === "JS_PARENTHESIZED_EXPRESSION"
			? unwrapParentheses(expression)
			: expression;
	if (unwrapped?.kind !== "JS_IDENTIFIER_EXPRESSION") return undefined;
	return unwrapped.name?.valueToken;
}

/**
 * Reports whether `expression` is an identifier named `name` that does not
 * resolve to a local binding, which is how Biome's semantic model represents
 * built-in globals such as `Reflect` or `Object`.
 */
export function isUnshadowedGlobal(
	model: SemanticModel,
	expression: AnyJsAstNode | undefined,
	name: string,
): boolean {
	const unwrapped =
		expression?.kind === "JS_PARENTHESIZED_EXPRESSION"
			? unwrapParentheses(expression)
			: expression;
	if (unwrapped?.kind !== "JS_IDENTIFIER_EXPRESSION") return false;
	const reference = unwrapped.name;
	if (!reference || reference.valueToken !== name) return false;
	return model.binding(reference) === undefined;
}

/**
 * Reports whether a call invokes `Global.method`, such as `Reflect.get`, on the
 * unshadowed global object.
 */
export function isGlobalMethodCall(
	model: SemanticModel,
	call: JsCallExpression,
	globalName: string,
	methodName: string,
): boolean {
	const callee = unwrapParentheses(call.callee);
	return (
		memberName(callee) === methodName &&
		isUnshadowedGlobal(model, memberObject(callee), globalName)
	);
}

/** The call's arguments in source order. */
export function callArguments(call: JsCallExpression): readonly AnyJsAstNode[] {
	return call.arguments?.args ?? [];
}

/** The nearest ancestor of one of the given kinds. */
export function closestAncestor<K extends AnyJsAstNode["kind"]>(
	node: AnyJsAstNode,
	kinds: readonly K[],
): Extract<AnyJsAstNode, { kind: K }> | undefined {
	for (const ancestor of node.ancestors()) {
		if ((kinds as readonly string[]).includes(ancestor.kind)) {
			// SAFETY: the kind check above selects exactly the members of the union with a requested kind.
			return ancestor as Extract<AnyJsAstNode, { kind: K }>;
		}
	}
	return undefined;
}

/** Yields every descendant node in pre-order, excluding `node` itself. */
export function* descendants(node: AnyJsAstNode): Generator<AnyJsAstNode> {
	for (const child of node.children()) {
		yield child;
		yield* descendants(child);
	}
}
