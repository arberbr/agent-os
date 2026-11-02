import type {
	AnyJsExpression,
	AnyTsType,
	AnyTsTypeMember,
	SemanticModel,
	TsInterfaceDeclaration,
	TsObjectType,
	TsReferenceType,
	TsTypeAliasDeclaration,
} from "@biomejs/runtime/plugin";
import type {
	ResolvedTypeReference,
	TypeAliasEnvironment,
} from "./type-alias-resolution.ts";
import {
	createTypeAliasEnvironment,
	mergedInterfaceDeclarations,
	resolveTypeReference,
	typeAliasKey,
	typeAliasParameters,
	typeReferenceArguments,
	typeReferenceName,
} from "./type-alias-resolution.ts";

/** Built-in type names recognized when no local type binding shadows them. */
const BUILT_INS: ReadonlySet<string> = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);

/** Built-in wrappers whose first argument keeps the same value contract. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
	"Readonly",
	"Partial",
	"Required",
	"NonNullable",
]);

/**
 * Type-parameter substitutions while evaluating a generic alias body, keyed by
 * parameter name. Arguments are flattened against the substitutions in effect
 * where the alias was applied, as in the Oxlint original.
 */
type Substitutions = ReadonlyMap<string, AnyTsType>;

interface ResolvedType {
	readonly type: AnyTsType;
	readonly substitutions: Substitutions;
}

/** A dictionary value contract that gives callers no concrete value type. */
export interface UnsafeDictionary {
	readonly kind: "unsafe-dictionary";
	readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
}

/** The broad kind of a declared destination that known values can be widened into. */
export type WideningTargetKind =
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

/** A broad declared destination type, as classified by `classifyWideningTarget`. */
export interface WideningTarget {
	readonly kind: WideningTargetKind;
}

/**
 * Resolution context for the classifiers in this module. The Oxlint original
 * also pre-collected top-level interfaces by name; the semantic model now
 * resolves interfaces and aliases at each use, so the environment is the
 * model alone.
 */
export type TypeEnvironment = TypeAliasEnvironment;

/** Builds the environment for one `run()` from the rule's semantic model. */
export function createTypeEnvironment(model: SemanticModel): TypeEnvironment {
	return createTypeAliasEnvironment(model);
}

/**
 * Removes parentheses and the `readonly` type operator, which do not change a
 * value contract: `readonly (string[])` unwraps to `string[]`.
 */
export function unwrapTransparentType(type: AnyTsType): AnyTsType {
	let current = type;
	for (;;) {
		if (current.kind === "TS_PARENTHESIZED_TYPE" && current.ty !== undefined) {
			current = current.ty;
		} else if (
			current.kind === "TS_TYPE_OPERATOR_TYPE" &&
			current.operatorToken === "readonly" &&
			current.ty !== undefined
		) {
			current = current.ty;
		} else {
			return current;
		}
	}
}

function isBuiltIn(
	name: string,
	resolved: ResolvedTypeReference | undefined,
): boolean {
	return BUILT_INS.has(name) && resolved?.kind === "global";
}

function isUnappliedReferenceTo(type: AnyTsType, name: string): boolean {
	const unwrapped = unwrapTransparentType(type);
	return (
		unwrapped.kind === "TS_REFERENCE_TYPE" &&
		typeReferenceName(unwrapped) === name &&
		typeReferenceArguments(unwrapped).length === 0
	);
}

function isNeverType(type: AnyTsType | undefined): boolean {
	return (
		type !== undefined && unwrapTransparentType(type).kind === "TS_NEVER_TYPE"
	);
}

/** An optional `never` property such as `readonly __brand?: never` adds no value contract. */
function isEffectivelyEmptyMember(member: AnyTsTypeMember): boolean {
	return (
		member.kind === "TS_PROPERTY_SIGNATURE_TYPE_MEMBER" &&
		member.optionalToken !== undefined &&
		isNeverType(member.typeAnnotation?.ty)
	);
}

function isEffectivelyEmptyTypeLiteral(type: TsObjectType): boolean {
	return type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations: readonly TsInterfaceDeclaration[],
): boolean {
	if (declarations.length !== 1) return false;
	const [declaration] = declarations;
	return (
		declaration !== undefined &&
		(declaration.extendsClause?.types.length ?? 0) === 0 &&
		declaration.members.every(isEffectivelyEmptyMember)
	);
}

