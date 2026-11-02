import type {
	AnyJsAstNode,
	AnyJsExpression,
	AnyTsType,
	Binding,
	JsVariableDeclarator,
	SemanticModel,
} from "@biomejs/runtime/plugin";

import { sameNode } from "./same-node.ts";
import { memberName, memberObject } from "./syntax.ts";

/** Unwrap syntax-only wrappers when inspecting array methods and accumulator references. */
export function unwrapArrayExpression(
	expression: AnyJsAstNode | undefined,
): AnyJsAstNode | undefined {
	let current = expression;
	while (
		current?.kind === "JS_PARENTHESIZED_EXPRESSION" ||
		current?.kind === "TS_AS_EXPRESSION" ||
		current?.kind === "TS_TYPE_ASSERTION_EXPRESSION" ||
		current?.kind === "TS_NON_NULL_ASSERTION_EXPRESSION" ||
		current?.kind === "TS_SATISFIES_EXPRESSION"
	) {
		current = current.expression;
	}
	return current;
}

/** Whether a node is one of the wrappers removed by {@link unwrapArrayExpression}. */
export function isArrayExpressionWrapper(node: AnyJsAstNode): boolean {
	return WRAPPER_KINDS.has(node.kind);
}

const WRAPPER_KINDS = new Set<string>([
	"JS_PARENTHESIZED_EXPRESSION",
	"TS_AS_EXPRESSION",
	"TS_TYPE_ASSERTION_EXPRESSION",
	"TS_NON_NULL_ASSERTION_EXPRESSION",
	"TS_SATISFIES_EXPRESSION",
]);

/** Resolve a local binding through the semantic model, not by identifier spelling. */
export function resolveArrayBinding(
	model: SemanticModel,
	expression: AnyJsAstNode | undefined,
): Binding | undefined {
	const unwrapped = unwrapArrayExpression(expression);
	if (unwrapped?.kind !== "JS_IDENTIFIER_EXPRESSION" || !unwrapped.name)
		return undefined;
	return model.binding(unwrapped.name);
}

export interface ArrayMethodTarget {
	readonly name: string;
	readonly object: AnyJsExpression | undefined;
}

/** Read static method names, including computed string literals, without evaluating expressions. */
export function arrayMethodTarget(
	expression: AnyJsAstNode | undefined,
): ArrayMethodTarget | undefined {
	const unwrapped = unwrapArrayExpression(expression);
	const name = memberName(unwrapped);
	if (name === undefined) return undefined;
	return { name, object: memberObject(unwrapped) };
}

/** Whether two bindings are the same declaration. */
export function sameBinding(left: Binding, right: Binding): boolean {
	return sameNode(left.syntax(), right.syntax());
}

/**
 * The declarator of a `const name = init` binding that is never reassigned,
 * which lets checks follow the alias to its initializer.
 *
 * With `allowDestructuring`, a name bound by a destructuring pattern, such as
 * `header` in `const { header } = decode(token)`, also resolves to its
 * declarator, so the whole initializer stands in as its evidence. This matches
 * the upstream rules that follow any variable declarator.
 */
export function constAliasDeclarator(
	binding: Binding,
	{ allowDestructuring = false }: { allowDestructuring?: boolean } = {},
): JsVariableDeclarator | undefined {
	if (binding.allWrites().length > 0) return undefined;
	let declarator = binding.syntax().parent;
	if (allowDestructuring) {
		while (declarator?.kind.includes("_BINDING_PATTERN")) {
			declarator = declarator.parent;
		}
	}
	if (declarator?.kind !== "JS_VARIABLE_DECLARATOR") return undefined;
	if (!allowDestructuring && declarator.id?.kind !== "JS_IDENTIFIER_BINDING") {
		return undefined;
	}
	const declaration = declarator.parent?.parent;
	if (
		declaration?.kind !== "JS_VARIABLE_DECLARATION" ||
		declaration.kindToken !== "const"
	) {
		return undefined;
	}
	return declarator.initializer?.expression ? declarator : undefined;
}

function isArrayAnnotation(type: AnyTsType | undefined): boolean {
	if (type?.kind === "TS_ARRAY_TYPE" || type?.kind === "TS_TUPLE_TYPE")
		return true;
	if (type?.kind === "TS_PARENTHESIZED_TYPE") return isArrayAnnotation(type.ty);
	if (
		type?.kind === "TS_TYPE_OPERATOR_TYPE" &&
		type.operatorToken === "readonly"
	) {
		return isArrayAnnotation(type.ty);
	}
	if (
		type?.kind !== "TS_REFERENCE_TYPE" ||
		type.name?.kind !== "JS_REFERENCE_IDENTIFIER"
	) {
		return false;
	}
	const name = type.name.valueToken;
	return name === "Array" || name === "ReadonlyArray";
}

/** The type annotation written on a binding's own declaration, if any. */
function declaredAnnotation(binding: Binding): AnyTsType | undefined {
	const owner = binding.syntax().parent;
	if (owner?.kind === "JS_FORMAL_PARAMETER") return owner.typeAnnotation?.ty;
	if (owner?.kind !== "JS_VARIABLE_DECLARATOR") return undefined;
	const annotation = owner.variableAnnotation;
	// `let name!: Type` wraps the annotation in a definite-assignment marker.
	return annotation?.kind === "TS_DEFINITE_VARIABLE_ANNOTATION"
		? annotation.typeAnnotation?.ty
		: annotation?.ty;
}

const ARRAY_RETURNING_METHODS = new Set([
	"map",
	"filter",
	"flatMap",
	"slice",
	"concat",
	"toSorted",
	"toReversed",
	"toSpliced",
]);

/** Recognize local array evidence; unknown receivers and iterator pipelines are deliberately excluded. */
export function isKnownArrayExpression(
	model: SemanticModel,
	expression: AnyJsAstNode | undefined,
	visited: Binding[] = [],
): boolean {
	const node = unwrapArrayExpression(expression);
	if (node?.kind === "JS_ARRAY_EXPRESSION") return true;
	if (node?.kind === "JS_CALL_EXPRESSION") {
		const method = arrayMethodTarget(node.callee);
		return (
			method !== undefined &&
			ARRAY_RETURNING_METHODS.has(method.name) &&
			isKnownArrayExpression(model, method.object, visited)
		);
	}
	const binding = resolveArrayBinding(model, node);
	if (
		binding === undefined ||
		visited.some((seen) => sameBinding(seen, binding))
	)
		return false;
	visited.push(binding);
	if (binding.allWrites().length > 0) return false;
	const annotation = declaredAnnotation(binding);
	if (annotation !== undefined) return isArrayAnnotation(annotation);
	const declarator = constAliasDeclarator(binding);
	return (
		declarator !== undefined &&
		isKnownArrayExpression(model, declarator.initializer?.expression, visited)
	);
}
