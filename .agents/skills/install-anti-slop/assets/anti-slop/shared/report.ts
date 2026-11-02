import type { CodeFix, JsAstNode, Severity } from "@biomejs/runtime/plugin";
import { registerDiagnostic } from "@biomejs/runtime/plugin";

/**
 * Severity used by every anti-slop rule. Biome plugin entries cannot set a
 * severity in configuration, so edit this vendored constant to change it.
 */
export const SEVERITY: Severity = "error";

/**
 * Reports a diagnostic tagged with the rule name. Biome labels every plugin
 * diagnostic `plugin`, so the tag tells readers which rule fired and what to
 * write in a `biome-ignore lint/plugin/<ruleName>: <reason>` comment.
 */
export function report(
	ruleName: string,
	node: JsAstNode,
	message: string,
	fix?: CodeFix,
): void {
	registerDiagnostic(node, SEVERITY, `${message} [anti-slop/${ruleName}]`, fix);
}
