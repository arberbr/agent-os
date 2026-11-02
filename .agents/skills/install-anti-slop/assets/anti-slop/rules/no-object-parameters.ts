import type { AnyTsType } from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";
import {
	FUNCTION_LIKE_KINDS,
	functionLikeParameters,
	functionParameterBindingName,
	functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { report } from "../shared/report.ts";
import type { TypeAliasEnvironment } from "../shared/type-alias-resolution.ts";
import {
	createTypeAliasEnvironment,
	resolvedTypeIncludes,
} from "../shared/type-alias-resolution.ts";

function resolvesToObject(
	type: AnyTsType,
	environment: TypeAliasEnvironment,
): boolean {
	return resolvedTypeIncludes(
		type,
		environment,
		(resolved) => resolved.kind === "TS_NON_PRIMITIVE_TYPE",
	);
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParameters = defineRule({
	query: semantic(...FUNCTION_LIKE_KINDS),
	run(node, context) {
		const environment = createTypeAliasEnvironment(context.model);
		for (const parameter of functionLikeParameters(node)) {
			const type = functionParameterTypeAnnotation(parameter)?.ty;
			if (type === undefined || !resolvesToObject(type, environment)) continue;
			report(
				"noObjectParameters",
				type,
				`Parameter \`${functionParameterBindingName(parameter)}\` uses the broad \`object\` type. Accept a named owner type; parse external input at its boundary before calling this function.`,
			);
		}
	},
});
