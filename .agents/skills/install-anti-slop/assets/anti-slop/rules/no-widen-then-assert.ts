import type {
	AnyJsAstNode,
	AnyJsExpression,
	AnyTsType,
	Binding,
	SemanticModel,
	TsAsExpression,
	TsTypeAssertionExpression,
} from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";
import { constAliasDeclarator, sameBinding } from "../shared/array-method.ts";
import { report } from "../shared/report.ts";
import { sameNode } from "../shared/same-node.ts";
import { SourceIndex } from "../shared/source.ts";
import { closestAncestor, unwrapParentheses } from "../shared/syntax.ts";
import {
	typeReferenceArguments,
	typeReferenceName,
} from "../shared/type-alias-resolution.ts";

type BroadTypeKind = "top" | "object" | "record";

type Assertion = TsAsExpression | TsTypeAssertionExpression;

/** What is known about a value: its explicit type, if one was written. */
interface KnownValueEvidence {
	readonly type: AnyTsType | undefined;
}

/**
 * Functions with a body. Flows are followed only within one of these (or only
 * at the top level), because a nested function can run at any later time.
 */
const FUNCTION_BOUNDARY_KINDS = [
	"JS_ARROW_FUNCTION_EXPRESSION",
	"JS_FUNCTION_DECLARATION",
	"JS_FUNCTION_EXPORT_DEFAULT_DECLARATION",
	"JS_FUNCTION_EXPRESSION",
	"JS_METHOD_CLASS_MEMBER",
	"JS_METHOD_OBJECT_MEMBER",
	"JS_CONSTRUCTOR_CLASS_MEMBER",
	"JS_GETTER_CLASS_MEMBER",
	"JS_GETTER_OBJECT_MEMBER",
	"JS_SETTER_CLASS_MEMBER",
	"JS_SETTER_OBJECT_MEMBER",
] as const;

type FunctionBoundary = ReturnType<typeof functionBoundary>;

function unwrapTypeParentheses(type: AnyTsType): AnyTsType {
	let current = type;
	while (current.kind === "TS_PARENTHESIZED_TYPE" && current.ty !== undefined) {
		current = current.ty;
	}
	return current;
}

function isUnknownOrAnyType(type: AnyTsType | undefined): boolean {
	if (type === undefined) return false;
	const unwrapped = unwrapTypeParentheses(type);
	return (
		unwrapped.kind === "TS_UNKNOWN_TYPE" || unwrapped.kind === "TS_ANY_TYPE"
	);
}

function isBroadRecordKeyType(type: AnyTsType | undefined): boolean {
	if (type === undefined) return false;
	const unwrapped = unwrapTypeParentheses(type);
	if (
		unwrapped.kind === "TS_STRING_TYPE" ||
		unwrapped.kind === "TS_NUMBER_TYPE" ||
		unwrapped.kind === "TS_SYMBOL_TYPE"
	) {
		return true;
	}
	if (unwrapped.kind === "TS_UNION_TYPE") {
		return unwrapped.types.every(isBroadRecordKeyType);
	}
	return (
		unwrapped.kind === "TS_REFERENCE_TYPE" &&
		typeReferenceName(unwrapped) === "PropertyKey"
	);
}

/**
 * `Record<string, unknown>`, `Readonly<...>` of one, or a type literal with a
 * single broad-key index signature to `unknown` or `any`. Recognized by
 * spelling, as in the Oxlint original.
 */
function isBroadRecordType(type: AnyTsType | undefined): boolean {
	if (type === undefined) return false;
	const unwrapped = unwrapTypeParentheses(type);
	if (unwrapped.kind === "TS_REFERENCE_TYPE") {
		const name = typeReferenceName(unwrapped);
		const parameters = typeReferenceArguments(unwrapped);
		if (name === "Readonly") return isBroadRecordType(parameters[0]);
		return (
			name === "Record" &&
			parameters.length === 2 &&
			isBroadRecordKeyType(parameters[0]) &&
			isUnknownOrAnyType(parameters[1])
		);
	}
	if (unwrapped.kind !== "TS_OBJECT_TYPE" || unwrapped.members.length !== 1) {
		return false;
	}
	const [member] = unwrapped.members;
	return (
		member?.kind === "TS_INDEX_SIGNATURE_TYPE_MEMBER" &&
		isBroadRecordKeyType(member.parameter?.typeAnnotation?.ty) &&
		isUnknownOrAnyType(member.typeAnnotation?.ty)
	);
}

function broadTypeKind(type: AnyTsType | undefined): BroadTypeKind | undefined {
	if (type === undefined) return undefined;
	const unwrapped = unwrapTypeParentheses(type);
	if (
		unwrapped.kind === "TS_UNKNOWN_TYPE" ||
		unwrapped.kind === "TS_ANY_TYPE"
	) {
		return "top";
	}
	if (unwrapped.kind === "TS_NON_PRIMITIVE_TYPE") return "object";
	return isBroadRecordType(unwrapped) ? "record" : undefined;
}

