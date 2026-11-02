import { defineRule, semantic } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import { isGlobalMethodCall } from "../shared/syntax.ts";

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGet = defineRule({
	query: semantic("JS_CALL_EXPRESSION"),
	run(node, context) {
		if (isGlobalMethodCall(context.model, node, "Reflect", "get")) {
			report(
				"noReflectGet",
				node,
				"Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
			);
		}
	},
});
