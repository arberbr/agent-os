import { defineRule, semantic } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import { isGlobalMethodCall } from "../shared/syntax.ts";

/** Ban Reflect.apply, which bypasses ordinary typed function calls. */
export const noReflectApply = defineRule({
	query: semantic("JS_CALL_EXPRESSION"),
	run(node, context) {
		if (isGlobalMethodCall(context.model, node, "Reflect", "apply")) {
			report(
				"noReflectApply",
				node,
				"Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
			);
		}
	},
});
