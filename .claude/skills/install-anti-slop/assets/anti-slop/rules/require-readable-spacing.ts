import type { CodeFix } from "@biomejs/runtime/plugin";
import {
	ast,
	createMutation,
	defineRule,
	factory,
} from "@biomejs/runtime/plugin";
import { report } from "../shared/report.ts";
import type { LocatedNode, LocatedToken } from "../shared/source.ts";
import { SourceIndex } from "../shared/source.ts";
import { unwrapParentheses } from "../shared/syntax.ts";

/*
 * The policy and its statement matchers reproduce the configuration that the
 * original anti-slop rule passed to ESLint Stylistic's
 * `padding-line-between-statements`; see `../vendor/eslint-stylistic/UPSTREAM.md`.
 */

const RULE_NAME = "requireReadableSpacing";

/** Nodes whose statement lists are checked, mirroring the upstream scopes. */
const CONTAINER_KINDS = new Set<string>([
	"JS_MODULE",
	"JS_SCRIPT",
	"JS_FUNCTION_BODY",
	"JS_BLOCK_STATEMENT",
	"JS_STATIC_INITIALIZATION_BLOCK_CLASS_MEMBER",
	"JS_SWITCH_STATEMENT",
	"JS_CASE_CLAUSE",
	"JS_DEFAULT_CLAUSE",
	"TS_MODULE_BLOCK",
]);

/** Lists holding the statements of a container. Directives precede the other statements. */
const STATEMENT_LIST_KINDS = new Set<string>([
	"JS_DIRECTIVE_LIST",
	"JS_MODULE_ITEM_LIST",
	"JS_STATEMENT_LIST",
	"JS_SWITCH_CASE_LIST",
]);

const ROOT_KINDS = new Set<string>(["JS_MODULE", "JS_SCRIPT"]);

const CONTROL_FLOW_KINDS = new Set<string>([
	"JS_RETURN_STATEMENT",
	"JS_IF_STATEMENT",
	"JS_SWITCH_STATEMENT",
	"JS_TRY_STATEMENT",
	"JS_TRY_FINALLY_STATEMENT",
	"JS_FOR_STATEMENT",
	"JS_FOR_IN_STATEMENT",
	"JS_FOR_OF_STATEMENT",
	"JS_WHILE_STATEMENT",
	"JS_DO_WHILE_STATEMENT",
]);

/** Nodes whose closing brace makes a statement block-like. */
const BLOCK_KINDS = new Set<string>([
	"JS_BLOCK_STATEMENT",
	"JS_FUNCTION_BODY",
	"JS_SWITCH_STATEMENT",
]);

/** One statement in a checked list, with the context the matchers need. */
interface Statement {
	readonly source: Source;
	readonly entry: LocatedNode;
	/** The statement with any labels removed, which is what matchers inspect. */
	readonly inner: LocatedNode;
	/** Whether the statement sits directly in the module or script body. */
	readonly topLevel: boolean;
}

type Matcher = (statement: Statement) => boolean;

interface PolicyEntry {
	readonly blankLine: "always" | "any";
	readonly prev: Matcher;
	readonly next: Matcher;
}

const anyStatement: Matcher = () => true;

const isImport: Matcher = ({ inner }) => inner.kind === "JS_IMPORT";

const isTopLevelNonImport: Matcher = ({ entry, inner, topLevel }) =>
	topLevel && entry === inner && inner.kind !== "JS_IMPORT";

/** `function`, `class`, `interface`, and `type` declarations, without `export` or `declare`. */
const isDeclaration: Matcher = (statement) => {
	switch (statement.inner.kind) {
		case "JS_FUNCTION_DECLARATION":
			return true;
		case "JS_CLASS_DECLARATION":
			return firstTokenText(statement) === "class";
		case "TS_INTERFACE_DECLARATION":
			return firstTokenText(statement) === "interface";
		case "TS_TYPE_ALIAS_DECLARATION":
			return firstTokenText(statement) === "type";
		default:
			return false;
	}
};

