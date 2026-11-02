import type { AnyJsAstNode, SemanticModel } from "@biomejs/runtime/plugin";
import { defineRule, semantic } from "@biomejs/runtime/plugin";

import { report } from "../shared/report.ts";
import {
	closestAncestor,
	memberName,
	memberObject,
	stringLiteralValue,
	unwrapParentheses,
} from "../shared/syntax.ts";

const MODULE_MOCK_METHODS = new Set(["doMock", "mock", "unstable_mockModule"]);

/** The framework objects that expose module mocking, keyed by the module that exports them. */
const FRAMEWORK_EXPORTS: Readonly<Record<string, string>> = {
	vitest: "vi",
	"@jest/globals": "jest",
};

/** The unquoted spelling of an import specifier's exported name: `vi` or `"vi"`. */
function exportName(literal: string | undefined): string | undefined {
	return stringLiteralValue(literal) ?? literal;
}

/** The name a binding imports from its module, or `undefined` for non-named imports. */
function importedName(identifier: AnyJsAstNode): string | undefined {
	const specifier = identifier.parent;
	if (specifier?.kind === "JS_SHORTHAND_NAMED_IMPORT_SPECIFIER")
		return identifier.text;
	if (specifier?.kind === "JS_NAMED_IMPORT_SPECIFIER")
		return exportName(specifier.name?.text);
	return undefined;
}

function isTestFrameworkObject(
	model: SemanticModel,
	expression: AnyJsAstNode | undefined,
): boolean {
	if (expression?.kind !== "JS_IDENTIFIER_EXPRESSION" || !expression.name)
		return false;
	const binding = model.binding(expression.name);
	if (binding === undefined) {
		const name = expression.name.valueToken;
		return name === "vi" || name === "jest";
	}
	const identifier = binding.syntax();
	const clause = closestAncestor(identifier, [
		"JS_IMPORT_NAMED_CLAUSE",
		"JS_IMPORT_COMBINED_CLAUSE",
	]);
	const source = stringLiteralValue(clause?.source?.text);
	const name = importedName(identifier);
	return (
		source !== undefined &&
		name !== undefined &&
		FRAMEWORK_EXPORTS[source] === name
	);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMocking = defineRule({
	query: semantic("JS_CALL_EXPRESSION"),
	run(node, context) {
		const callee = unwrapParentheses(node.callee);
		const method = memberName(callee);
		if (method === undefined || !MODULE_MOCK_METHODS.has(method)) return;
		if (!isTestFrameworkObject(context.model, memberObject(callee))) return;
		report(
			"noModuleMocking",
			node,
			"Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
		);
	},
});
