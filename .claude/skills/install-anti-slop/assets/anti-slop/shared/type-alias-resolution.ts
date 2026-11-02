import type {
	AnyJsAstNode,
	AnyTsType,
	JsReferenceIdentifier,
	SemanticModel,
	TsInterfaceDeclaration,
	TsReferenceType,
	TsTypeAliasDeclaration,
	TsTypeParameter,
} from "@biomejs/runtime/plugin";
import type { TypeParameterBinder } from "./lexical-type-parameters.ts";
import { isTypeParameterBinder } from "./lexical-type-parameters.ts";

/**
 * Everything needed to resolve same-file type references. The Oxlint original
 * pre-collected every alias and competing type binding in the program; Biome's
 * semantic model already resolves type references with block scoping, forward
 * references, and type-parameter shadowing, so the environment only carries
 * the model. Build one per `run()` with `createTypeAliasEnvironment(context.model)`.
 */
export interface TypeAliasEnvironment {
	readonly model: SemanticModel;
}

/** Wraps a rule's semantic model for the resolution helpers in this module. */
export function createTypeAliasEnvironment(
	model: SemanticModel,
): TypeAliasEnvironment {
	return { model };
}

/**
 * What a type reference's name resolves to:
 * - `global`: no local binding, such as the built-in `Record` or `Promise`.
 * - `typeParameter`: a generic parameter, mapped-type key, or `infer` binder.
 * - `alias`: a type alias declared in this file.
 * - `interface`: an interface declared in this file. Declaration merging is not
 *   applied; see `mergedInterfaceDeclarations`.
 * - `other`: an import, class, enum, or other local type binding.
 */
export type ResolvedTypeReference =
	| { readonly kind: "global" }
	| {
			readonly kind: "typeParameter";
			readonly declaration: TypeParameterBinder;
	  }
	| { readonly kind: "alias"; readonly declaration: TsTypeAliasDeclaration }
	| {
			readonly kind: "interface";
			readonly declaration: TsInterfaceDeclaration;
	  }
	| { readonly kind: "other"; readonly declaration: AnyJsAstNode | undefined };

/**
 * Receives a type after alias resolution. Call `matches(child)` to resolve and
 * match a nested type, such as a union member or a `Promise` argument.
 */
export type ResolvedTypeMatcher = (
	type: AnyTsType,
	matches: (child: AnyTsType) => boolean,
) => boolean;

/** The identifier of an unqualified type reference such as `Name<T>`; `undefined` for `NS.Name`. */
export function typeReferenceIdentifier(
	type: TsReferenceType,
): JsReferenceIdentifier | undefined {
	const name = type.name;
	return name?.kind === "JS_REFERENCE_IDENTIFIER" ? name : undefined;
}

/** The name of an unqualified type reference; `undefined` for qualified names such as `NS.Name`. */
export function typeReferenceName(type: TsReferenceType): string | undefined {
	return typeReferenceIdentifier(type)?.valueToken;
}

/** The explicit type arguments of a reference, such as `[string, T]` for `Record<string, T>`. */
export function typeReferenceArguments(
	type: TsReferenceType,
): readonly AnyTsType[] {
	return type.typeArguments?.tsTypeArgumentList ?? [];
}

/** The declared generic parameters of a type alias, in order. */
export function typeAliasParameters(
	alias: TsTypeAliasDeclaration,
): readonly TsTypeParameter[] {
	return alias.typeParameters?.items ?? [];
}

/** The declared name of a type alias. */
export function typeAliasName(
	alias: TsTypeAliasDeclaration,
): string | undefined {
	const binding = alias.bindingIdentifier;
	return binding?.kind === "TS_IDENTIFIER_BINDING"
		? binding.nameToken
		: undefined;
}

/**
 * A key that stands in for alias identity, which plugin node handles lack.
 * Two aliases share a key only when they have the same name and the same
 * source text, which is enough to break resolution cycles.
 */
export function typeAliasKey(alias: TsTypeAliasDeclaration): string {
	return `${typeAliasName(alias) ?? ""}\u0000${alias.text}`;
}

/**
 * Resolves the name of an unqualified type reference through the semantic
 * model. Returns `undefined` for qualified names such as `NS.Name`.
 */
export function resolveTypeReference(
	type: TsReferenceType,
	environment: TypeAliasEnvironment,
): ResolvedTypeReference | undefined {
	const reference = typeReferenceIdentifier(type);
	if (reference === undefined) return undefined;
	const binding = environment.model.binding(reference);
	if (binding === undefined) return { kind: "global" };
	const declaration = binding.syntax().parent;
	if (isTypeParameterBinder(declaration)) {
		return { kind: "typeParameter", declaration };
	}
	if (declaration?.kind === "TS_TYPE_ALIAS_DECLARATION") {
		return { kind: "alias", declaration };
	}
	if (declaration?.kind === "TS_INTERFACE_DECLARATION") {
		return { kind: "interface", declaration };
	}
	return { kind: "other", declaration };
}

/**
 * The visible same-file type alias that an unqualified reference names, with
 * lexical shadowing by nested aliases, type parameters, mapped-type keys, and
 * `infer` binders respected. Forward references resolve.
 */
export function visibleTypeAlias(
	type: TsReferenceType,
	environment: TypeAliasEnvironment,
): TsTypeAliasDeclaration | undefined {
	const resolved = resolveTypeReference(type, environment);
	return resolved?.kind === "alias" ? resolved.declaration : undefined;
}

/**
 * Reports whether a reference's name resolves to any local type binding, so a
 * built-in such as `Record` or `Partial` is shadowed at this use. Value-only
 * bindings such as `const Record = 1` do not shadow type names.
 */
