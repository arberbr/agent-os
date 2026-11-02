import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../../shared/report.ts";
import {
	isMatchPatternObject,
	isStringLiteral,
	propertyName,
} from "../shared/tagged-values.ts";

/** Construct tagged values with their existing Effect constructor instead of writing `_tag` manually. */
export const noManualTaggedConstruction = defineRule({
	query: ast("JS_OBJECT_EXPRESSION"),
	run(node) {
		if (isMatchPatternObject(node)) return;
		const tag = node.members.find(
			(member) =>
				member.kind === "JS_PROPERTY_OBJECT_MEMBER" &&
				propertyName(member) === "_tag" &&
				isStringLiteral(member.value),
		);
		if (tag === undefined) return;
		report(
			"noManualTaggedConstruction",
			tag,
			"Use the existing Schema tagged `.make`, tagged class/error constructor, or Data.taggedEnum variant constructor instead of writing a literal `_tag` object.",
		);
	},
});
