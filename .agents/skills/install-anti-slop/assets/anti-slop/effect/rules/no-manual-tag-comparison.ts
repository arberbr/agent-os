import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../../shared/report.ts";
import {
	isInsideBroadEffectHandler,
	tagMember,
	tagMemberFromComparison,
} from "../shared/tagged-values.ts";

const COMPARISON_MESSAGE =
	"Use Match.tag/Match.tags for tagged-value branching, or Predicate.isTagged for a simple reusable predicate.";
const SWITCH_MESSAGE =
	"Use Match.value(value).pipe(Match.tag/Match.tags/Match.tagsExhaustive) or the tagged enum `$match` helper instead of switching on `_tag`.";

/** Use Effect Match or Predicate helpers instead of manually branching on `_tag`. */
export const noManualTagComparison = defineRule({
	query: ast("JS_BINARY_EXPRESSION", "JS_SWITCH_STATEMENT"),
	run(node) {
		const isComparison = node.kind === "JS_BINARY_EXPRESSION";
		const member = isComparison
			? tagMemberFromComparison(node)
			: tagMember(node.discriminant);
		if (member === undefined || isInsideBroadEffectHandler(node)) return;
		report(
			"noManualTagComparison",
			node,
			isComparison ? COMPARISON_MESSAGE : SWITCH_MESSAGE,
		);
	},
});
