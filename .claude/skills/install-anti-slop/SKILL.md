---
name: install-anti-slop
description: Install, configure, update, or upgrade vendored anti-slop Biome plugins. Use when adding anti-slop to a Biome project, picking up upstream rules or fixes, or migrating an existing installation while preserving local customizations.
---

# Install or update anti-slop for Biome

Anti-slop is vendored code: the target repository owns its rules, diagnostics, tests, and configuration. Preserve those choices when bringing in upstream changes.

The rules are Biome JavaScript plugins (`@biomejs/runtime/plugin`). Biome ships that API as a Developer Preview, and breaking changes can land in patch releases. Keep `@biomejs/biome` and `@biomejs/runtime` on the same exact version, and verify the plugins whenever that version moves.

## Choose the path

Read the repository's agent instructions and `git status`. Identify its package manager, its Biome configuration (`biome.json` or `biome.jsonc`, including nested and `extends`-ed configurations), and any existing anti-slop installation. Search for the vendored presets and rule files by content as well as by path: a renamed or relocated copy is still an installation if `extends` or `plugins` references it.

- **Existing installation (update, upgrade, migrate, or reconfigure):** read [Update a vendored installation](references/update.md) and follow that procedure instead of the fresh-install steps below.
- **No installation (fresh install):** follow the procedure below. If the user asked for an update but no installation exists, confirm the target before installing.
- **Oxlint-based anti-slop installed instead:** this skill does not migrate Oxlint configuration. Ask whether the user wants the Biome rules alongside it, or wants to replace it, before changing anything.

Complete when the operation and target path are established and pre-existing work is identified.

## Fresh install

1. Copy the bundled plugins from this skill. Run this from the target repository:

   ```bash
   node <skill-directory>/scripts/install.mjs
   ```

   This creates `tools/biome/anti-slop/`. Pass another relative destination as the first argument when the repository has an established tooling layout. The script refuses to replace an existing destination; route existing copies through the update procedure rather than `--force`.

   The copy contains `anti-slop.jsonc` (the generic preset), `effect/anti-slop-effect.jsonc` (the opt-in Effect preset), one plugin file per rule under `rules/` and `effect/rules/`, and shared helpers under `shared/`. If `vendor/` exists, keep its `LICENSE` and `UPSTREAM.md`; they travel with the code derived from it.

   Complete when the files exist at the agreed destination without replacing an existing copy.

2. Install compatible dependencies. Do not trust versions the agent remembers:
   - Read `COMPATIBILITY.md` in the copied directory for the Biome version the plugins were verified against.
   - If the repository already depends on `@biomejs/biome`, read the resolved version from the lockfile or package manager.
     - At or above the verified version: keep it, and install `@biomejs/runtime` at exactly that version.
     - Below the verified version, or without JavaScript plugin support: JavaScript plugins are unavailable or unverified there. Tell the user, and upgrade `@biomejs/biome` only with their agreement. Pin the upgrade exactly, and install `@biomejs/runtime` at the same version.
   - If the repository has no Biome dependency, query `npm view @biomejs/biome version` and `npm view @biomejs/runtime version`, then install the same current version of both, pinned exactly.
   - Both are development dependencies. `@biomejs/runtime` provides only the types the vendored source imports; Biome supplies the runtime itself.
   - Do not replace the package manager or rewrite unrelated dependency ranges.

   Complete when matching, exactly pinned versions are installed and unrelated dependency ranges are preserved.