function resolvedSubstitutionArgument(
	type: AnyTsType,
	base: Substitutions,
	resolving: ReadonlySet<string> = new Set(),
): AnyTsType {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return type;
	const name = typeReferenceName(unwrapped);
	if (name === undefined || resolving.has(name)) return type;
	const substitution = base.get(name);
	if (substitution === undefined) return type;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitutionArgument(substitution, base, nextResolving);
}

function aliasSubstitution(
	alias: TsTypeAliasDeclaration,
	type: TsReferenceType,
	base: Substitutions,
): Substitutions | undefined {
	const arguments_ = typeReferenceArguments(type);
	const next = new Map(base);
	for (const [index, parameter] of typeAliasParameters(alias).entries()) {
		const name = parameter.name?.identToken;
		const argument = arguments_[index] ?? parameter.default?.ty;
		if (name === undefined || argument === undefined) return undefined;
		next.set(name, resolvedSubstitutionArgument(argument, next));
	}
	return next;
}

interface AliasExpansion {
	readonly body: AnyTsType;
	readonly substitutions: Substitutions;
	readonly resolving: ReadonlySet<string>;
}

/**
 * Enters a same-file alias at a reference: its body, its parameters bound to
 * the reference's arguments (or defaults), and the cycle guard extended with
 * the alias. Returns `undefined` for cycles and unbound parameters.
 */
function expandAlias(
	alias: TsTypeAliasDeclaration,
	reference: TsReferenceType,
	substitutions: Substitutions,
	resolving: ReadonlySet<string>,
): AliasExpansion | undefined {
	const key = typeAliasKey(alias);
	if (alias.ty === undefined || resolving.has(key)) return undefined;
	const next = aliasSubstitution(alias, reference, substitutions);
	if (next === undefined) return undefined;
	return {
		body: alias.ty,
		substitutions: next,
		resolving: new Set([...resolving, key]),
	};
}

/** The substitution for a type-parameter reference, unless it maps back to itself. */
function typeParameterSubstitution(
	type: TsReferenceType,
	name: string,
	resolved: ResolvedTypeReference,
	substitutions: Substitutions,
): AnyTsType | undefined {
	if (resolved.kind !== "typeParameter") return undefined;
	const substitution = substitutions.get(name);
	return substitution === undefined ||
		typeReferenceArguments(type).length > 0 ||
		isUnappliedReferenceTo(substitution, name)
		? undefined
		: substitution;
}

