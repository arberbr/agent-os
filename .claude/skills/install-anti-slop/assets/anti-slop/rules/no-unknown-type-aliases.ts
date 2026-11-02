import { defineRule, semantic } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import {
	createTypeAliasEnvironment,
	resolvedTypeIncludes,
	typeAliasName,
} from "../shared/type-alias-resolution.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliases = defineRule({
	query: semantic("TS_TYPE_ALIAS_DECLARATION"),
	run(node, context) {
		const body = node.ty;
		const name = typeAliasName(node);
		const id = node.bindingIdentifier;
		if (body === undefined || name === undefined || id === undefined) return;
		const hidesUnknown = resolvedTypeIncludes(
			body,
			createTypeAliasEnvironment(context.model),
			(resolved) => resolved.kind === "TS_UNKNOWN_TYPE",
		);
		if (!hidesUnknown) return;
		report(
			"noUnknownTypeAliases",
			id,
			`Type alias \`${name}\` hides \`unknown\`. Keep \`unknown\` explicit at the parsing boundary or on an allowed \`cause\` field; otherwise use the parsed owner type.`,
		);
	},
});
