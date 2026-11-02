import type {
	AnyJsAstNode,
	JsReferenceIdentifier,
	SemanticModel,
	TsInferType,
	TsMappedType,
	TsTypeParameter,
	TsTypeParameters,
} from "@biomejs/runtime/plugin";

/**
 * A declaration that binds a type-parameter name: an entry in a generic
 * parameter list (`<T>` on a function, method, class, interface, or alias), a
 * mapped-type key (`[K in Keys]`), or an `infer` binder in a conditional type.
 */
export type TypeParameterBinder = TsTypeParameter | TsMappedType | TsInferType;

/** Reports whether a node is one of the declarations that bind a type-parameter name. */
export function isTypeParameterBinder(
	node: AnyJsAstNode | undefined,
): node is TypeParameterBinder {
	return (
		node?.kind === "TS_TYPE_PARAMETER" ||
		node?.kind === "TS_MAPPED_TYPE" ||
		node?.kind === "TS_INFER_TYPE"
	);
}

/**
 * The type-parameter binder that a type-reference identifier resolves to, or
 * `undefined` when it names something else (an alias, interface, import, or
 * global).
 *
 * The Oxlint original collected the names of every binder in scope at a node
 * by walking its ancestors (`lexicalTypeParameterNames`). Biome's semantic
 * model already resolves type references with TypeScript's scoping, including
 * mapped-type keys, which are visible only in the `as` clause and value, and
 * `infer` binders, which are visible only in the conditional's true branch, so
 * this asks the model instead of rebuilding that scope walk.
 */
export function referencedTypeParameter(
	model: SemanticModel,
	reference: JsReferenceIdentifier,
): TypeParameterBinder | undefined {
	const declaration = model.binding(reference)?.syntax().parent;
	return isTypeParameterBinder(declaration) ? declaration : undefined;
}

/** Reports whether a type-reference identifier names a type parameter in scope at its use. */
export function isTypeParameterReference(
	model: SemanticModel,
	reference: JsReferenceIdentifier,
): boolean {
	return referencedTypeParameter(model, reference) !== undefined;
}

/** The names declared by a generic parameter list, in order. */
export function typeParameterNames(
	parameters: TsTypeParameters | undefined,
): readonly string[] {
	return (parameters?.items ?? []).flatMap((parameter) => {
		const name = parameter.name?.identToken;
		return name === undefined ? [] : [name];
	});
}
