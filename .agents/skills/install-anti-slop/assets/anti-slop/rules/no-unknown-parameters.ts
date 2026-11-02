import { defineRule, semantic } from "@biomejs/runtime/plugin";
import type { FunctionLike } from "../shared/function-parameters.ts";
import {
	containsUnknownType,
	FUNCTION_LIKE_KINDS,
	functionLikeParameters,
	functionLikeReturnType,
	functionParameterBindingName,
	functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { report } from "../shared/report.ts";

/** Reports whether the function's return contract is `name is T`, `asserts name is T`, or `asserts name`. */
function isTypePredicateSubject(owner: FunctionLike, name: string): boolean {
	const predicate = functionLikeReturnType(owner);
	if (
		predicate?.kind !== "TS_PREDICATE_RETURN_TYPE" &&
		predicate?.kind !== "TS_ASSERTS_RETURN_TYPE"
	) {
		return false;
	}
	const subject = predicate.parameterName;
	return (
		subject?.kind === "JS_REFERENCE_IDENTIFIER" && subject.valueToken === name
	);
}

/** Disallow unknown inputs except explicitly named error-cause enrichment and type-predicate subjects. */
export const noUnknownParameters = defineRule({
	query: semantic(...FUNCTION_LIKE_KINDS),
	run(node) {
		for (const parameter of functionLikeParameters(node)) {
			const type = functionParameterTypeAnnotation(parameter)?.ty;
			if (type === undefined || !containsUnknownType(type)) continue;
			const name = functionParameterBindingName(parameter);
			if (name === "cause" || isTypePredicateSubject(node, name)) continue;
			report(
				"noUnknownParameters",
				type,
				`Parameter \`${name}\` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.`,
			);
		}
	},
});
