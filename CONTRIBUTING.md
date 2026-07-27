# Contributing

Use Node.js 24 and pnpm 11. Maintainers land focused commits directly on
`main`. Before pushing, run:

```bash
corepack enable
pnpm install
pnpm check
```

Keep changes focused and add tests for behavior changes. Biome owns formatting
and linting; TypeScript is checked with all strict compiler options enabled.
Place each `*.test.ts` beside the source module it exercises. Shared test-only
infrastructure belongs in `src/testing/` and is excluded from production builds.
Document exported declarations and meaningful internal helpers with concise
JSDoc. Prefer describing behavior and invariants over repeating TypeScript types;
use tags such as `@example` only when they add information.
pnpm rejects dependency versions published less than seven days ago; do not add
release-age exclusions without a documented security or compatibility reason.

Git is required for integration tests because Codepull deliberately uses the
system Git client for partial fetches and archive extraction.

Write concise commit subjects that explain the user-visible change. GitHub
Release notes are generated from the commits since the previous release, so
keep unrelated work in separate commits. Do not add Changesets or maintain a
manual changelog; the Release workflow derives the next version from the
selected patch, minor, or major increment.
