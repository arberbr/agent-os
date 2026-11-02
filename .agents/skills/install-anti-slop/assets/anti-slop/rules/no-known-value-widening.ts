import type {
	AnyJsAstNode,
	AnyJsClassMemberName,
	AnyJsExpression,
	AnyJsObjectMemberName,
	AnyTsPropertyAnnotation,
	AnyTsReturnType,
	AnyTsType,
	AnyTsVariableAnnotation,
	Binding,
	JsCallExpression,
	SemanticModel,
} from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";
import { constAliasDeclarator, sameBinding } from "../shared/array-method.ts";
import type {
	TypeEnvironment,
	WideningTarget,
} from "../shared/dictionary-types.ts";
import {
	classifyUnsafeDictionaryValue,
	classifyWideningTarget,
	createTypeEnvironment,
	isKnownEvidenceExpression,
} from "../shared/dictionary-types.ts";
import type {
	FunctionLike,
	FunctionParameter,
} from "../shared/function-parameters.ts";
import {
	containsUnknownType,
	functionLikeParameters,
	functionLikeReturnType,
	functionParameterBindingName,
	functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { report } from "../shared/report.ts";
import { closestAncestor, stringLiteralValue } from "../shared/syntax.ts";
import { unwrapDeclarationStatement } from "../shared/type-alias-resolution.ts";

const RULE_NAME = "noKnownValueWidening";

/**
 * Functions with a body, whose explicit return type receives the values of
 * the `return` statements directly inside them.
 */
const BODY_FUNCTION_KINDS = [
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

/** A local function a call can invoke: a declaration, a `declare` signature, or a function value. */
type CallableFunction = Extract<
	FunctionLike,
	{
		kind:
			| "JS_ARROW_FUNCTION_EXPRESSION"
			| "JS_FUNCTION_DECLARATION"
			| "JS_FUNCTION_EXPORT_DEFAULT_DECLARATION"
			| "JS_FUNCTION_EXPRESSION"
			| "TS_DECLARE_FUNCTION_DECLARATION"
			| "TS_DECLARE_FUNCTION_EXPORT_DEFAULT_DECLARATION";
	}
>;

/** Removes parentheses, assertions, `satisfies`, and non-null assertions. */
function unwrapExpression(
	expression: AnyJsExpression | undefined,
): AnyJsExpression | undefined {
	let current = expression;
	while (
		current?.kind === "JS_PARENTHESIZED_EXPRESSION" ||
		current?.kind === "TS_AS_EXPRESSION" ||
		current?.kind === "TS_SATISFIES_EXPRESSION" ||
		current?.kind === "TS_TYPE_ASSERTION_EXPRESSION" ||
		current?.kind === "TS_NON_NULL_ASSERTION_EXPRESSION"
	) {
		current = current.expression;
	}
	return current;
}

/** The local binding an identifier expression resolves to. */
function identifierBinding(
	model: SemanticModel,
	expression: AnyJsExpression | undefined,
): Binding | undefined {
	if (expression?.kind !== "JS_IDENTIFIER_EXPRESSION") return undefined;
	const reference = expression.name;
	return reference === undefined ? undefined : model.binding(reference);
}

/**
 * Whether an expression is known evidence: a literal-like expression, or a
 * never-reassigned `const` alias whose initializer is.
 */
function hasKnownEvidence(
	model: SemanticModel,
	expression: AnyJsExpression,
	visited: Binding[] = [],
): boolean {
	if (isKnownEvidenceExpression(expression)) return true;
	const binding = identifierBinding(model, unwrapExpression(expression));
	if (
		binding === undefined ||
		visited.some((seen) => sameBinding(seen, binding))
	) {
		return false;
	}
	const initializer = constAliasDeclarator(binding, {
		allowDestructuring: true,
	})?.initializer?.expression;
	if (initializer === undefined) return false;
	visited.push(binding);
	return hasKnownEvidence(model, initializer, visited);
}

function isCallableFunction(
	node: AnyJsAstNode | undefined,
): node is CallableFunction {
	return (
		node?.kind === "JS_ARROW_FUNCTION_EXPRESSION" ||
		node?.kind === "JS_FUNCTION_DECLARATION" ||
		node?.kind === "JS_FUNCTION_EXPORT_DEFAULT_DECLARATION" ||
		node?.kind === "JS_FUNCTION_EXPRESSION" ||
		node?.kind === "TS_DECLARE_FUNCTION_DECLARATION" ||
		node?.kind === "TS_DECLARE_FUNCTION_EXPORT_DEFAULT_DECLARATION"
	);
}

/** The name declared by a function declaration or `declare function` signature. */
function declaredFunctionName(
	node: AnyJsAstNode | undefined,
): string | undefined {
	if (
		node?.kind !== "JS_FUNCTION_DECLARATION" &&
		node?.kind !== "TS_DECLARE_FUNCTION_DECLARATION"
	) {
		return undefined;
	}
	const id = node.id;
	return id?.kind === "JS_IDENTIFIER_BINDING" ? id.nameToken : undefined;
}

/**
 * Whether a function name has several declarations in its statement list,
 * such as overload signatures. The Oxlint original resolved only names with a
 * single definition.
 */
function hasSeveralDeclarations(declaration: CallableFunction): boolean {
	const name = declaredFunctionName(declaration);
	if (name === undefined) return false;
	let container = declaration.parent;
	while (
		container?.kind === "JS_EXPORT" ||
		container?.kind === "TS_DECLARE_STATEMENT" ||
		container?.kind === "TS_EXPORT_DECLARE_CLAUSE"
	) {
		container = container.parent;
	}
	if (container === undefined) return false;
	const count = container
		.children()
		.filter(
			(statement) =>
				declaredFunctionName(unwrapDeclarationStatement(statement)) === name,
		).length;
	return count > 1;
}

/**
 * The same-file function a call invokes: an inline function value, a function
 * declaration or `declare function`, or a variable initialized with a
 * function value.
 */
function localFunctionForCall(
	model: SemanticModel,
	callee: AnyJsExpression | undefined,
): CallableFunction | undefined {
	const unwrapped = unwrapExpression(callee);
	if (isCallableFunction(unwrapped)) return unwrapped;
	const binding = identifierBinding(model, unwrapped);
	const declaration = binding?.syntax().parent;
	if (isCallableFunction(declaration)) {
		return hasSeveralDeclarations(declaration) ? undefined : declaration;
	}
	if (declaration?.kind !== "JS_VARIABLE_DECLARATOR") return undefined;
	const initializer = unwrapExpression(declaration.initializer?.expression);
	return isCallableFunction(initializer) ? initializer : undefined;
}

function variableAnnotationType(
	annotation: AnyTsVariableAnnotation | undefined,
): AnyTsType | undefined {
	return annotation?.kind === "TS_DEFINITE_VARIABLE_ANNOTATION"
		? annotation.typeAnnotation?.ty
		: annotation?.ty;
}

function propertyAnnotationType(
	annotation: AnyTsPropertyAnnotation | undefined,
): AnyTsType | undefined {
	return annotation?.kind === "TS_TYPE_ANNOTATION"
		? annotation.ty
		: annotation?.typeAnnotation?.ty;
}

/** The type written on a variable's declarator or on a function parameter. */
function bindingTypeAnnotation(binding: Binding): AnyTsType | undefined {
	const owner = binding.syntax().parent;
	if (owner?.kind === "JS_VARIABLE_DECLARATOR") {
		return variableAnnotationType(owner.variableAnnotation);
	}
	if (
		owner?.kind === "JS_FORMAL_PARAMETER" ||
		owner?.kind === "JS_REST_PARAMETER"
	) {
		return owner.typeAnnotation?.ty;
	}
	return undefined;
}

/** A type that names something concrete rather than an `unknown`-like escape hatch. */
function hasInformativeType(
	type: AnyTsType | undefined,
	environment: TypeEnvironment,
): boolean {
	return (
		type !== undefined &&
		classifyUnsafeDictionaryValue(type, environment) === undefined
	);
}

/** Type predicates and assertion signatures name the narrowed type, so they are informative. */
function hasInformativeReturnType(
	type: AnyTsReturnType | undefined,
	environment: TypeEnvironment,
): boolean {
	if (type === undefined) return false;
	if (
		type.kind === "TS_PREDICATE_RETURN_TYPE" ||
		type.kind === "TS_ASSERTS_RETURN_TYPE"
	) {
		return true;
	}
	return hasInformativeType(type, environment);
}

/**
 * Whether a call argument's type is already known: an assertion to an
 * informative type, a call to a local function with an informative return
 * type, an informatively annotated variable or parameter, known evidence, or
 * a `const` alias of one of those.
 */
function hasKnownCallArgumentEvidence(
	model: SemanticModel,
	expression: AnyJsExpression | undefined,
	environment: TypeEnvironment,
	visited: Binding[] = [],
): boolean {
	if (expression === undefined) return false;
	switch (expression.kind) {
		case "JS_PARENTHESIZED_EXPRESSION":
		case "TS_NON_NULL_ASSERTION_EXPRESSION":
		case "TS_SATISFIES_EXPRESSION":
			return hasKnownCallArgumentEvidence(
				model,
				expression.expression,
				environment,
				visited,
			);
		case "TS_AS_EXPRESSION":
		case "TS_TYPE_ASSERTION_EXPRESSION":
			return hasInformativeType(expression.ty, environment);
		case "JS_CALL_EXPRESSION": {
			const owner = localFunctionForCall(model, expression.callee);
			return (
				owner !== undefined &&
				hasInformativeReturnType(functionLikeReturnType(owner), environment)
			);
		}
		case "JS_IDENTIFIER_EXPRESSION":
			break;
		default:
			return isKnownEvidenceExpression(expression);
	}
	const binding = identifierBinding(model, expression);
	if (
		binding === undefined ||
		visited.some((seen) => sameBinding(seen, binding))
	) {
		return false;
	}
	const annotation = bindingTypeAnnotation(binding);
	if (annotation !== undefined)
		return hasInformativeType(annotation, environment);
	const initializer = constAliasDeclarator(binding, {
		allowDestructuring: true,
	})?.initializer?.expression;
	if (initializer === undefined) return false;
	visited.push(binding);
	return hasKnownCallArgumentEvidence(model, initializer, environment, visited);
}

/** Parameters that receive call arguments, so a `this` parameter is skipped. */
function argumentParameters(
	owner: CallableFunction,
): readonly FunctionParameter[] {
	return functionLikeParameters(owner).filter(
		(parameter) => parameter.kind !== "TS_THIS_PARAMETER",
	);
}

/** The parameter narrowed by the function's `value is T` or `asserts value` return contract. */
function typePredicateSubject(
	owner: CallableFunction,
):
	| { readonly parameter: FunctionParameter; readonly index: number }
	| undefined {
	const predicate = functionLikeReturnType(owner);
	if (
		predicate?.kind !== "TS_PREDICATE_RETURN_TYPE" &&
		predicate?.kind !== "TS_ASSERTS_RETURN_TYPE"
	) {
		return undefined;
	}
	const subject = predicate.parameterName;
	if (subject?.kind !== "JS_REFERENCE_IDENTIFIER") return undefined;
	const parameters = argumentParameters(owner);
	const index = parameters.findIndex(
		(parameter) =>
			functionParameterBindingName(parameter) === subject.valueToken,
	);
	const parameter = parameters[index];
	return parameter === undefined ? undefined : { parameter, index };
}

function memberNameText(
	name: AnyJsClassMemberName | AnyJsObjectMemberName | undefined,
): string {
	if (name?.kind === "JS_LITERAL_MEMBER_NAME") {
		const value = name.value ?? name.text;
		return stringLiteralValue(value) ?? value;
	}
	if (name?.kind === "JS_PRIVATE_CLASS_MEMBER_NAME") {
		return name.idToken ?? name.text;
	}
	if (name?.kind === "JS_COMPUTED_MEMBER_NAME") {
		return name.expression?.text ?? name.text;
	}
	return name?.text ?? "";
}

/** The node a function value is assigned from, looking through parentheses. */
function functionValueParent(node: AnyJsAstNode): AnyJsAstNode | undefined {
	let parent = node.parent;
	while (parent?.kind === "JS_PARENTHESIZED_EXPRESSION") parent = parent.parent;
	return parent;
}

function functionName(owner: FunctionLike | undefined): string {
	if (owner === undefined) return "anonymous function";
	switch (owner.kind) {
		case "JS_FUNCTION_DECLARATION":
		case "JS_FUNCTION_EXPORT_DEFAULT_DECLARATION":
		case "JS_FUNCTION_EXPRESSION":
		case "TS_DECLARE_FUNCTION_DECLARATION":
		case "TS_DECLARE_FUNCTION_EXPORT_DEFAULT_DECLARATION": {
			const id = owner.id;
			if (id?.kind === "JS_IDENTIFIER_BINDING" && id.nameToken !== undefined) {
				return id.nameToken;
			}
			break;
		}
		case "JS_METHOD_CLASS_MEMBER":
		case "JS_METHOD_OBJECT_MEMBER":
		case "JS_GETTER_CLASS_MEMBER":
		case "JS_GETTER_OBJECT_MEMBER":
		case "JS_SETTER_CLASS_MEMBER":
		case "JS_SETTER_OBJECT_MEMBER":
		case "JS_CONSTRUCTOR_CLASS_MEMBER":
			return memberNameText(owner.name);
		default:
			break;
	}
	const initializer = functionValueParent(owner);
	const declarator = initializer?.parent;
	if (
		initializer?.kind === "JS_INITIALIZER_CLAUSE" &&
		declarator?.kind === "JS_VARIABLE_DECLARATOR" &&
		declarator.id?.kind === "JS_IDENTIFIER_BINDING" &&
		declarator.id.nameToken !== undefined
	) {
		return declarator.id.nameToken;
	}
	return "anonymous function";
}

function isEmptyObjectExpression(expression: AnyJsExpression): boolean {
	const unwrapped = unwrapExpression(expression);
	return (
		unwrapped?.kind === "JS_OBJECT_EXPRESSION" && unwrapped.members.length === 0
	);
}

/** An empty `{}` is a valid starting value for a dictionary accumulator. */
function isDictionaryAccumulatorTarget(destination: WideningTarget): boolean {
	return (
		destination.kind === "open dictionary" ||
		destination.kind === "generic container"
	);
}

/** Whether an assertion is itself asserted again, as in `(value as A) as B`. */
function hasParentAssertion(node: AnyJsAstNode): boolean {
	let parent = node.parent;
	while (parent?.kind === "JS_PARENTHESIZED_EXPRESSION") parent = parent.parent;
	return (
		parent?.kind === "TS_AS_EXPRESSION" ||
		parent?.kind === "TS_TYPE_ASSERTION_EXPRESSION"
	);
}

/** The declarator of the variable an identifier assignment target writes. */
function assignedDeclaratorType(
	model: SemanticModel,
	target: AnyJsAstNode | undefined,
): { readonly name: string; readonly type: AnyTsType | undefined } | undefined {
	let current = target;
	while (current?.kind === "JS_PARENTHESIZED_ASSIGNMENT") {
		current = current.assignment;
	}
	if (current?.kind !== "JS_IDENTIFIER_ASSIGNMENT") return undefined;
	const binding = model.binding(current);
	const declarator = binding?.syntax().parent;
	if (
		declarator?.kind !== "JS_VARIABLE_DECLARATOR" ||
		declarator.id?.kind !== "JS_IDENTIFIER_BINDING"
	) {
		return undefined;
	}
	return {
		name: declarator.id.nameToken ?? declarator.id.text,
		type: variableAnnotationType(declarator.variableAnnotation),
	};
}

function message(target: string, subject: string): string {
	return `The explicit ${target} type on ${subject} discards known type evidence. Keep inference, validate with \`satisfies\`, or use a named owner contract.`;
}

function checkTypePredicateCall(
	node: JsCallExpression,
	model: SemanticModel,
	environment: TypeEnvironment,
): void {
	const owner = localFunctionForCall(model, node.callee);
	if (owner === undefined) return;
	const subject = typePredicateSubject(owner);
	if (subject === undefined) return;
	const argument = node.arguments?.args[subject.index];
	if (argument === undefined || argument.kind === "JS_SPREAD") return;
	const annotation = functionParameterTypeAnnotation(subject.parameter)?.ty;
	if (annotation === undefined || !containsUnknownType(annotation)) return;
	if (!hasKnownCallArgumentEvidence(model, argument, environment)) return;
	report(
		RULE_NAME,
		argument,
		message(
			"unknown",
			`argument for parameter \`${functionParameterBindingName(subject.parameter)}\` of \`${functionName(owner)}\``,
		),
	);
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWidening = defineRule({
	query: semantic(
		"JS_VARIABLE_DECLARATOR",
		"JS_PROPERTY_CLASS_MEMBER",
		"JS_ASSIGNMENT_EXPRESSION",
		"JS_CALL_EXPRESSION",
		"JS_RETURN_STATEMENT",
		"JS_ARROW_FUNCTION_EXPRESSION",
		"TS_AS_EXPRESSION",
		"TS_TYPE_ASSERTION_EXPRESSION",
	),
	run(node, context) {
		const model = context.model;
		const environment = createTypeEnvironment(model);

		const reportFlow = (
			expression: AnyJsExpression | undefined,
			type: AnyTsType | AnyTsReturnType | undefined,
			subject: string,
		): void => {
			if (
				expression === undefined ||
				type === undefined ||
				type.kind === "TS_PREDICATE_RETURN_TYPE" ||
				type.kind === "TS_ASSERTS_RETURN_TYPE"
			) {
				return;
			}
			const destination = classifyWideningTarget(type, environment);
			if (destination === undefined) return;
			if (
				isDictionaryAccumulatorTarget(destination) &&
				isEmptyObjectExpression(expression)
			) {
				return;
			}
			if (!hasKnownEvidence(model, expression)) return;
			report(RULE_NAME, expression, message(destination.kind, subject));
		};

		switch (node.kind) {
			case "JS_VARIABLE_DECLARATOR": {
				const id = node.id;
				if (id?.kind !== "JS_IDENTIFIER_BINDING") return;
				reportFlow(
					node.initializer?.expression,
					variableAnnotationType(node.variableAnnotation),
					`binding \`${id.nameToken ?? id.text}\``,
				);
				return;
			}
			case "JS_PROPERTY_CLASS_MEMBER":
				reportFlow(
					node.value?.expression,
					propertyAnnotationType(node.propertyAnnotation),
					`property \`${memberNameText(node.name)}\``,
				);
				return;
			case "JS_ASSIGNMENT_EXPRESSION": {
				if (node.operatorToken !== "=") return;
				const target = assignedDeclaratorType(model, node.left);
				if (target === undefined) return;
				reportFlow(node.right, target.type, `binding \`${target.name}\``);
				return;
			}
			case "JS_CALL_EXPRESSION":
				checkTypePredicateCall(node, model, environment);
				return;
			case "JS_RETURN_STATEMENT": {
				const owner = closestAncestor(node, BODY_FUNCTION_KINDS);
				reportFlow(
					node.argument,
					owner === undefined ? undefined : functionLikeReturnType(owner),
					`return value of \`${functionName(owner)}\``,
				);
				return;
			}
			case "JS_ARROW_FUNCTION_EXPRESSION": {
				const body = node.body;
				if (body === undefined || body.kind === "JS_FUNCTION_BODY") return;
				reportFlow(
					body,
					functionLikeReturnType(node),
					`return value of \`${functionName(node)}\``,
				);
				return;
			}
			case "TS_AS_EXPRESSION":
			case "TS_TYPE_ASSERTION_EXPRESSION":
				if (hasParentAssertion(node)) return;
				reportFlow(node.expression, node.ty, "assertion");
				return;
		}
	},
});
