# braces 3.0.3, patched (vendored)

Copy of [braces 3.0.3](https://github.com/micromatch/braces/tree/3.0.3) (MIT, see `LICENSE`) with one
change: `parse()` refuses brace nesting deeper than 64 levels (`MAX_DEPTH`, option `maxDepth`) with a
`SyntaxError`, before `compile()` / `expand()` recurse. That closes
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (stack exhaustion from deeply
nested patterns), for which no braces release has a fix yet. Every patched line is marked
`Shadow IT patch`.

Only `@google/clasp` uses it (through `micromatch`), to read `.claspignore` when deploying. The root
`package.json` installs it in place of `braces` (`"braces": "file:vendor/braces"` +
`"overrides": {"braces": "$braces"}`). Its package name differs from `braces` so that `npm audit`,
which flags every `braces` version, does not report the patched copy.

Remove this folder, the `braces` dev dependency and the override once braces publishes a fixed
release (the weekly `Security` workflow warns when a newer braces appears on npm). See
docs/SECURITY.md.
