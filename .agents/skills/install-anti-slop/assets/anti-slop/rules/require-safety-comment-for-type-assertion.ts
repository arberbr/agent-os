import { ast, defineRule } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import type { LocatedNode } from "../shared/source.ts";
import { SourceIndex } from "../shared/source.ts";

/**
 * Comment markers that introduce a type assertion's justification, such as
 * `// SAFETY: the parser checked the brand`. Biome plugin entries take no
 * options, so teams that vendor this rule edit this list to use their own
 * markers (for example `["SAFETY", "INVARIANT"]`). The first marker is the one
 * named in diagnostics.
 */
const MARKERS = ["SAFETY"];

const RULE_NAME = "requireSafetyCommentForTypeAssertion";

/** A marker followed by a colon and at least one non-space character of justification. */
const MARKER_PATTERN = new RegExp(
	String.raw`(?:^|[^\p{L}\p{N}_])(?:${MARKERS.map(escapeRegExp).join("|")})\s*:\s*\S`,
	"u",
);

/**
 * Nodes that own the comments above them. The search for a justification
 * climbs from the assertion through its ancestors and stops at the first of
 * these, so a comment on an enclosing function does not cover every assertion
 * in its body statements.
 */
const COMMENT_OWNER_KINDS = new Set<string>([
	"JS_EXPRESSION_STATEMENT",
	"JS_PROPERTY_CLASS_MEMBER",
	"JS_RETURN_STATEMENT",
	"JS_THROW_STATEMENT",
	"JS_VARIABLE_DECLARATION",
]);

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertion = defineRule({
	query: ast("JS_MODULE", "JS_SCRIPT"),
	run(root) {
		const index = new SourceIndex(root);
		for (const entry of index.nodes) {
			// Assertions on assignment targets, such as `(x as T) += 1`, are
			// separate node kinds in Biome; ESTree represents both the same way.
			if (
				entry.kind !== "TS_AS_EXPRESSION" &&
				entry.kind !== "TS_TYPE_ASSERTION_EXPRESSION" &&
				entry.kind !== "TS_AS_ASSIGNMENT" &&
				entry.kind !== "TS_TYPE_ASSERTION_ASSIGNMENT"
			) {
				continue;
			}
			if (isConstAssertion(entry)) continue;
			const result = findJustification(index, entry);
			if (result === "found") continue;
			const hint =
				result === "hidden"
					? ` Biome plugins cannot read comments before a file's first statement, so put the comment inside the statement, as in \`const value = /* ${MARKERS[0]}: ... */ input as Type\`.`
					: "";
			report(
				RULE_NAME,
				entry.node,
				`This type assertion has no \`${MARKERS[0]}:\` justification. State the checked invariant immediately before the assertion or its containing statement.${hint}`,
			);
		}
	},
});

function isConstAssertion(entry: LocatedNode): boolean {
	const node = entry.node;
	if (
		node.kind !== "TS_AS_EXPRESSION" &&
		node.kind !== "TS_TYPE_ASSERTION_EXPRESSION"
	) {
		return false;
	}
	const type = node.ty;
	return type?.kind === "TS_REFERENCE_TYPE" && type.text === "const";
}

/**
 * Looks for a justification comment directly before the assertion or one of
 * its ancestors, up to the nearest comment owner. A variable declaration that
 * is exported also accepts a comment above its `export` keyword. Returns
 * `hidden` when the search reached the start of the file, whose leading
 * comments Biome does not expose to plugins.
 */
function findJustification(
	index: SourceIndex,
	assertion: LocatedNode,
): "found" | "missing" | "hidden" {
	let current: LocatedNode = assertion;
	while (true) {
		if (!current.kind.endsWith("_LIST")) {
			if (hasJustificationBefore(index, current, assertion)) return "found";
			if (isAtFileStart(current)) return "hidden";
		}
		if (COMMENT_OWNER_KINDS.has(current.kind)) {
			const exported = exportOf(current);
			if (!exported) return "missing";
			if (hasJustificationBefore(index, exported, assertion)) return "found";
			return isAtFileStart(exported) ? "hidden" : "missing";
		}
		const parent = current.parent;
		if (!parent || parent === index.root) return "missing";
		current = parent;
	}
}

/** The `export` statement wrapping a variable declaration, as in `export const value = ...`. */
function exportOf(entry: LocatedNode): LocatedNode | undefined {
	if (entry.kind !== "JS_VARIABLE_DECLARATION") return undefined;
	const clause = entry.parent;
	if (clause?.kind !== "JS_VARIABLE_DECLARATION_CLAUSE") return undefined;
	const statement = clause.parent;
	return statement?.kind === "JS_EXPORT" ? statement : undefined;
}

function hasJustificationBefore(
	index: SourceIndex,
	entry: LocatedNode,
	assertion: LocatedNode,
): boolean {
	return index
		.leadingComments(entry)
		.some(
			(comment) =>
				comment.end <= assertion.start && MARKER_PATTERN.test(comment.body),
		);
}

/**
 * The root's text starts at the file's first token, so only nodes starting at
 * offset 0 have leading trivia that plugins cannot see.
 */
function isAtFileStart(entry: LocatedNode): boolean {
	return entry.start === 0;
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
