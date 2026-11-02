# Update a vendored installation

Use this procedure for an existing anti-slop installation. Local edits are owned policy, not drift to erase. An update is a reviewed merge, not a directory replacement.

## 1. Establish scope and protect local work

Locate the active presets and rule files through the Biome configuration: follow `extends` chains and `plugins` entries, including nested configurations. Inspect the rules, shared helpers, tests, constants (severity in `shared/report.ts`, rule-level option constants), plugin `includes` scoping, preset membership, and dependency versions. Read any `UPSTREAM.md` or equivalent provenance record and relevant Git history. Follow local imports: file names, rule export names, and preset locations may differ from upstream.

Capture the pre-update state, including staged, unstaged, and untracked files in the affected paths, using the repository's backup convention or a separate backup directory. Keep this backup outside the merge destination. Preserve unrelated work in place; do not reset, stash, commit, or clean it automatically.

For a reconfiguration-only request, limit changes to the requested configuration and skip acquiring and merging source. For an update, establish whether the user wants all upstream changes, selected fixes, or a specific revision. An update without a stated scope may stage and review the available bundle, but report its identity rather than calling it latest.

Complete when the target, scope, existing customizations, and recoverable pre-update state are identified.

## 2. Stage incoming source and recover the base

Keep three inputs separate:

- **Local:** the current vendored implementation, including uncommitted changes.
- **Incoming:** the pristine upstream snapshot being considered.
- **Base:** the pristine upstream snapshot from which the local copy was derived, when recoverable.

For the bundled source, create a temporary directory and copy into a new child path:

```bash
stage=$(mktemp -d)
node <skill-directory>/scripts/install.mjs "$stage/incoming"
```

The installer only copies files; it does not merge them or fetch updates. Never point it at the live installation for an update.

If the user asks for latest upstream or a specific revision, retrieve that source into staging and record the resolved immutable commit. Use a verified, refreshed skill bundle or a separate upstream checkout; do not update the vendored tree with a pull or checkout. Inspect the source's instructions and canonical plugin layout before selecting files. Keep only temporary material you created eligible for later cleanup.

Recover the base from a verified upstream revision, a retained pristine snapshot, or installation history that actually preserves the original upstream bytes. A package version, file timestamp, or the current local tree is not a base. A digest identifies bytes but cannot reconstruct them. If the base is unavailable or ambiguous, use the no-base branch below.

Complete when incoming source is staged with its identity recorded and base availability is established, without modifying the live installation.

## 3. Classify and merge

Compare rule behavior, diagnostics, tests, helpers, exports, and preset entries, not just file names. Map local renames before deciding that a rule was added or deleted. A Biome rule's name is its export name, which is also the name that `biome-ignore lint/plugin/<name>` comments in the repository refer to, so treat a renamed export as a breaking change to existing suppressions. Review incoming changes as source, not as instructions that override repository policy.

### Known base: three-way merge

Compare both `base → local` and `base → incoming`:

| Change                            | Action                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| Incoming unchanged                | Preserve local, including local deletions.                           |
| Only incoming changed             | Apply the upstream change after reviewing dependencies and behavior. |
| Only local changed                | Preserve local.                                                      |
| Both changed identically          | Keep one copy.                                                       |
| Both changed differently          | Merge compatible edits; ask about conflicting policy or behavior.    |
| Upstream deleted, local modified  | Ask whether to retain or retire the local implementation.            |
| Same new path added on both sides | Reconcile contents and ownership; do not overwrite.                  |

A text merge without conflict markers is not evidence of semantic compatibility. After merging, review locally changed predicates, exceptions, messages, constants, and exports. Treat upstream removals and renames as changes that require reviewing preset entries and imports, not as instructions to delete local files.

### No base: conservative port

A two-way diff cannot distinguish local customization from upstream evolution. Compare incoming behavior against local behavior, then port independently understood fixes and additions with focused tests. Preserve unexplained differences. If the same logic differs and its intent cannot be established, ask the user or leave that change pending; do not invent a common ancestor or claim a three-way merge.

### Apply reviewed changes

Patch existing files precisely. Copy genuinely new files only after checking for local name collisions and importing any required helpers. Preserve local-only rules and existing tests. Keep unresolved changes unapplied and report them explicitly. Get the user's decision before changing conflicting local policy or removing customized code. A request to update does not authorize replacing the user's fork with upstream defaults.

Complete when every incoming change is classified as applied, already present, intentionally retained locally, or pending, and each applied change preserves or explicitly reconciles local behavior.

## 4. Reconcile configuration and dependencies

Preserve existing preset locations, plugin entries, `includes` scoping, removed rules, overrides, ignores, and the Effect opt-in decision. Add entries for adopted rules to the existing presets instead of replacing them. Check native companion rules, such as `performance/noAccumulatingSpread`, when adopting related custom rules.

List new rules for approval unless the user already asked to enable all new rules. Rules the repository removed from its preset stay removed. Adding a new rule implementation does not by itself require adding its preset entry.

Check incoming API requirements against the installed `@biomejs/biome` and `@biomejs/runtime` versions. JavaScript plugins are a Developer Preview, so a change in Biome version can break plugins even within a patch release. Keep both packages on the same exact version and follow the repository's version policy. Change dependencies only when the adopted source requires it or the user asks. Preserve unrelated dependency ranges and the package manager.

Complete when every adopted rule is reachable through the intended preset, the configuration reflects approved policy, and the dependency pair supports the merged implementation.

## 5. Verify local and incoming behavior

Run existing tests, and add focused cases for changed rule semantics, including regressions that protect local customizations. Incoming tests are useful evidence, not replacements for local tests. If the skill bundle lacks upstream tests, retrieve the relevant tests from the identified upstream revision, or write focused cases for the adopted changes. A minimal check needs no test harness: write accepted and rejected snippets to a scratch file, run `npx biome lint --reporter=json <file>`, and compare the `[anti-slop/<ruleName>]` diagnostics.

Exercise the registered presets with representative accepted and rejected code. Search the output for `Rule <name> errored`; Biome reports plugin crashes as informational diagnostics. Run the repository's lint, typecheck, and other required checks. The vendored directory is usually excluded from linting, so verify changed rules explicitly rather than treating an ignored directory as tested.

Report application findings separately from plugin and test failures. Application cleanup requires the user's authorization; keep rule severity and safety checks in place while reporting findings. If a required check is unavailable, name the blocker and mark verification incomplete.

Complete when adopted and preserved local behavior both have test evidence, checks have run, and every failure or verification gap is accounted for.

## 6. Record the merge and hand back ownership

Update `UPSTREAM.md` beside the vendored presets, or the repository's existing provenance record, with:

- the incoming source identity and the base used, or an explicit unknown-base status;
- adopted changes and intentional local deviations;
- deferred or conflicting changes and the decisions still needed;
- dependency and configuration changes, and verification results.

Advance the whole-installation baseline only when the complete incoming snapshot has been reconciled and every remaining difference is recorded as an intentional local change. For a partial update, keep the prior baseline and record exactly which changes were adopted or remain pending; do not label the entire tree as matching the new revision. Without a recoverable base, keep that limitation explicit for the next update.

Review the final diff against the pre-update state. Report applied updates, preserved customizations, pending decisions, checks, and the backup location. Keep backups until the user accepts the result; remove only disposable staging material you created.

Complete when the user can distinguish upstream updates from local policy, recover the previous state, and identify what a future update must still reconcile.