function unsafeDirectValue(
	type: AnyTsType,
	environment: TypeEnvironment,
	substitutions: Substitutions,
	resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | undefined {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.kind === "TS_UNKNOWN_TYPE") return "unknown";
	if (unwrapped.kind === "TS_ANY_TYPE") return "any";
	if (unwrapped.kind === "TS_NON_PRIMITIVE_TYPE") return "object";
	if (
		unwrapped.kind === "TS_OBJECT_TYPE" &&
		isEffectivelyEmptyTypeLiteral(unwrapped)
	) {
		return "empty-object";
	}
	if (unwrapped.kind === "TS_UNION_TYPE") {
		return unwrapped.types.some(
			(member) =>
				unsafeDirectValue(
					member,
					environment,
					substitutions,
					resolvingAliases,
				) !== undefined,
		)
			? "union"
			: undefined;
	}
	if (unwrapped.kind === "TS_INTERSECTION_TYPE") {
		const unsafeMembers = unwrapped.types.map((member) =>
			unsafeDirectValue(member, environment, substitutions, resolvingAliases),
		);
		if (unsafeMembers.includes("any")) return "any";
		return unsafeMembers.length > 0 &&
			unsafeMembers.every((member) => member !== undefined)
			? unsafeMembers[0]
			: undefined;
	}
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return undefined;
	const name = typeReferenceName(unwrapped);
	const resolved = resolveTypeReference(unwrapped, environment);
	if (name === undefined || resolved === undefined) return undefined;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, resolved)) {
		const wrapped = typeReferenceArguments(unwrapped)[0];
		return wrapped === undefined
			? undefined
			: unsafeDirectValue(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (resolved.kind === "typeParameter") {
		const substitution = typeParameterSubstitution(
			unwrapped,
			name,
			resolved,
			substitutions,
		);
		return substitution === undefined
			? undefined
			: unsafeDirectValue(
					substitution,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (resolved.kind === "interface") {
		return isEffectivelyEmptyInterface(
			mergedInterfaceDeclarations(resolved.declaration),
		)
			? "empty-object"
			: undefined;
	}
	if (resolved.kind !== "alias") return undefined;
	const expansion = expandAlias(
		resolved.declaration,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
	return expansion === undefined
		? undefined
		: unsafeDirectValue(
				expansion.body,
				environment,
				expansion.substitutions,
				expansion.resolving,
			);
}

function dictionaryValueTypes(
	type: AnyTsType,
	environment: TypeEnvironment,
	substitutions: Substitutions,
	resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
	const unwrapped = unwrapTransparentType(type);

	if (unwrapped.kind === "TS_OBJECT_TYPE") {
		return unwrapped.members.flatMap((member): readonly ResolvedType[] => {
			const value =
				member.kind === "TS_INDEX_SIGNATURE_TYPE_MEMBER"
					? member.typeAnnotation?.ty
					: undefined;
			return value === undefined ? [] : [{ type: value, substitutions }];
		});
	}

	if (unwrapped.kind === "TS_MAPPED_TYPE") {
		const value = unwrapped.mappedType?.ty;
		return value === undefined ? [] : [{ type: value, substitutions }];
	}

	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return [];
	const name = typeReferenceName(unwrapped);
	const resolved = resolveTypeReference(unwrapped, environment);
	if (name === undefined || resolved === undefined) return [];

	if (resolved.kind === "typeParameter") {
		const substitution = typeParameterSubstitution(
			unwrapped,
			name,
			resolved,
			substitutions,
		);
		return substitution === undefined
			? []
			: dictionaryValueTypes(
					substitution,
					environment,
					substitutions,
					resolvingAliases,
				);
	}

	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, resolved)) {
		const wrapped = typeReferenceArguments(unwrapped)[0];
		return wrapped === undefined
			? []
			: dictionaryValueTypes(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
				);
	}

	if (name === "Record" && isBuiltIn(name, resolved)) {
		const value = typeReferenceArguments(unwrapped)[1];
		return value === undefined ? [] : [{ type: value, substitutions }];
	}

	if ((name === "Pick" || name === "Omit") && isBuiltIn(name, resolved)) {
		const source = typeReferenceArguments(unwrapped)[0];
		return source === undefined
			? []
			: dictionaryValueTypes(
					source,
					environment,
					substitutions,
					resolvingAliases,
				);
	}

	if (resolved.kind !== "alias") return [];
	const expansion = expandAlias(
		resolved.declaration,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
	return expansion === undefined
		? []
		: dictionaryValueTypes(
				expansion.body,
				environment,
				expansion.substitutions,
				expansion.resolving,
			);
}

/**
 * Classifies a dictionary's value type itself, such as the `unknown` in
 * `[key: string]: unknown`. Returns the escape hatch it is or contains: a
 * direct `unknown`, `any`, `object`, or effectively empty object (`{}`, an
 * empty interface, or only optional `never` brands); a union with any such
 * member; or an intersection made only of them (or containing `any`). Same-file
 * aliases and transparent built-in wrappers such as `Readonly<T>` resolve.
 */
export function classifyUnsafeDictionaryValue(
	valueType: AnyTsType,
	environment: TypeEnvironment,
): UnsafeDictionary | undefined {
	const unsafeValue = unsafeDirectValue(
		valueType,
		environment,
		new Map(),
		new Set(),
	);
	return unsafeValue === undefined
		? undefined
		: { kind: "unsafe-dictionary", unsafeValue };
}

/**
 * Classifies a dictionary type: an object type with index signatures, a mapped
 * type, a built-in `Record`, or `Pick`/`Omit`/transparent wrappers and
 * same-file aliases around one. Returns the first unsafe value type found, as
 * `classifyUnsafeDictionaryValue` would classify it, or `undefined` when the
 * type is not a dictionary or its values are concrete.
 */
export function classifyUnsafeDictionary(
	type: AnyTsType,
	environment: TypeEnvironment,
): UnsafeDictionary | undefined {
	for (const valueType of dictionaryValueTypes(
		type,
		environment,
		new Map(),
		new Set(),
	)) {
		const unsafeValue = unsafeDirectValue(
			valueType.type,
			environment,
			valueType.substitutions,
			new Set(),
		);
		if (unsafeValue !== undefined) {
			return { kind: "unsafe-dictionary", unsafeValue };
		}
	}
	return undefined;
}

/**
 * Classifies a declared destination type that discards what is known about a
 * value: `unknown`, `object`, an object type with an index signature or a
 * mapped type (open dictionary), a non-empty anonymous object type, a
 * `Record` with a broad key (`string`, `number`, `symbol`, `PropertyKey`), or
 * a same-file alias to one of those. A generic alias that resolves to an open
 * dictionary is a `generic container`. Returns `undefined` for other types,
 * including finite-key records.
 */
export function classifyWideningTarget(
	type: AnyTsType,
	environment: TypeEnvironment,
): WideningTarget | undefined {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.kind === "TS_UNKNOWN_TYPE") return { kind: "unknown" };
	if (unwrapped.kind === "TS_NON_PRIMITIVE_TYPE") return { kind: "object" };
	if (unwrapped.kind === "TS_OBJECT_TYPE") {
		if (unwrapped.members.some(isIndexSignature)) {
			return { kind: "open dictionary" };
		}
		return unwrapped.members.length > 0
			? { kind: "anonymous object" }
			: undefined;
	}
	if (unwrapped.kind === "TS_MAPPED_TYPE") return { kind: "open dictionary" };
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return undefined;
	const name = typeReferenceName(unwrapped);
	const resolved = resolveTypeReference(unwrapped, environment);
	if (name === undefined || resolved === undefined) return undefined;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, resolved)) {
		const wrapped = typeReferenceArguments(unwrapped)[0];
		return wrapped === undefined
			? undefined
			: classifyWideningTarget(wrapped, environment);
	}
	if (name === "Record" && isBuiltIn(name, resolved)) {
		return hasBroadRecordKey(unwrapped, environment, new Map())
			? { kind: "open dictionary" }
			: undefined;
	}
	if (resolved.kind !== "alias") return undefined;
	const alias = resolved.declaration;
	const expansion = expandAlias(alias, unwrapped, new Map(), new Set());
	if (expansion === undefined) return undefined;
	const target = classifyAliasBroadTarget(
		expansion.body,
		environment,
		expansion.substitutions,
		expansion.resolving,
	);
	if (typeAliasParameters(alias).length > 0) {
		return target?.kind === "open dictionary"
			? { kind: "generic container" }
			: undefined;
	}
	return target;
}

