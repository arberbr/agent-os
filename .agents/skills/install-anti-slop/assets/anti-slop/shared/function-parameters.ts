import type {
	AnyJsBinding,
	AnyJsParameter,
	AnyTsReturnType,
	AnyTsType,
	JsNodeByKind,
	TsPropertyParameter,
	TsTypeAnnotation,
} from "@biomejs/runtime/plugin";

/**
 * A single function parameter: a formal, rest, `this`, or constructor
 * property parameter, or the bare binding of an unparenthesized arrow
 * parameter such as `value => value`.
 */
export type FunctionParameter =
	| AnyJsParameter
	| TsPropertyParameter
	| AnyJsBinding;

/**
 * Every node kind that declares a parameter list or a return type: function
 * declarations and expressions, arrows, class and object methods, getters,
 * setters, constructors, overload and abstract signatures, `declare`
 * functions, and call, construct, method, getter, and setter signatures in
 * type literals and interfaces, plus function and constructor types. This is
 * the Biome equivalent of the ESTree function visitors (`Function`,
 * `ArrowFunctionExpression`, `TSDeclareFunction`,
 * `TSEmptyBodyFunctionExpression`, `TSMethodSignature`, and the TS signature
 * and function types). Pass it to `semantic(...FUNCTION_LIKE_KINDS)`.
 */
export const FUNCTION_LIKE_KINDS = [
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
	"TS_CONSTRUCTOR_SIGNATURE_CLASS_MEMBER",
	"TS_METHOD_SIGNATURE_CLASS_MEMBER",
	"TS_GETTER_SIGNATURE_CLASS_MEMBER",
	"TS_SETTER_SIGNATURE_CLASS_MEMBER",
	"TS_DECLARE_FUNCTION_DECLARATION",
	"TS_DECLARE_FUNCTION_EXPORT_DEFAULT_DECLARATION",
	"TS_CALL_SIGNATURE_TYPE_MEMBER",
	"TS_CONSTRUCT_SIGNATURE_TYPE_MEMBER",
	"TS_METHOD_SIGNATURE_TYPE_MEMBER",
	"TS_GETTER_SIGNATURE_TYPE_MEMBER",
	"TS_SETTER_SIGNATURE_TYPE_MEMBER",
	"TS_FUNCTION_TYPE",
	"TS_CONSTRUCTOR_TYPE",
] as const;

/** A node of one of the `FUNCTION_LIKE_KINDS`. */
export type FunctionLike = JsNodeByKind[(typeof FUNCTION_LIKE_KINDS)[number]];

/** A function-like node's parameters in source order, including any `this` parameter. */
export function functionLikeParameters(
	node: FunctionLike,
): readonly FunctionParameter[] {
	switch (node.kind) {
		case "JS_ARROW_FUNCTION_EXPRESSION": {
			const parameters = node.parameters;
			if (parameters === undefined) return [];
			return parameters.kind === "JS_PARAMETERS"
				? parameters.items
				: [parameters];
		}
		case "JS_CONSTRUCTOR_CLASS_MEMBER":
		case "TS_CONSTRUCTOR_SIGNATURE_CLASS_MEMBER":
			return node.parameters?.parameters ?? [];
		case "JS_GETTER_CLASS_MEMBER":
		case "JS_GETTER_OBJECT_MEMBER":
		case "TS_GETTER_SIGNATURE_CLASS_MEMBER":
		case "TS_GETTER_SIGNATURE_TYPE_MEMBER":
			return [];
		case "JS_SETTER_CLASS_MEMBER":
		case "JS_SETTER_OBJECT_MEMBER":
		case "TS_SETTER_SIGNATURE_CLASS_MEMBER":
		case "TS_SETTER_SIGNATURE_TYPE_MEMBER":
			return node.parameter === undefined ? [] : [node.parameter];
		default:
			return node.parameters?.items ?? [];
	}
}

/**
 * A function-like node's explicit return contract, which may be a type
 * predicate (`value is T`) or an assertion signature (`asserts value`).
 * Constructors and setters have none.
 */
export function functionLikeReturnType(
	node: FunctionLike,
): AnyTsReturnType | undefined {
	switch (node.kind) {
		case "JS_CONSTRUCTOR_CLASS_MEMBER":
		case "TS_CONSTRUCTOR_SIGNATURE_CLASS_MEMBER":
		case "JS_SETTER_CLASS_MEMBER":
		case "JS_SETTER_OBJECT_MEMBER":
		case "TS_SETTER_SIGNATURE_CLASS_MEMBER":
		case "TS_SETTER_SIGNATURE_TYPE_MEMBER":
			return undefined;
		case "JS_GETTER_CLASS_MEMBER":
		case "JS_GETTER_OBJECT_MEMBER":
		case "TS_GETTER_SIGNATURE_CLASS_MEMBER":
			return node.returnType?.ty;
		case "TS_GETTER_SIGNATURE_TYPE_MEMBER":
		case "TS_CONSTRUCT_SIGNATURE_TYPE_MEMBER":
			return node.typeAnnotation?.ty;
		case "TS_FUNCTION_TYPE":
		case "TS_CONSTRUCTOR_TYPE":
			return node.returnType;
		default:
			return node.returnTypeAnnotation?.ty;
	}
}

/** Reports whether a type is or contains TypeScript's absorbing `unknown` top type. */
export function containsUnknownType(type: AnyTsType): boolean {
	if (type.kind === "TS_UNKNOWN_TYPE") return true;
	if (type.kind === "TS_PARENTHESIZED_TYPE") {
		return type.ty !== undefined && containsUnknownType(type.ty);
	}
	return type.kind === "TS_UNION_TYPE" && type.types.some(containsUnknownType);
}

/**
 * The TypeScript annotation on a parameter, looking through constructor
 * property modifiers such as `private readonly`.
 */
export function functionParameterTypeAnnotation(
	parameter: FunctionParameter,
): TsTypeAnnotation | undefined {
	switch (parameter.kind) {
		case "TS_PROPERTY_PARAMETER":
			return parameter.formalParameter === undefined
				? undefined
				: functionParameterTypeAnnotation(parameter.formalParameter);
		case "JS_FORMAL_PARAMETER":
		case "JS_REST_PARAMETER":
		case "TS_THIS_PARAMETER":
			return parameter.typeAnnotation;
		default:
			return undefined;
	}
}

/**
 * The source of a parameter's local binding alone, without modifiers, `...`,
 * annotation, or default value: `value` for `value: T = x`, `{ value }` for a
 * destructured parameter, and `this` for a `this` parameter.
 */
export function functionParameterBindingName(
	parameter: FunctionParameter,
): string {
	switch (parameter.kind) {
		case "TS_PROPERTY_PARAMETER":
			return parameter.formalParameter === undefined
				? parameter.text
				: functionParameterBindingName(parameter.formalParameter);
		case "JS_FORMAL_PARAMETER":
		case "JS_REST_PARAMETER": {
			const binding = parameter.binding;
			if (binding === undefined) return parameter.text;
			return binding.kind === "JS_IDENTIFIER_BINDING"
				? (binding.nameToken ?? binding.text)
				: binding.text;
		}
		case "TS_THIS_PARAMETER":
			return "this";
		case "JS_IDENTIFIER_BINDING":
			return parameter.nameToken ?? parameter.text;
		default:
			return parameter.text;
	}
}