function assertionFromExpression(
	expression: AnyJsExpression | undefined,
): Assertion | undefined {
	const unwrapped = unwrapParentheses(expression);
	return unwrapped?.kind === "TS_AS_EXPRESSION" ||
		unwrapped?.kind === "TS_TYPE_ASSERTION_EXPRESSION"
		? unwrapped
		: undefined;
}

function normalizedTypeText(type: AnyTsType): string {
	return unwrapTypeParentheses(type).text.replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(
	left: AnyTsType | undefined,
	right: AnyTsType,
): boolean {
	return (
		left !== undefined && normalizedTypeText(left) === normalizedTypeText(right)
	);
}

function isDefinitelyObjectType(type: AnyTsType | undefined): boolean {
	if (type === undefined) return false;
	const unwrapped = unwrapTypeParentheses(type);
	switch (unwrapped.kind) {
		case "TS_ARRAY_TYPE":
		case "TS_CONSTRUCTOR_TYPE":
		case "TS_FUNCTION_TYPE":
		case "TS_MAPPED_TYPE":
		case "TS_NON_PRIMITIVE_TYPE":
		case "TS_TUPLE_TYPE":
			return true;
		case "TS_OBJECT_TYPE":
			return unwrapped.members.length > 0;
		case "TS_INTERSECTION_TYPE":
			return unwrapped.types.every(isDefinitelyObjectType);
		case "TS_TYPE_OPERATOR_TYPE":
			return (
				unwrapped.operatorToken === "readonly" &&
				isDefinitelyObjectType(unwrapped.ty)
			);
		default:
			return false;
	}
}

function isDefinitelyNarrowerRecordType(type: AnyTsType | undefined): boolean {
	if (type === undefined) return false;
	const unwrapped = unwrapTypeParentheses(type);
	if (unwrapped.kind === "TS_OBJECT_TYPE") {
		return unwrapped.members.some(
			(member) => member.kind !== "TS_INDEX_SIGNATURE_TYPE_MEMBER",
		);
	}
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return false;
	const name = typeReferenceName(unwrapped);
	const parameters = typeReferenceArguments(unwrapped);
	if (name === "Readonly") return isDefinitelyNarrowerRecordType(parameters[0]);
	return (
		name === "Record" &&
		parameters.length === 2 &&
		parameters[1] !== undefined &&
		!isUnknownOrAnyType(parameters[1])
	);
}

function functionBoundary(node: AnyJsAstNode) {
	return closestAncestor(node, FUNCTION_BOUNDARY_KINDS);
}

function sameBoundary(
	left: FunctionBoundary,
	right: FunctionBoundary,
): boolean {
	if (left === undefined || right === undefined) {
		return left === undefined && right === undefined;
	}
	return sameNode(left, right);
}

/** The type written on a binding's own declaration: a declarator or a parameter. */
function declaredAnnotation(binding: Binding): AnyTsType | undefined {
	const owner = binding.syntax().parent;
	if (
		owner?.kind === "JS_FORMAL_PARAMETER" ||
		owner?.kind === "JS_REST_PARAMETER" ||
		owner?.kind === "JS_CATCH_DECLARATION"
	) {
		return owner.typeAnnotation?.ty;
	}
	if (owner?.kind !== "JS_VARIABLE_DECLARATOR") return undefined;
	const annotation = owner.variableAnnotation;
	return annotation?.kind === "TS_DEFINITE_VARIABLE_ANNOTATION"
		? annotation.typeAnnotation?.ty
		: annotation?.ty;
}

function isKnownValueSyntax(expression: AnyJsExpression): boolean {
	switch (expression.kind) {
		case "JS_BIGINT_LITERAL_EXPRESSION":
		case "JS_BOOLEAN_LITERAL_EXPRESSION":
		case "JS_NULL_LITERAL_EXPRESSION":
		case "JS_NUMBER_LITERAL_EXPRESSION":
		case "JS_REGEX_LITERAL_EXPRESSION":
		case "JS_STRING_LITERAL_EXPRESSION":
		case "JS_ARRAY_EXPRESSION":
		case "JS_ARROW_FUNCTION_EXPRESSION":
		case "JS_CLASS_EXPRESSION":
		case "JS_FUNCTION_EXPRESSION":
		case "JS_NEW_EXPRESSION":
		case "JS_OBJECT_EXPRESSION":
			return true;
		case "JS_TEMPLATE_EXPRESSION":
			return expression.tag === undefined;
		default:
			return false;
	}
}

/**
 * What an expression is known to be, in the same function as the widening
 * binding: a narrow assertion's type, a literal-like value, a non-broad
 * annotated variable or parameter, or a never-reassigned `const` alias of one.
 */
function knownValueEvidence(
	model: SemanticModel,
	expression: AnyJsExpression | undefined,
	boundary: FunctionBoundary,
	visited: readonly Binding[],
): KnownValueEvidence | undefined {
	const unwrapped = unwrapParentheses(expression);
	if (unwrapped === undefined) return undefined;

	if (
		unwrapped.kind === "TS_AS_EXPRESSION" ||
		unwrapped.kind === "TS_TYPE_ASSERTION_EXPRESSION"
	) {
		const type = unwrapped.ty;
		return type === undefined || broadTypeKind(type) !== undefined
			? undefined
			: { type };
	}

	if (isKnownValueSyntax(unwrapped)) return { type: undefined };

	if (unwrapped.kind !== "JS_IDENTIFIER_EXPRESSION") return undefined;
	const reference = unwrapped.name;
	const binding =
		reference === undefined ? undefined : model.binding(reference);
	if (
		binding === undefined ||
		visited.some((seen) => sameBinding(seen, binding))
	) {
		return undefined;
	}

	const annotation = declaredAnnotation(binding);
	if (annotation !== undefined) {
		if (
			!sameBoundary(functionBoundary(binding.syntax()), boundary) ||
			broadTypeKind(annotation) !== undefined
		) {
			return undefined;
		}
		return { type: annotation };
	}

	const declarator = constAliasDeclarator(binding, {
		allowDestructuring: true,
	});
	if (
		declarator === undefined ||
		!sameBoundary(functionBoundary(declarator), boundary)
	) {
		return undefined;
	}
	return knownValueEvidence(
		model,
		declarator.initializer?.expression,
		boundary,
		[...visited, binding],
	);
}

interface WidenedBinding {
	readonly broadKind: BroadTypeKind;
	readonly evidence: KnownValueEvidence;
	/** Offset in the source index where the declarator ends. */
	readonly declaredAt: number;
	readonly boundary: FunctionBoundary;
}

/**
 * A never-reassigned `const` binding whose annotation or initializer assertion
 * widens known evidence to a broad type, such as
 * `const stored: unknown = { id: 1 }` or `const stored = loaded as unknown`.
 */
function widenedBinding(
	model: SemanticModel,
	index: SourceIndex,
	binding: Binding,
): WidenedBinding | undefined {
	const declarator = constAliasDeclarator(binding);
	const initializer = declarator?.initializer?.expression;
	if (declarator === undefined || initializer === undefined) return undefined;

	const initializerAssertion = assertionFromExpression(initializer);
	const initializerBroadKind = broadTypeKind(initializerAssertion?.ty);
	const broadKind =
		broadTypeKind(declaredAnnotation(binding)) ?? initializerBroadKind;
	if (broadKind === undefined) return undefined;

	const located = index.find(declarator);
	if (located === undefined) return undefined;
	const boundary = functionBoundary(declarator);
	const originalExpression =
		initializerAssertion !== undefined && initializerBroadKind !== undefined
			? initializerAssertion.expression
			: initializer;
	const evidence = knownValueEvidence(model, originalExpression, boundary, [
		binding,
	]);
	return evidence === undefined
		? undefined
		: { broadKind, evidence, declaredAt: located.end, boundary };
}

function assertionIsNarrower(
	broadKind: BroadTypeKind,
	evidence: KnownValueEvidence,
	assertedType: AnyTsType,
): boolean {
	if (broadTypeKind(assertedType) !== undefined) return false;
	if (broadKind === "top") return true;
	if (typesHaveSameSyntax(evidence.type, assertedType)) return true;
	if (broadKind === "object") return isDefinitelyObjectType(assertedType);
	return isDefinitelyNarrowerRecordType(assertedType);
}

function message(name: string): string {
	return `Binding "${name}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.`;
}

/** Detect immutable local bindings that erase a known type and are later asserted back to a narrower type. */
export const noWidenThenAssert = defineRule({
	query: semantic("JS_MODULE", "JS_SCRIPT"),
	run(root, context) {
		const model = context.model;
		const index = new SourceIndex(root);
		for (const entry of index.nodes) {
			const node = entry.node;
			if (
				node.kind !== "TS_AS_EXPRESSION" &&
				node.kind !== "TS_TYPE_ASSERTION_EXPRESSION"
			) {
				continue;
			}
			const assertedType = node.ty;
			const expression = unwrapParentheses(node.expression);
			if (
				assertedType === undefined ||
				expression?.kind !== "JS_IDENTIFIER_EXPRESSION" ||
				expression.name === undefined
			) {
				continue;
			}
			const binding = model.binding(expression.name);
			if (binding === undefined) continue;
			const widened = widenedBinding(model, index, binding);
			if (
				widened === undefined ||
				entry.start <= widened.declaredAt ||
				!sameBoundary(functionBoundary(node), widened.boundary) ||
				!assertionIsNarrower(widened.broadKind, widened.evidence, assertedType)
			) {
				continue;
			}
			report(
				"noWidenThenAssert",
				node,
				message(expression.name.valueToken ?? expression.text),
			);
		}
	},
});