function isIndexSignature(member: AnyTsTypeMember): boolean {
	return member.kind === "TS_INDEX_SIGNATURE_TYPE_MEMBER";
}

function hasBroadRecordKey(
	type: TsReferenceType,
	environment: TypeEnvironment,
	substitutions: Substitutions,
): boolean {
	const key = typeReferenceArguments(type)[0];
	return key === undefined || isBroadMappedKey(key, environment, substitutions);
}

function isBroadMappedKey(
	type: AnyTsType,
	environment: TypeEnvironment,
	substitutions: Substitutions,
	visitedAliases: ReadonlySet<string> = new Set(),
): boolean {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.kind === "TS_STRING_TYPE" ||
		unwrapped.kind === "TS_NUMBER_TYPE" ||
		unwrapped.kind === "TS_SYMBOL_TYPE"
	) {
		return true;
	}
	if (unwrapped.kind === "TS_UNION_TYPE") {
		return unwrapped.types.some((member) =>
			isBroadMappedKey(member, environment, substitutions, visitedAliases),
		);
	}
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return false;
	const name = typeReferenceName(unwrapped);
	const resolved = resolveTypeReference(unwrapped, environment);
	if (name === undefined || resolved === undefined) return false;
	const substitution = typeParameterSubstitution(
		unwrapped,
		name,
		resolved,
		substitutions,
	);
	if (substitution !== undefined) {
		return isBroadMappedKey(
			substitution,
			environment,
			substitutions,
			visitedAliases,
		);
	}
	if (name === "PropertyKey" && isBuiltIn(name, resolved)) return true;
	if (resolved.kind !== "alias") return false;
	const alias = resolved.declaration;
	const key = typeAliasKey(alias);
	if (
		alias.ty === undefined ||
		typeAliasParameters(alias).length > 0 ||
		visitedAliases.has(key)
	) {
		return false;
	}
	const nextVisited = new Set(visitedAliases);
	nextVisited.add(key);
	return isBroadMappedKey(alias.ty, environment, substitutions, nextVisited);
}

