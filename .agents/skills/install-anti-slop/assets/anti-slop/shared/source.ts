import type {
	AnyJsAstNode,
	JsAstElement,
	JsAstToken,
} from "@biomejs/runtime/plugin";

/**
 * Biome plugin nodes expose their trimmed text but no offsets, comments, or
 * stable object identity. A source index walks the tree once from a root node,
 * aligns every child inside the root's text, and records where each node starts
 * and ends together with the trivia (whitespace and comments) preceding it.
 *
 * Offsets are JavaScript string indices into `root.text`, not file offsets:
 * Biome trims the file's leading trivia from the root, so a comment before the
 * first statement in a file is not visible to plugins.
 */
export interface LocatedNode {
	readonly node: AnyJsAstNode;
	readonly kind: AnyJsAstNode["kind"];
	readonly start: number;
	readonly end: number;
	readonly parent: LocatedNode | undefined;
	/** Located child nodes in source order. Tokens are omitted. */
	readonly children: readonly LocatedNode[];
	/** End of the last token before this node, or `start` when nothing precedes it. */
	readonly triviaStart: number;
}

export interface LocatedToken {
	readonly token: JsAstToken;
	readonly start: number;
	readonly end: number;
	readonly parent: LocatedNode;
}

export interface Comment {
	readonly kind: "line" | "block";
	/** The comment's text, including its `//` or `/* *\/` delimiters. */
	readonly text: string;
	/** The comment's content without delimiters, trimmed. */
	readonly body: string;
	readonly start: number;
	readonly end: number;
}

export class SourceIndex {
	readonly text: string;
	readonly root: LocatedNode;
	/** Every located node in pre-order. */
	readonly nodes: readonly LocatedNode[];
	/** Every non-empty token in source order. */
	readonly tokens: readonly LocatedToken[];

	// Lookup tables are built on first use: most rules never need them, and
	// building them for every file is measurable in Biome's embedded engine.
	private byStart: Map<number, LocatedNode[]> | undefined;
	private byKind: Map<string, LocatedNode[]> | undefined;
	private lineStarts: number[] | undefined;

	constructor(root: AnyJsAstNode) {
		this.text = root.text;
		const nodes: LocatedNode[] = [];
		const tokens: LocatedToken[] = [];
		const state = { cursor: 0, lastTokenEnd: 0 };
		this.root = locate(this.text, root, undefined, state, nodes, tokens);
		this.nodes = nodes;
		this.tokens = tokens;
	}

	/** The source text of a located node, without crossing into the runtime. */
	textOf(entry: LocatedNode): string {
		return this.text.slice(entry.start, entry.end);
	}

	/** Source text between the previous token and this node. */
	leadingTrivia(entry: LocatedNode): string {
		return this.text.slice(entry.triviaStart, entry.start);
	}

	/** Comments between the previous token and this node, in source order. */
	leadingComments(entry: LocatedNode): readonly Comment[] {
		return scanComments(this.text, entry.triviaStart, entry.start);
	}

	/**
	 * Leading comments that start on their own line. A comment on the same line
	 * as the previous token, such as `foo(); // note`, belongs to that token and
	 * is excluded.
	 */
	ownLineComments(entry: LocatedNode): readonly Comment[] {
		const comments = this.leadingComments(entry);
		if (
			entry.triviaStart === 0 &&
			this.tokenBefore(entry.start) === undefined
		) {
			return comments;
		}
		const firstBreak = this.text.indexOf("\n", entry.triviaStart);
		if (firstBreak < 0 || firstBreak >= entry.start) return [];
		return comments.filter((comment) => comment.start > firstBreak);
	}

	/** Number of line breaks between the previous token and this node. */
	lineBreaksBefore(entry: LocatedNode): number {
		return countLineBreaks(this.text, entry.triviaStart, entry.start);
	}

	/** Returns the located nodes starting at `start`, outermost first. */
	nodesAt(start: number): readonly LocatedNode[] {
		this.byStart ??= groupBy(this.nodes, (entry) => entry.start);
		return this.byStart.get(start) ?? [];
	}