/** A `const`, `let`, `var`, `using`, or `await using` statement spanning several lines. */
const isMultilineBinding: Matcher = (statement) =>
	statement.inner.kind === "JS_VARIABLE_STATEMENT" && !isSingleLine(statement);

const isControlFlow: Matcher = ({ inner }) =>
	CONTROL_FLOW_KINDS.has(inner.kind);

const isBlockLike: Matcher = (statement) => {
	const node = statement.inner.node;
	if (
		node.kind === "JS_DO_WHILE_STATEMENT" &&
		node.body?.kind === "JS_BLOCK_STATEMENT"
	) {
		return true;
	}
	if (isIifeStatement(statement.inner)) return true;
	const last = statement.source.lastToken(
		statement.inner,
		(token) => token.token.kind !== "SEMICOLON",
	);
	return last?.token.kind === "R_CURLY" && BLOCK_KINDS.has(last.parent.kind);
};

/** A binding declaration on one line, optionally exported or declared. */
const isSinglelineBinding: Matcher = (statement) =>
	isBindingStatement(statement.inner) && isSingleLine(statement);

/** A single-line binding without a comment on its own line above it. */
const isUndocumentedSinglelineBinding: Matcher = (statement) =>
	isSinglelineBinding(statement) &&
	statement.source.index.ownLineComments(statement.entry).length === 0;

const isOverloadSignature: Matcher = ({ inner }) => {
	const declaration = exportedDeclarationKind(inner);
	return (
		declaration === "TS_DECLARE_FUNCTION_DECLARATION" ||
		declaration === "TS_DECLARE_FUNCTION_EXPORT_DEFAULT_DECLARATION"
	);
};

const isOverloadContinuation: Matcher = (statement) => {
	const declaration = exportedDeclarationKind(statement.inner);
	return (
		isOverloadSignature(statement) ||
		declaration === "JS_FUNCTION_DECLARATION" ||
		declaration === "JS_FUNCTION_EXPORT_DEFAULT_DECLARATION"
	);
};

/**
 * The spacing policy. The last entry matching a pair of adjacent statements
 * decides whether a blank line is required between them; pairs that match no
 * entry are left alone. Existing blank lines are never removed.
 */
const POLICY: readonly PolicyEntry[] = [
	{ blankLine: "always", prev: isImport, next: anyStatement },
	{ blankLine: "always", prev: anyStatement, next: isTopLevelNonImport },
	{ blankLine: "always", prev: isTopLevelNonImport, next: anyStatement },
	{ blankLine: "always", prev: anyStatement, next: isDeclaration },
	{ blankLine: "always", prev: isDeclaration, next: anyStatement },
	{ blankLine: "always", prev: anyStatement, next: isMultilineBinding },
	{ blankLine: "always", prev: isMultilineBinding, next: anyStatement },
	{ blankLine: "always", prev: anyStatement, next: isControlFlow },
	{ blankLine: "always", prev: isBlockLike, next: anyStatement },
	{ blankLine: "any", prev: isImport, next: isImport },
	// Consecutive single-line bindings form one group at any scope, including
	// module scope. A binding with its own leading comment starts a new group.
	{
		blankLine: "any",
		prev: isSinglelineBinding,
		next: isUndocumentedSinglelineBinding,
	},
	// Overload signatures stay attached to each other and to their implementation.
	{ blankLine: "any", prev: isOverloadSignature, next: isOverloadContinuation },
];

/** Restore structural blank lines with whitespace-only fixes; keep single-line binding groups and overloads grouped. */
export const requireReadableSpacing = defineRule({
	query: ast("JS_MODULE", "JS_SCRIPT"),
	run(root) {
		const source = new Source(new SourceIndex(root));
		for (const container of source.index.nodes) {
			if (!CONTAINER_KINDS.has(container.kind)) continue;
			const topLevel = ROOT_KINDS.has(container.kind);
			const statements = container.children
				.filter((child) => STATEMENT_LIST_KINDS.has(child.kind))
				.flatMap((list) => list.children)
				.map((entry) => ({
					source,
					entry,
					inner: withoutLabels(entry),
					topLevel,
				}));
			for (let position = 1; position < statements.length; position += 1) {
				const prev = statements[position - 1];
				const next = statements[position];
				if (!prev || !next || paddingFor(prev, next) !== "always") continue;
				const lastToken = source.actualLastToken(prev.entry);
				if (!lastToken || source.hasBlankLine(lastToken.end, next.entry.start))
					continue;
				report(
					RULE_NAME,
					next.entry.node,
					"Expected a blank line before this statement. Separate declarations, control flow, and logical statement groups with blank lines.",
					source.blankLineFix(lastToken, next.entry),
				);
			}
		}
	},
});

