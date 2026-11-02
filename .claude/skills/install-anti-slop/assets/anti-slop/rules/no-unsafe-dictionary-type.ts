import type { AnyJsAstNode, AnyTsType } from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";
import type { TypeEnvironment } from "../shared/dictionary-types.ts";
import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	createTypeEnvironment,
} from "../shared/dictionary-types.ts";
import { report } from "../shared/report.ts";
import {
	typeReferenceArguments,
	visibleTypeAlias,
} from "../shared/type-alias-resolution.ts";

/** Every `AnyTsType` kind; used to find enclosing type nodes among a node's ancestors. */
const typeNodeKinds: ReadonlySet<string> = new Set([
	"TS_ANY_TYPE",
	"TS_ARRAY_TYPE",
	"TS_BIGINT_LITERAL_TYPE",
	"TS_BIGINT_TYPE",
	"TS_BOGUS_TYPE",
	"TS_BOOLEAN_LITERAL_TYPE",
	"TS_BOOLEAN_TYPE",
	"TS_CONDITIONAL_TYPE",
	"TS_CONSTRUCTOR_TYPE",
	"TS_FUNCTION_TYPE",
	"TS_IMPORT_TYPE",
	"TS_INDEXED_ACCESS_TYPE",
	"TS_INFER_TYPE",
	"TS_INTERSECTION_TYPE",
	"TS_MAPPED_TYPE",
	"TS_NEVER_TYPE",
	"TS_NON_PRIMITIVE_TYPE",
	"TS_NULL_LITERAL_TYPE",
	"TS_NUMBER_LITERAL_TYPE",
	"TS_NUMBER_TYPE",
	"TS_OBJECT_TYPE",
	"TS_PARENTHESIZED_TYPE",
	"TS_REFERENCE_TYPE",
	"TS_STRING_LITERAL_TYPE",
	"TS_STRING_TYPE",
	"TS_SYMBOL_TYPE",
	"TS_TEMPLATE_LITERAL_TYPE",
	"TS_THIS_TYPE",
	"TS_TUPLE_TYPE",
	"TS_TYPE_OPERATOR_TYPE",
	"TS_TYPEOF_TYPE",
	"TS_UNDEFINED_TYPE",
	"TS_UNION_TYPE",
	"TS_UNKNOWN_TYPE",
	"TS_VOID_TYPE",
]);

function isTypeNode(node: AnyJsAstNode): node is AnyTsType {
	return typeNodeKinds.has(node.kind);
}

function isInsideTypeAliasDeclaration(node: AnyJsAstNode): boolean {
	return node
		.ancestors()
		.some((ancestor) => ancestor.kind === "TS_TYPE_ALIAS_DECLARATION");
}

/**
 * A plain use such as `const x: Unsafe` of an alias that is reported at its
 * own declaration. Uses inside other aliases are still reported, because they
 * declare a new contract.
 */
function isPlainAliasConsumerUse(
	node: AnyTsType,
	environment: TypeEnvironment,
): boolean {
	return (
		node.kind === "TS_REFERENCE_TYPE" &&
		typeReferenceArguments(node).length === 0 &&
		visibleTypeAlias(node, environment) !== undefined &&
		!isInsideTypeAliasDeclaration(node)
	);
}

/**
 * Generic constraints such as `T extends Record<string, unknown>` (including
 * `infer U extends ...`) describe what callers may pass, not a value contract.
 */
function isInsideTypeParameterConstraint(node: AnyTsType): boolean {
	return node
		.ancestors()
		.some((ancestor) => ancestor.kind === "TS_TYPE_CONSTRAINT_CLAUSE");
}

/** Reports the outermost unsafe dictionary type only. */
function hasUnsafeDictionaryAncestor(
	node: AnyTsType,
	environment: TypeEnvironment,
): boolean {
	return node
		.ancestors()
		.some(
			(ancestor) =>
				isTypeNode(ancestor) &&
				classifyUnsafeDictionary(ancestor, environment) !== undefined,
		);
}

function message(value: string): string {
	return `This dictionary's ${value} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.`;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryType = defineRule({
	query: semantic(
		"TS_REFERENCE_TYPE",
		"TS_OBJECT_TYPE",
		"TS_MAPPED_TYPE",
		"TS_INDEX_SIGNATURE_TYPE_MEMBER",
		"TS_INDEX_SIGNATURE_CLASS_MEMBER",
	),
	run(node, context) {
		const environment = createTypeEnvironment(context.model);
		if (
			node.kind === "TS_INDEX_SIGNATURE_TYPE_MEMBER" ||
			node.kind === "TS_INDEX_SIGNATURE_CLASS_MEMBER"
		) {
			// Index signatures in type literals are reported with the literal.
			if (node.parent?.parent?.kind === "TS_OBJECT_TYPE") return;
			const value = node.typeAnnotation?.ty;
			if (value === undefined) return;
			const unsafe = classifyUnsafeDictionaryValue(value, environment);
			if (unsafe !== undefined) {
				report("noUnsafeDictionaryType", node, message(unsafe.unsafeValue));
			}
			return;
		}
		if (isInsideTypeParameterConstraint(node)) return;
		if (isPlainAliasConsumerUse(node, environment)) return;
		const unsafe = classifyUnsafeDictionary(node, environment);
		if (unsafe === undefined) return;
		if (hasUnsafeDictionaryAncestor(node, environment)) return;
		report("noUnsafeDictionaryType", node, message(unsafe.unsafeValue));
	},
});