	/**
	 * Finds the located entry for a node handle obtained outside the index, such
	 * as `binding.syntax()`. Handles have no identity, so the match is structural:
	 * same kind and text, then the same chain of ancestor kinds and texts.
	 * Textually identical subtrees inside textually identical parents cannot be
	 * told apart; the first one in source order is returned.
	 */
	find(node: AnyJsAstNode): LocatedNode | undefined {
		const text = node.text;
		this.byKind ??= groupBy(this.nodes, (entry) => entry.kind);
		const candidates = (this.byKind.get(node.kind) ?? []).filter(
			(entry) =>
				entry.end - entry.start === text.length && this.textOf(entry) === text,
		);
		if (candidates.length <= 1) return candidates[0];
		const ancestors = node.ancestors();
		return (
			candidates.find((candidate) => {
				let current = candidate.parent;
				for (const ancestor of ancestors) {
					if (
						!current ||
						current.kind !== ancestor.kind ||
						this.textOf(current) !== ancestor.text
					) {
						return false;
					}
					current = current.parent;
				}
				return current === undefined;
			}) ?? candidates[0]
		);
	}

	/** The first token at or after `offset`. */
	tokenAt(offset: number): LocatedToken | undefined {
		return this.tokens[this.firstTokenIndex((token) => token.start >= offset)];
	}

	/** The last token that ends at or before `offset`. */
	tokenBefore(offset: number): LocatedToken | undefined {
		return this.tokens[this.firstTokenIndex((token) => token.end > offset) - 1];
	}