export function hasVisibleTypeBinding(
	type: TsReferenceType,
	environment: TypeAliasEnvironment,
): boolean {
	const resolved = resolveTypeReference(type, environment);
	return resolved !== undefined && resolved.kind !== "global";
}

/**
 * Every declaration of a merged interface: the interfaces with the same name
 * in the same statement list as `declaration`, including exported and
 * `declare`d ones.
 */
export function mergedInterfaceDeclarations(
	declaration: TsInterfaceDeclaration,
): readonly TsInterfaceDeclaration[] {
	const name = interfaceName(declaration);
	let container = declaration.parent;
	while (
		container !== undefined &&
		(container.kind === "JS_EXPORT" ||
			container.kind === "TS_DECLARE_STATEMENT" ||
			container.kind === "TS_EXPORT_DECLARE_CLAUSE" ||
			container.kind === "JS_EXPORT_DEFAULT_DECLARATION_CLAUSE")
	) {
		container = container.parent;
	}
	if (container === undefined || name === undefined) return [declaration];
	return container.children().flatMap((statement) => {
		const candidate = unwrapDeclarationStatement(statement);
		return candidate?.kind === "TS_INTERFACE_DECLARATION" &&
			interfaceName(candidate) === name
			? [candidate]
			: [];
	});
}

function interfaceName(
	declaration: TsInterfaceDeclaration,
): string | undefined {
	const id = declaration.id;
	return id?.kind === "TS_IDENTIFIER_BINDING" ? id.nameToken : undefined;
}

/** Looks through `export`, `declare`, and `export default` wrappers around a statement. */
export function unwrapDeclarationStatement(
	statement: AnyJsAstNode | undefined,
): AnyJsAstNode | undefined {
	let current = statement;
	for (;;) {
		if (current?.kind === "JS_EXPORT") current = current.exportClause;
		else if (
			current?.kind === "TS_DECLARE_STATEMENT" ||
			current?.kind === "TS_EXPORT_DECLARE_CLAUSE" ||
			current?.kind === "JS_EXPORT_DEFAULT_DECLARATION_CLAUSE"
		) {
			current = current.declaration;
		} else return current;
	}
}

interface Substitution {
	readonly substitutions: Substitutions;
	readonly type: AnyTsType;
}

type Substitutions = ReadonlyMap<string, Substitution>;

function aliasSubstitutions(
	alias: TsTypeAliasDeclaration,
	reference: TsReferenceType,
	base: Substitutions,
): Substitutions | undefined {
	const arguments_ = typeReferenceArguments(reference);
	const next = new Map(base);
	for (const [index, parameter] of typeAliasParameters(alias).entries()) {
		const name = parameter.name?.identToken;
		const explicitArgument = arguments_[index];
		const argument = explicitArgument ?? parameter.default?.ty;
		if (name === undefined || argument === undefined) return undefined;
		const argumentSubstitutions = explicitArgument === undefined ? next : base;
		next.set(name, {
			type: argument,
			substitutions: new Map(argumentSubstitutions),
		});
	}
	return next;
}

/**
 * Matches a type after resolving visible same-file aliases and substituting
 * their type parameters, so `type Identity<T> = T` makes `Identity<unknown>`
 * match like `unknown`. Each type argument is evaluated in the scope where it
 * was written. Alias cycles stop resolving and hand the reference itself to
 * the matcher.
 */
export function resolvedTypeMatches(
	type: AnyTsType,
	environment: TypeAliasEnvironment,
	matcher: ResolvedTypeMatcher,
): boolean {
	const evaluate = (
		current: AnyTsType,
		substitutions: Substitutions,
		resolvingAliases: ReadonlySet<string>,
	): boolean => {
		if (current.kind === "TS_REFERENCE_TYPE") {
			const name = typeReferenceName(current);
			const resolved = resolveTypeReference(current, environment);
			if (name !== undefined && resolved !== undefined) {
				const substitution = substitutions.get(name);
				if (
					resolved.kind === "typeParameter" &&
					substitution !== undefined &&
					typeReferenceArguments(current).length === 0
				) {
					return evaluate(
						substitution.type,
						substitution.substitutions,
						resolvingAliases,
					);
				}
				if (resolved.kind === "alias") {
					const alias = resolved.declaration;
					const key = typeAliasKey(alias);
					const body = alias.ty;
					const nextSubstitutions = resolvingAliases.has(key)
						? undefined
						: aliasSubstitutions(alias, current, substitutions);
					if (body !== undefined && nextSubstitutions !== undefined) {
						const nextResolving = new Set(resolvingAliases);
						nextResolving.add(key);
						return evaluate(body, nextSubstitutions, nextResolving);
					}
				}
			}
		}
		return matcher(current, (child) =>
			evaluate(child, substitutions, resolvingAliases),
		);
	};

	return evaluate(type, new Map(), new Set());
}

/**
 * Like `resolvedTypeMatches`, but looks through parentheses and union members
 * first, so `isTarget` sees each resolved union member on its own: a type
 * matches when any member does. `string | Alias` with `type Alias = unknown`
 * matches an `unknown` target.
 */
export function resolvedTypeIncludes(
	type: AnyTsType,
	environment: TypeAliasEnvironment,
	isTarget: ResolvedTypeMatcher,
): boolean {
	return resolvedTypeMatches(type, environment, (resolved, matches) => {
		if (resolved.kind === "TS_PARENTHESIZED_TYPE") {
			return resolved.ty !== undefined && matches(resolved.ty);
		}
		if (resolved.kind === "TS_UNION_TYPE") return resolved.types.some(matches);
		return isTarget(resolved, matches);
	});
}