function paddingFor(prev: Statement, next: Statement): "always" | "any" {
	for (let position = POLICY.length - 1; position >= 0; position -= 1) {
		const entry = POLICY[position];
		if (entry?.prev(prev) && entry.next(next)) return entry.blankLine;
	}
	return "any";
}

function withoutLabels(entry: LocatedNode): LocatedNode {
	let current = entry;
	while (current.kind === "JS_LABELED_STATEMENT") {
		const body = current.children.at(-1);
		if (!body || body.kind === "JS_LABEL") break;
		current = body;
	}
	return current;
}

function firstTokenText(statement: Statement): string | undefined {
	return statement.source.firstToken(statement.inner)?.token.text;
}

function isSingleLine(statement: Statement): boolean {
	const { source, inner } = statement;
	return source.lineOf(inner.start) === source.lineOf(inner.end);
}

/** `const`, `let`, `var`, `using`, and `await using` statements, including `export` and `declare` forms. */
function isBindingStatement(entry: LocatedNode): boolean {
	return (
		entry.kind === "JS_VARIABLE_STATEMENT" ||
		exportedDeclarationKind(entry) === "JS_VARIABLE_DECLARATION_CLAUSE"
	);
}

/**
 * The kind of the declaration a statement introduces, looking through
 * `export`, `export default`, `declare`, and `export declare` wrappers.
 */
function exportedDeclarationKind(entry: LocatedNode): string | undefined {
	const node = entry.node;
	if (node.kind === "TS_DECLARE_STATEMENT") return node.declaration?.kind;
	if (node.kind !== "JS_EXPORT") return node.kind;
	const clause = node.exportClause;
	if (clause?.kind === "TS_EXPORT_DECLARE_CLAUSE")
		return clause.declaration?.kind;
	if (clause?.kind === "JS_EXPORT_DEFAULT_DECLARATION_CLAUSE")
		return clause.declaration?.kind;
	return clause?.kind;
}

/** An expression statement that immediately invokes a function, such as `(() => {})()` or `!function () {}()`. */
function isIifeStatement(entry: LocatedNode): boolean {
	const node = entry.node;
	if (node.kind !== "JS_EXPRESSION_STATEMENT") return false;
	let expression = unwrapParentheses(node.expression);
	if (expression?.kind === "JS_UNARY_EXPRESSION") {
		expression = unwrapParentheses(expression.argument);
	}
	if (expression?.kind !== "JS_CALL_EXPRESSION") return false;
	let callee = unwrapParentheses(expression.callee);
	while (callee?.kind === "JS_SEQUENCE_EXPRESSION") {
		callee = unwrapParentheses(callee.right);
	}
	return (
		callee?.kind === "JS_FUNCTION_EXPRESSION" ||
		callee?.kind === "JS_ARROW_FUNCTION_EXPRESSION"
	);
}

/** Token, line, and gap queries over one source index. */
class Source {
	readonly index: SourceIndex;
	private readonly lineStarts: readonly number[];
	private readonly lineEnding: string;

	constructor(index: SourceIndex) {
		this.index = index;
		const starts = [0];
		for (
			let offset = index.text.indexOf("\n");
			offset >= 0;
			offset = index.text.indexOf("\n", offset + 1)
		) {
			starts.push(offset + 1);
		}
		this.lineStarts = starts;
		this.lineEnding = index.text.includes("\r\n") ? "\r\n" : "\n";
	}

