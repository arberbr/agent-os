import type {
	AnyJsAstNode,
	Binding,
	JsCallExpression,
	JsIdentifierBinding,
	SemanticModel,
} from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";

import {
	arrayMethodTarget,
	constAliasDeclarator,
	isArrayExpressionWrapper,
	isKnownArrayExpression,
	resolveArrayBinding,
	sameBinding,
	unwrapArrayExpression,
} from "../shared/array-method.ts";
import { report } from "../shared/report.ts";
import { sameNode } from "../shared/same-node.ts";
import { callArguments, isUnshadowedGlobal } from "../shared/syntax.ts";

/** Function-like nodes other than callbacks that `reduce` can receive. */
const OTHER_FUNCTION_KINDS = new Set<string>([
	"JS_FUNCTION_DECLARATION",
	"JS_FUNCTION_EXPORT_DEFAULT_DECLARATION",
	"JS_METHOD_CLASS_MEMBER",
	"JS_METHOD_OBJECT_MEMBER",
	"JS_CONSTRUCTOR_CLASS_MEMBER",
	"JS_GETTER_CLASS_MEMBER",
	"JS_GETTER_OBJECT_MEMBER",
	"JS_SETTER_CLASS_MEMBER",
	"JS_SETTER_OBJECT_MEMBER",
]);

const ARRAY_COPY_METHODS = new Set([
	"concat",
	"slice",
	"toSpliced",
	"toSorted",
	"toReversed",
	"with",
]);

interface Reducer {
	readonly accumulator: JsIdentifierBinding;
	readonly initialValue: AnyJsAstNode | undefined;
}

/** The reducer callback whose own body (not a nested function) contains `node`. */
function enclosingReducer(node: AnyJsAstNode): Reducer | undefined {
	for (const ancestor of node.ancestors()) {
		if (OTHER_FUNCTION_KINDS.has(ancestor.kind)) return undefined;
		if (
			ancestor.kind !== "JS_ARROW_FUNCTION_EXPRESSION" &&
			ancestor.kind !== "JS_FUNCTION_EXPRESSION"
		) {
			continue;
		}
		let argument: AnyJsAstNode = ancestor;
		while (argument.parent && isArrayExpressionWrapper(argument.parent))
			argument = argument.parent;
		const owner = argument.parent?.parent?.parent;
		if (
			argument.parent?.kind !== "JS_CALL_ARGUMENT_LIST" ||
			owner?.kind !== "JS_CALL_EXPRESSION"
		) {
			return undefined;
		}
		const method = arrayMethodTarget(owner.callee);
		const args = callArguments(owner);
		if (
			(method?.name !== "reduce" && method?.name !== "reduceRight") ||
			args.length > 2 ||
			!sameNode(args[0], argument)
		) {
			return undefined;
		}
		const parameters = ancestor.parameters;
		const first =
			parameters?.kind === "JS_PARAMETERS" ? parameters.items[0] : parameters;
		const accumulator =
			first?.kind === "JS_FORMAL_PARAMETER" ? first.binding : first;
		if (accumulator?.kind !== "JS_IDENTIFIER_BINDING") return undefined;
		return { accumulator, initialValue: args[1] };
	}
	return undefined;
}

/** Whether an expression is the accumulator itself or a never-reassigned `const` alias of it. */
function referencesAccumulator(
	model: SemanticModel,
	expression: AnyJsAstNode | undefined,
	accumulator: Binding,
	visited: Binding[] = [],
): boolean {
	const binding = resolveArrayBinding(model, expression);
	if (
		binding === undefined ||
		visited.some((seen) => sameBinding(seen, binding))
	)
		return false;
	if (sameBinding(binding, accumulator)) return true;
	visited.push(binding);
	const declarator = constAliasDeclarator(binding);
	return (
		declarator !== undefined &&
		referencesAccumulator(
			model,
			declarator.initializer?.expression,
			accumulator,
			visited,
		)
	);
}

function copiesAccumulator(
	model: SemanticModel,
	node: JsCallExpression,
	reducer: Reducer,
	accumulator: Binding,
): boolean {
	const method = arrayMethodTarget(node.callee);
	if (method === undefined) return false;
	const args = callArguments(node);
	const isAccumulator = (expression: AnyJsAstNode | undefined) =>
		referencesAccumulator(model, expression, accumulator);
	const owner = unwrapArrayExpression(method.object);
	if (method.name === "assign" && isUnshadowedGlobal(model, owner, "Object")) {
		return (
			unwrapArrayExpression(args[0])?.kind === "JS_OBJECT_EXPRESSION" &&
			args.slice(1).some(isAccumulator)
		);
	}
	if (method.name === "from" && isUnshadowedGlobal(model, owner, "Array")) {
		return isAccumulator(args[0]);
	}
	if (ARRAY_COPY_METHODS.has(method.name)) {
		return (
			reducer.initialValue !== undefined &&
			isKnownArrayExpression(model, reducer.initialValue) &&
			isAccumulator(method.object)
		);
	}
	return false;
}

/** Reject non-spread copies of reducer accumulators; spread copies belong to Biome's noAccumulatingSpread. */
export const noReduceAccumulatorCopy = defineRule({
	query: semantic("JS_CALL_EXPRESSION"),
	run(node, context) {
		if (arrayMethodTarget(node.callee) === undefined) return;
		const reducer = enclosingReducer(node);
		if (reducer === undefined) return;
		const accumulator = context.model.asBinding(reducer.accumulator);
		if (accumulator === undefined) return;
		if (copiesAccumulator(context.model, node, reducer, accumulator)) {
			report(
				"noReduceAccumulatorCopy",
				node,
				"Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh, locally owned accumulator and return it, or use an iterator pipeline/flatMap.",
			);
		}
	},
});
