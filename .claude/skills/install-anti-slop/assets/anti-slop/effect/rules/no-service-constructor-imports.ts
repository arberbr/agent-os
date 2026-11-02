import type {
	AnyJsNamedImportSpecifier,
	JsNamedImportSpecifiers,
} from "@biomejs/runtime/plugin";
import { ast, defineRule } from "@biomejs/runtime/plugin";
import { report } from "../../shared/report.ts";
import { stringLiteralValue } from "../../shared/syntax.ts";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isProjectLocalImport(source: string | undefined): boolean {
	return (
		source !== undefined &&
		(source.startsWith("./") || source.startsWith("../"))
	);
}

/** The exported name a specifier imports: `name` in `{ name }`, `{ name as local }`, or `{ "name" as local }`. */
function importedName(
	specifier: AnyJsNamedImportSpecifier,
): string | undefined {
	if (specifier.kind === "JS_SHORTHAND_NAMED_IMPORT_SPECIFIER") {
		const local = specifier.localName;
		return local?.kind === "JS_IDENTIFIER_BINDING"
			? local.nameToken
			: undefined;
	}
	if (specifier.kind === "JS_NAMED_IMPORT_SPECIFIER") {
		const name = specifier.name;
		if (name?.kind !== "JS_LITERAL_EXPORT_NAME" || name.value === undefined)
			return undefined;
		const quoted = name.value.startsWith('"') || name.value.startsWith("'");
		return quoted ? stringLiteralValue(name.value) : name.value;
	}
	return undefined;
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImports = defineRule({
	query: ast("JS_IMPORT_NAMED_CLAUSE", "JS_IMPORT_COMBINED_CLAUSE"),
	run(node, context) {
		if (TEST_FILE.test(context.filePath.replaceAll("\\", "/"))) return;
		const source = node.source;
		if (source?.kind !== "JS_MODULE_SOURCE") return;
		if (!isProjectLocalImport(stringLiteralValue(source.valueToken))) return;

		let named: JsNamedImportSpecifiers | undefined;
		if (node.kind === "JS_IMPORT_NAMED_CLAUSE") named = node.namedSpecifiers;
		else if (node.specifier?.kind === "JS_NAMED_IMPORT_SPECIFIERS")
			named = node.specifier;

		for (const specifier of named?.specifiers ?? []) {
			const name = importedName(specifier);
			if (name === undefined || !SERVICE_CONSTRUCTOR_NAME.test(name)) continue;
			report(
				"noServiceConstructorImports",
				specifier,
				`Do not import Effect service constructor "${name}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.`,
			);
		}
	},
});