	/** 1-based line of an offset. */
	lineOf(offset: number): number {
		let low = 0;
		let high = this.lineStarts.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.lineStarts[middle] ?? 0) <= offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	firstToken(entry: LocatedNode): LocatedToken | undefined {
		const token = this.index.tokens[this.firstTokenIndex(entry.start)];
		return token && token.end <= entry.end ? token : undefined;
	}

	/** The last token inside `entry` that satisfies `accept`. */
	lastToken(
		entry: LocatedNode,
		accept: (token: LocatedToken) => boolean = () => true,
	): LocatedToken | undefined {
		for (
			let position = this.firstTokenIndex(entry.end) - 1;
			position >= 0;
			position -= 1
		) {
			const token = this.index.tokens[position];
			if (!token || token.start < entry.start) return undefined;
			if (token.end <= entry.end && accept(token)) return token;
		}
		return undefined;
	}

	/**
	 * The statement's last token, except that a semicolon starting the next
	 * line in semicolon-free code (`foo()\n;[1].forEach(f)`) is skipped.
	 */
	actualLastToken(entry: LocatedNode): LocatedToken | undefined {
		const lastIndex = this.firstTokenIndex(entry.end) - 1;
		const last = this.index.tokens[lastIndex];
		if (!last || last.start < entry.start) return undefined;
		if (last.token.kind !== "SEMICOLON") return last;
		const before = this.index.tokens[lastIndex - 1];
		const after = this.index.tokens[lastIndex + 1];
		const semicolonFree =
			before !== undefined &&
			after !== undefined &&
			before.start >= entry.start &&
			this.lineOf(before.end) !== this.lineOf(last.start) &&
			this.lineOf(last.end) === this.lineOf(after.start);
		return semicolonFree ? before : last;
	}

	/**
	 * Whether a blank line separates `start` from `end`. Comments and tokens
	 * inside the range split it, so a blank line inside a block comment does
	 * not count.
	 */
	hasBlankLine(start: number, end: number): boolean {
		const text = this.index.text;
		let lineBreaks = 0;
		let position = start;
		while (position < end) {
			const character = text[position];
			if (character === "\n") {
				lineBreaks += 1;
				if (lineBreaks >= 2) return true;
				position += 1;
			} else if (character !== undefined && /\s/u.test(character)) {
				position += 1;
			} else if (text.startsWith("//", position)) {
				lineBreaks = 0;
				const lineEnd = text.indexOf("\n", position);
				position = lineEnd < 0 ? end : lineEnd;
			} else if (text.startsWith("/*", position)) {
				lineBreaks = 0;
				const blockEnd = text.indexOf("*/", position + 2);
				position = blockEnd < 0 ? end : blockEnd + 2;
			} else {
				lineBreaks = 0;
				position += 1;
			}
		}
		return false;
	}

	/**
	 * Inserts a line break directly after the previous statement's last token,
	 * which leaves comments above the next statement attached to it. Plugin
	 * mutations cannot edit trivia, so the token is replaced by an identifier
	 * token carrying its own text plus the line break; Biome reparses the
	 * result. Anything else on the rest of that line, such as a trailing
	 * comment, would move to the next line, so no fix is offered then.
	 */
	blankLineFix(
		lastToken: LocatedToken,
		next: LocatedNode,
	): CodeFix | undefined {
		const text = this.index.text;
		const lineBreak = text.indexOf("\n", lastToken.end);
		const sameLine = lineBreak < 0 || lineBreak >= next.start;
		if (
			text.slice(lastToken.end, sameLine ? next.start : lineBreak).trim() !== ""
		) {
			return undefined;
		}
		const insertion = sameLine
			? this.lineEnding + this.lineEnding
			: this.lineEnding;
		const mutation = createMutation(this.index.root.node);
		mutation.replaceToken(
			lastToken.token,
			factory.token("IDENT", lastToken.token.text + insertion),
		);
		return {
			mutation,
			message: "Insert a blank line before this statement.",
			kind: "safe",
		};
	}

	/** Index of the first token starting at or after `offset`. */
	private firstTokenIndex(offset: number): number {
		const tokens = this.index.tokens;
		let low = 0;
		let high = tokens.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((tokens[middle]?.start ?? 0) < offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}
}