function classifyAliasBroadTarget(
	type: AnyTsType,
	environment: TypeEnvironment,
	substitutions: Substitutions,
	resolvingAliases: ReadonlySet<string>,
): WideningTarget | undefined {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.kind === "TS_UNKNOWN_TYPE") return { kind: "unknown" };
	if (unwrapped.kind === "TS_NON_PRIMITIVE_TYPE") return { kind: "object" };
	if (unwrapped.kind === "TS_OBJECT_TYPE") {
		return unwrapped.members.some(isIndexSignature)
			? { kind: "open dictionary" }
			: undefined;
	}
	if (unwrapped.kind === "TS_MAPPED_TYPE") {
		const keys = unwrapped.keysType;
		return keys !== undefined &&
			isBroadMappedKey(keys, environment, substitutions)
			? { kind: "open dictionary" }
			: undefined;
	}
	if (unwrapped.kind !== "TS_REFERENCE_TYPE") return undefined;
	const name = typeReferenceName(unwrapped);
	const resolved = resolveTypeReference(unwrapped, environment);
	if (name === undefined || resolved === undefined) return undefined;
	if (resolved.kind === "typeParameter") {
		const substitution = typeParameterSubstitution(
			unwrapped,
			name,
			resolved,
			substitutions,
		);
		return substitution === undefined
			? undefined
			: classifyAliasBroadTarget(
					substitution,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, resolved)) {
		const wrapped = typeReferenceArguments(unwrapped)[0];
		return wrapped === undefined
			? undefined
			: classifyAliasBroadTarget(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (name === "Record" && isBuiltIn(name, resolved)) {
		return hasBroadRecordKey(unwrapped, environment, substitutions)
			? { kind: "open dictionary" }
			: undefined;
	}
	if (resolved.kind !== "alias") return undefined;
	const expansion = expandAlias(
		resolved.declaration,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
	return expansion === undefined
		? undefined
		: classifyAliasBroadTarget(
				expansion.body,
				environment,
				expansion.substitutions,
				expansion.resolving,
			);
}

/**
 * Removes parentheses, `as`/`<T>` assertions, and non-null assertions (and
 * `satisfies` when `includeSatisfies` is set) around an expression.
 */
function unwrapExpressionWrappers(
	expression: AnyJsExpression,
	includeSatisfies: boolean,
): AnyJsExpression {
	let current = expression;
	for (;;) {
		if (
			(current.kind === "JS_PARENTHESIZED_EXPRESSION" ||
				current.kind === "TS_AS_EXPRESSION" ||
				current.kind === "TS_TYPE_ASSERTION_EXPRESSION" ||
				current.kind === "TS_NON_NULL_ASSERTION_EXPRESSION" ||
				(includeSatisfies && current.kind === "TS_SATISFIES_EXPRESSION")) &&
			current.expression !== undefined
		) {
			current = current.expression;
		} else {
			return current;
		}
	}
}

/**
 * Reports whether an expression is an object literal with at least one member,
 * looking through parentheses, `as`/`<T>` assertions, and non-null assertions.
 */
export function isPopulatedObjectExpression(
	expression: AnyJsExpression,
): boolean {
	const current = unwrapExpressionWrappers(expression, false);
	return current.kind === "JS_OBJECT_EXPRESSION" && current.members.length > 0;
}

/**
 * Reports whether an expression's own syntax is known evidence about its value:
 * an object, array, function, arrow, or class expression; a `new` expression;
 * a literal; an untagged template; or a unary expression. Parentheses,
 * assertions, non-null assertions, and `satisfies` are looked through.
 */
export function isKnownEvidenceExpression(
	expression: AnyJsExpression,
): boolean {
	const current = unwrapExpressionWrappers(expression, true);
	switch (current.kind) {
		case "JS_OBJECT_EXPRESSION":
		case "JS_ARRAY_EXPRESSION":
		case "JS_ARROW_FUNCTION_EXPRESSION":
		case "JS_CLASS_EXPRESSION":
		case "JS_FUNCTION_EXPRESSION":
		case "JS_NEW_EXPRESSION":
		case "JS_BIGINT_LITERAL_EXPRESSION":
		case "JS_BOOLEAN_LITERAL_EXPRESSION":
		case "JS_NULL_LITERAL_EXPRESSION":
		case "JS_NUMBER_LITERAL_EXPRESSION":
		case "JS_REGEX_LITERAL_EXPRESSION":
		case "JS_STRING_LITERAL_EXPRESSION":
		case "JS_UNARY_EXPRESSION":
			return true;
		case "JS_TEMPLATE_EXPRESSION":
			return current.tag === undefined;
		default:
			return false;
	}
}
