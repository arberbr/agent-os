import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../../shared/report.ts";
import type { TagMember } from "../shared/tagged-values.ts";
import {
	isInsideBroadEffectHandler,
	isReasonTagMember,
	tagMember,
	tagMemberFromComparison,
} from "../shared/tagged-values.ts";

const TAG_MESSAGE =
	"Use Effect.catchTag or Effect.catchTags instead of manually discriminating a tagged error in a broad Effect catch handler.";
const REASON_MESSAGE =
	"Use Effect.catchReason or Effect.catchReasons instead of manually discriminating a tagged `reason` in a broad Effect catch handler.";

function message(member: TagMember): string {
	return isReasonTagMember(member) ? REASON_MESSAGE : TAG_MESSAGE;
}

/** Use Effect tagged error handlers instead of manually branching on `_tag` in a catch handler. */
export const noManualEffectErrorTag = defineRule({
	query: ast("JS_BINARY_EXPRESSION", "JS_SWITCH_STATEMENT"),
	run(node) {
		const member =
			node.kind === "JS_BINARY_EXPRESSION"
				? tagMemberFromComparison(node)
				: tagMember(node.discriminant);
		if (member === undefined || !isInsideBroadEffectHandler(node)) return;
		report("noManualEffectErrorTag", node, message(member));
	},
});
