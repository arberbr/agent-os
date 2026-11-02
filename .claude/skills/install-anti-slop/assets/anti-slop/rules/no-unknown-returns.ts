import type { AnyTsType } from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";
import {
	FUNCTION_LIKE_KINDS,
	functionLikeReturnType,
} from "../shared/function-parameters.ts";
import { report } from "../shared/report.ts";
import type { TypeAliasEnvironment } from "../shared/type-alias-resolution.ts";
import {
	createTypeAliasEnvironment,
	resolvedTypeIncludes,
	typeReferenceArguments,
	typeReferenceName,
} from "../shared/type-alias-resolution.ts";

function resolvesToUnknown(
	type: AnyTsType,
	environment: TypeAliasEnvironment,
): boolean {
	return resolvedTypeIncludes(type, environment, (resolved, matches) => {
		if (resolved.kind === "TS_UNKNOWN_TYPE") return true;
		if (resolved.kind !== "TS_REFERENCE_TYPE") return false;
		const name = typeReferenceName(resolved);
		if (name !== "Promise" && name !== "PromiseLike") return false;
		const value = typeReferenceArguments(resolved)[0];
		return value !== undefined && matches(value);
	});
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturns = defineRule({
	query: semantic(...FUNCTION_LIKE_KINDS),
	run(node, context) {
		const returnType = functionLikeReturnType(node);
		if (
			returnType === undefined ||
			returnType.kind === "TS_PREDICATE_RETURN_TYPE" ||
			returnType.kind === "TS_ASSERTS_RETURN_TYPE"
		) {
			return;
		}
		if (
			!resolvesToUnknown(returnType, createTypeAliasEnvironment(context.model))
		) {
			return;
		}
		report(
			"noUnknownReturns",
			returnType,
			"This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
		);
	},
});