3. Register the generic preset and configure ignores. Merge these fields into the repository's root Biome configuration:

   ```jsonc
   {
     "extends": ["./tools/biome/anti-slop/anti-slop.jsonc"],
     "files": {
       "includes": [
         "**",
         "!**/.agent",
         "!**/.agents",
         "!**/.claude",
         "!**/.codex",
         "!**/.continue",
         "!**/.cursor",
         "!**/.gemini",
         "!**/.opencode",
         "!**/.pi",
         "!**/.roo",
         "!**/.windsurf",
         "!tools/biome/anti-slop"
       ]
     }
   }
   ```

   - Append to an existing `extends` array rather than replacing it. Settings in the repository's own file still override the preset.
   - Merge into an existing `files.includes` while keeping every current entry. Keep a positive pattern before the exclusions. If there was no `files.includes`, the leading `"**"` preserves Biome's default of processing every file.
   - Adjust the final pattern if the plugins were copied elsewhere. Inspect the repository for other project-local agent tooling directories and add them, so installed skills, hooks, and generated agent configuration are not linted as application source. Do not broadly ignore every dot-directory, because some repositories keep owned source or checks in them.
   - In a monorepo with nested Biome configurations, register the preset in the root configuration, or in each configuration that does not inherit from the root (`"extends": "//"`).

   The generic preset enables every generic rule plus Biome's native `performance/noAccumulatingSpread`, the companion to `noReduceAccumulatorCopy`. Plugin entries cannot set a severity or options, so the vendored source holds them: severity in `shared/report.ts`, the `allowInTypeGuards` behavior of `noRuntimeTypeof` and the marker list of `requireSafetyCommentForTypeAssertion` as constants at the top of their rule files. Leave them at their defaults unless the user asks otherwise.

   For `noArrayFilterMap`, prefer lazy `.values().filter(...).map(...).toArray()` pipelines only when the target runtime supports iterator helpers; otherwise use an appropriate single `flatMap` or a locally mutating reducer. Review callback order, indexes, sparse arrays, `thisArg`, and filtering semantics rather than mechanically rewriting chains.

   Pair `noReduceAccumulatorCopy` with the native `noAccumulatingSpread`. The custom rule catches supported non-spread copies such as `Object.assign({}, acc, item)`, `Array.from(acc)`, and array accumulator `concat`/`slice` calls. Named callbacks, indirect helpers, and nested accumulator properties are not fully analyzed, so do not claim that every quadratic reducer is ruled out.

   If the repository declares `effect` in a package manifest, or the user explicitly asks for the Effect rules, also extend the opt-in Effect preset:

   ```jsonc
   "extends": [
     "./tools/biome/anti-slop/anti-slop.jsonc",
     "./tools/biome/anti-slop/effect/anti-slop-effect.jsonc"
   ]
   ```

   Do not enable the Effect preset merely because Effect appears transitively in a lockfile; require a direct package-manifest dependency or an explicit request. `noServiceConstructorImports` covers relative project imports only. Report package-alias imports as a current limitation rather than claiming they are enforced.

   Complete when the presets are registered, the ignores are merged, and existing configuration is preserved.

4. Verify the installation:
   - Run `npx biome lint` (or the repository's lint script) and confirm that diagnostics tagged `[anti-slop/<ruleName>]` can appear. A file containing `Reflect.get(a, "b")` is a quick probe; delete it afterwards.
   - Search the output for `Rule <name> errored`. Biome reports a plugin crash as an informational diagnostic instead of failing, so a crash is easy to miss. Any crash means the installed Biome version is incompatible with the vendored source; report it rather than suppressing it.
   - Run the repository's typecheck. The vendored source imports `@biomejs/runtime/plugin` and uses `.ts` import specifiers. If the application's `tsconfig` covers the vendored directory and its options reject that (for example, without `allowImportingTsExtensions`), exclude the vendored directory from the application's `tsconfig` instead of editing the vendored source.
   - If findings appear in owned project source, report them, and fix them only when the user asked for migration or cleanup. Do not suppress rules, remove plugin entries, add unsafe casts, or mechanically launder types to make lint pass.

   When cleanup is authorized, apply `requireReadableSpacing` with `npx biome check --write`, which applies its safe whitespace fix and then formats. Then lint again, and confirm that a second `biome check --write` leaves files unchanged. Keep whitespace fixes separate from semantic edits, keep documentation attached to the declarations it documents, and keep overload groups together.

   Complete when checks have run, fix/format stability has been verified for authorized cleanup, and every failure is resolved or reported with its diagnostics.

5. Record provenance in `UPSTREAM.md` beside the vendored presets. Include the source repository, the exact source commit or a recoverable pristine snapshot when available, the installed path, the Biome and `@biomejs/runtime` versions, and any intentional deviations. Verify that the revision identifies the files actually copied; a package version or the current upstream HEAD alone is insufficient. If provenance cannot be established, record it as unknown rather than guessing.

   Review the final diff. Report the installed path, the source identity, dependency and configuration changes, and check results. Complete when the record and the report describe the files actually installed and any remaining findings.
