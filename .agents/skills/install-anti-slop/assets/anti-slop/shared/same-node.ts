import type { AnyJsAstNode } from "@biomejs/runtime/plugin";

/**
 * Reports whether two handles denote the same syntax node. Biome node handles
 * have no stable identity, so the comparison is structural: same kind and text,
 * then the same chain of ancestor kinds and texts up to the root. Two textually
 * identical siblings under textually identical ancestors compare equal; such
 * nodes are interchangeable for the purely syntactic checks that rely on this.
 */
export function sameNode(
	left: AnyJsAstNode | undefined,
	right: AnyJsAstNode | undefined,
): boolean {
	if (left === undefined || right === undefined) return false;
	if (left.kind !== right.kind || left.text !== right.text) return false;
	const leftAncestors = left.ancestors();
	const rightAncestors = right.ancestors();
	if (leftAncestors.length !== rightAncestors.length) return false;
	return leftAncestors.every((ancestor, index) => {
		const other = rightAncestors[index];
		return (
			other !== undefined &&
			ancestor.kind === other.kind &&
			ancestor.text === other.text
		);
	});
}