	/** 1-based line number of an offset inside the root's text. */
	lineOf(offset: number): number {
		if (!this.lineStarts) {
			this.lineStarts = [0];
			for (let position = 0; position < this.text.length; position += 1) {
				if (this.text.charCodeAt(position) === LINE_FEED) {
					this.lineStarts.push(position + 1);
				}
			}
		}
		const starts = this.lineStarts;
		let low = 0;
		let high = starts.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((starts[middle] ?? 0) <= offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	/** Binary search: index of the first token satisfying a monotonic predicate. */
	private firstTokenIndex(predicate: (token: LocatedToken) => boolean): number {
		let low = 0;
		let high = this.tokens.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			const token = this.tokens[middle];
			if (token && predicate(token)) high = middle;
			else low = middle + 1;
		}
		return low;
	}
}

interface WalkState {
	cursor: number;
	lastTokenEnd: number;
}

function locate(
	text: string,
	node: AnyJsAstNode,
	parent: LocatedNode | undefined,
	state: WalkState,
	nodes: LocatedNode[],
	tokens: LocatedToken[],
): LocatedNode {
	// A node spans from its first token to its last, so only token text, which
	// totals the file's size once, crosses the runtime boundary. Reading
	// `node.text` for every node would copy each subtree once per ancestor.
	const triviaStart = state.lastTokenEnd;
	const entry = {
		node,
		kind: node.kind,
		start: -1,
		end: -1,
		parent,
		children: [] as LocatedNode[],
		triviaStart,
	};
	nodes.push(entry);
	for (const element of node.childrenWithTokens()) {
		let elementStart: number;
		let elementEnd: number;
		if (isToken(element)) {
			const tokenText = element.text;
			if (tokenText === "") continue;
			elementStart = alignedStart(text, tokenText, state.cursor);
			elementEnd = elementStart + tokenText.length;
			tokens.push({
				token: element,
				start: elementStart,
				end: elementEnd,
				parent: entry,
			});
			state.cursor = elementEnd;
			state.lastTokenEnd = elementEnd;
		} else {
			const child = locate(text, element, entry, state, nodes, tokens);
			entry.children.push(child);
			if (child.start === child.end) continue;
			elementStart = child.start;
			elementEnd = child.end;
		}
		if (entry.start < 0) entry.start = elementStart;
		entry.end = elementEnd;
	}
	if (entry.start < 0) {
		// Empty nodes, such as an empty statement list, sit right after the
		// previous token with no trivia of their own.
		entry.start = state.cursor;
		entry.end = state.cursor;
		entry.triviaStart = state.cursor;
	}
	return entry;
}

function groupBy<K>(
	entries: readonly LocatedNode[],
	key: (entry: LocatedNode) => K,
): Map<K, LocatedNode[]> {
	const groups = new Map<K, LocatedNode[]>();
	for (const entry of entries) {
		const group = groups.get(key(entry));
		if (group) group.push(entry);
		else groups.set(key(entry), [entry]);
	}
	return groups;
}

function isToken(element: JsAstElement): element is JsAstToken {
	return !("children" in element);
}

/**
 * Children appear in order separated only by trivia, so the next child starts
 * after skipping whitespace and comments. JSX text can begin with whitespace,
 * which the fallback search handles.
 */
function alignedStart(text: string, part: string, cursor: number): number {
	if (part === "") return cursor;
	const afterTrivia = skipTrivia(text, cursor);
	if (text.startsWith(part, afterTrivia)) return afterTrivia;
	if (text.startsWith(part, cursor)) return cursor;
	const found = text.indexOf(part, cursor);
	return found < 0 ? cursor : found;
}

const SLASH = 0x2f;
const ASTERISK = 0x2a;
const LINE_FEED = 0x0a;

/** Whitespace that Biome treats as trivia: tab, line breaks, space, NBSP, and BOM. */
function isTriviaSpace(code: number): boolean {
	return (
		(code >= 0x09 && code <= 0x0d) ||
		code === 0x20 ||
		code === 0xa0 ||
		code === 0xfeff
	);
}

// Plugins run in Biome's embedded engine, where indexing a string allocates a
// one-character string. Scanning with char codes keeps the walk cheap.
function skipTrivia(text: string, offset: number): number {
	let position = offset;
	while (position < text.length) {
		const code = text.charCodeAt(position);
		if (isTriviaSpace(code)) {
			position += 1;
		} else if (code === SLASH && text.charCodeAt(position + 1) === SLASH) {
			const lineEnd = text.indexOf("\n", position);
			position = lineEnd < 0 ? text.length : lineEnd;
		} else if (code === SLASH && text.charCodeAt(position + 1) === ASTERISK) {
			const blockEnd = text.indexOf("*/", position + 2);
			position = blockEnd < 0 ? text.length : blockEnd + 2;
		} else {
			return position;
		}
	}
	return position;
}

/** Comments inside a trivia-only range of `text`. */
export function scanComments(
	text: string,
	start: number,
	end: number,
): readonly Comment[] {
	const comments: Comment[] = [];
	let position = start;
	while (position < end) {
		const code = text.charCodeAt(position);
		const next = text.charCodeAt(position + 1);
		if (code === SLASH && next === SLASH) {
			const lineEnd = text.indexOf("\n", position);
			const commentEnd = lineEnd < 0 || lineEnd > end ? end : lineEnd;
			const raw = text.slice(position, commentEnd).replace(/\r$/, "");
			comments.push({
				kind: "line",
				text: raw,
				body: raw.slice(2).trim(),
				start: position,
				end: position + raw.length,
			});
			position = commentEnd;
		} else if (code === SLASH && next === ASTERISK) {
			const blockEnd = text.indexOf("*/", position + 2);
			const commentEnd = blockEnd < 0 ? end : Math.min(blockEnd + 2, end);
			const raw = text.slice(position, commentEnd);
			comments.push({
				kind: "block",
				text: raw,
				body: raw
					.replace(/^\/\*+/, "")
					.replace(/\*\/$/, "")
					.trim(),
				start: position,
				end: commentEnd,
			});
			position = commentEnd;
		} else {
			position += 1;
		}
	}
	return comments;
}

export function countLineBreaks(
	text: string,
	start: number,
	end: number,
): number {
	let count = 0;
	for (let position = start; position < end; position += 1) {
		if (text.charCodeAt(position) === LINE_FEED) count += 1;
	}
	return count;
}
