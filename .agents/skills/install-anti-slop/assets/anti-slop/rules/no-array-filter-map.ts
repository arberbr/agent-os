import { defineRule, semantic } from "@biomejs/runtime/plugin";

import {
	arrayMethodTarget,
	isKnownArrayExpression,
	unwrapArrayExpression,
} from "../shared/array-method.ts";
import { report } from "../shared/report.ts";

/** Reject eager array filter/map pipelines; lazy iterator helpers remain allowed. */
export const noArrayFilterMap = defineRule({
	query: semantic("JS_CALL_EXPRESSION"),
	run(node, context) {
		const outer = arrayMethodTarget(node.callee);
		if (
			outer === undefined ||
			(outer.name !== "map" && outer.name !== "filter")
		)
			return;
		const innerCall = unwrapArrayExpression(outer.object);
		if (innerCall?.kind !== "JS_CALL_EXPRESSION") return;
		const inner = arrayMethodTarget(innerCall.callee);
		if (
			inner === undefined ||
			inner.name !== (outer.name === "map" ? "filter" : "map")
		)
			return;
		if (!isKnownArrayExpression(context.model, inner.object)) return;
		report(
			"noArrayFilterMap",
			node,
			`Avoid consecutive array \`${inner.name}\` and \`${outer.name}\` passes. Prefer \`.values().${inner.name}(...).${outer.name}(...).toArray()\` where iterator helpers are supported, or a single \`flatMap\`/mutating reducer. Preserve callback ordering, indexes, and filtering semantics.`,
		);
	},
});
