# Compatibility

These plugins were verified against:

- `@biomejs/biome` 2.6.4
- `@biomejs/runtime` 2.6.4 (type declarations for `@biomejs/runtime/plugin`)

Biome's JavaScript plugin API is a Developer Preview and can change in patch
releases. Keep both packages on the same exact version. After changing that
version, lint a file that should trigger each enabled rule, and look for
`Rule <name> errored` diagnostics, which is how Biome reports a plugin crash.
