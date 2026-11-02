# ESLint Stylistic provenance

`../../rules/require-readable-spacing.ts` is derived from `padding-line-between-statements` in [ESLint Stylistic](https://github.com/eslint-stylistic/eslint-stylistic), commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`, by way of the Oxlint anti-slop plugin, which vendored that rule unchanged apart from Oxlint type adapters.

The rule is MIT-licensed. `LICENSE` in this directory is the upstream root license, retained verbatim; both the OpenJS Foundation and ESLint Stylistic notices apply. Keep it with every redistributed copy, including skill assets.

## What was adapted

No upstream source file is shipped. The Biome rule reimplements, against Biome's concrete syntax tree, only the parts of the upstream engine that the anti-slop policy uses:

- Checked scopes: module and script bodies, function bodies, blocks, static blocks, `switch` statements and their clauses, and TypeScript module blocks. Upstream also visits interface and type literal bodies, but under this policy no pair of members there ever needs a blank line, so they are skipped.
- Statement matchers: `import`, `function`, `class`, `interface`, `type`, `multiline-const`/`let`/`var`/`using`, `return`, `if`, `switch`, `try`, `for`, `while`, `do`, and `block-like` (a `do`/`while` with a block body, an immediately invoked function, or a statement whose last non-semicolon token closes a block, function body, or `switch`). Keyword matchers keep upstream's first-token checks, so `abstract class`, `declare interface`, and decorated classes do not match `class` or `interface`. Labels are looked through, as upstream does.
- "Last matching entry wins" policy resolution, with unmatched pairs left alone.
- Blank-line detection: a blank line anywhere between the previous statement's last token and the next statement counts, but comments and tokens split the gap, so a blank line inside a block comment does not.
- The semicolon-free special case: a `;` that starts the next line (`foo()\n;[1].forEach(f)`) is not treated as the previous statement's last token.

Biome represents some syntax differently from ESTree, which the matchers account for:

- Directives are a separate list in Biome. They are checked as the first statements of their body, like upstream's directive expression statements.
- `export`, `export default`, `declare`, and `export declare` wrappers are looked through for the policy's own binding and overload matchers, mirroring the ESTree `ExportNamedDeclaration` checks of the original policy. Default-export overloads are grouped too; the original policy did not list them.

## Fixes

Upstream inserts `\n` after the previous statement's last token, or after its trailing comments. Biome plugin mutations cannot edit trivia, so the rule replaces that last token with an identifier token whose text is the original token followed by a line break (two when both statements share a line), and Biome reparses the result. A line break inserted directly after the token would move a same-line trailing comment to the next line, so the rule reports without a fix when anything follows the token on its line. Upstream's `never` padding type and its removal fixes are not ported; the anti-slop policy never removes blank lines.

## Updating

Compare upstream's `padding-line-between-statements` against the commit above, port relevant matcher or gap-detection fixes into the rule, update this record, and keep `LICENSE`. Run `node --test src/rules/require-readable-spacing.test.ts`, `pnpm check`, and `pnpm sync:skill-assets` as required by the repository guidance.
