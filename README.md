# Codepull

<p align="center">
  <img src="docs/assets/codepull-hero.png" alt="Codepull selecting a source package from a monorepo and pulling it into a local project" width="860">
</p>

Copy selected source packages from a GitHub monorepo into a project. Codepull resolves package dependencies, installs files transactionally, and records their provenance in one root-owned lockfile.

Codepull is an npm CLI for Node.js 24. Git is a runtime prerequisite.

## Quick start

In the source monorepo where you want to copy packages/files from, run this to initialize the `codepull.json` file (it will index all of your packages).

```bash
pnpx codepull init
```

Then in your other repositories, to list and download packages/files, run this:

```bash

pnpx codepull list --repo myorg/system
pnpx codepull add logger --repo myorg/system
```

> SSH is the default transport, so private repositories use your existing SSH configuration. Pass `--ssh=false` to use HTTPS.

## CLI workflows

### Make a source monorepo available

Run `init` from the root of the monorepo that owns the packages:

```bash
cd path/to/source-monorepo

# Preview the manifest, then create it
pnpx codepull init --dry-run
pnpx codepull init
```

The result is a `codepull.json` manifest at the repository root. Commit and push
that file so other projects can discover and install the packages it describes.

`init` scans `packages/*/package.json`. It turns each npm package into a
Codepull package, carries over its description, and records dependencies on
other packages in the same monorepo. External npm dependencies are not added.
Repository-level name and description metadata come from the root
`package.json` when present.

Review the generated manifest if packages need custom targets or individual
file mappings. `init` will not replace an existing `codepull.json`; use
`pnpx codepull init --force` only when you intend to regenerate it.

### Find the package you need

List everything published by a source monorepo, then inspect a package before
installing it:

```bash
pnpx codepull list --repo myorg/system
pnpx codepull info logger --repo myorg/system
```

Both commands read `codepull.json` from `main` by default. Use `--ref` to
inspect another branch, tag, or commit:

```bash
pnpx codepull info logger --repo myorg/system --ref v1.4.0
```

### Install packages in a target project

Run `add` from the root of the project that should own the installation:

```bash
cd path/to/target-project
pnpx codepull add logger prettier-config --repo myorg/system --ref v1.4.0
```

Codepull installs the requested packages and their transitive Codepull
dependencies, then creates or updates `codepull.lock` in the current directory.
Commit that lockfile to retain the exact source revision and content
provenance.

Preview an installation with `--dry-run`. In a target monorepo, use `--dir` to
install beneath a subdirectory while keeping one lockfile at the root:

```bash
pnpx codepull add web --repo myorg/system --dry-run --verbose
pnpx codepull add logger --repo myorg/system --dir apps/consumer
```

If an unmanaged destination already exists, the interactive CLI asks before
replacing it. Pass `--force` in automation, or when replacement is intentional.
A directory installation replaces the complete directory; it never merges old
and new content.

### Update installed packages

Run `update` from the directory that contains `codepull.lock`. With no package
names, it updates everything recorded in the lockfile:

```bash
pnpx codepull update
```

Limit the update to one or more packages, or disambiguate the same package name
across multiple sources:

```bash
pnpx codepull update logger
pnpx codepull update logger --repo myorg/system
```

Updates reuse the repository ref, SSH/HTTPS transport, and installation
directory recorded by `add`, so those options cannot be overridden. Codepull
checks installed content before replacing it and rejects local edits; use
`pnpx codepull update --force` only when discarding those edits is intentional.

`--repo` is required by `add`, `list`, and `info`. `--ref` defaults to `main`,
`--dir` defaults to `.`, and `--ssh` defaults to `true`. Pass `--ssh=false` to
use HTTPS. Installation directories must remain inside the directory where
Codepull is executed.

## Root lockfile and updates

Every successful `pnpx codepull add` writes `codepull.lock` in the directory
where the command was executed. This is the consumer or monorepo root, even
when `--dir` installs content into a nested project:

```text
my-monorepo/
├── codepull.lock
└── apps/
    └── consumer/
        ├── env.ts
        └── lib/logger/
```

The lockfile contains every installed file or directory mapping across all
tracked sources. For each source it records:

- the canonical repository, ref, and SSH/HTTPS transport;
- the install directory relative to the lockfile;
- direct and dependency-introduced packages;
- the exact 40-character Git commit;
- each source-to-destination mapping; and
- a canonical SHA-256 content digest.

Commit `codepull.lock` when the project should retain this provenance.
`pnpx codepull update` reads all sources and install directories from that one
file, then updates every tracked package by default. It rejects local edits
before overwriting them; use `--force` only when replacing those edits is
intentional.

Updates stop safely if an upstream package disappears or changes its mapping.
Dependencies that are no longer needed remain installed and tracked; Codepull
does not prune source code automatically.

## Manifest reference

Source repositories expose `codepull.json` at their root:

```json
{
  "name": "system",
  "description": "Shared packages",
  "packages": {
    "logger": {
      "description": "Structured logging",
      "path": "packages/logger",
      "target": "lib/logger",
      "dependencies": ["env"]
    },
    "env": {
      "path": "packages/env"
    },
    "prettier-config": {
      "files": [
        {
          "src": "configs/.prettierrc",
          "dest": ".prettierrc"
        }
      ]
    }
  }
}
```

Each package uses exactly one mode:

| Mode | Required | Optional | Meaning |
| --- | --- | --- | --- |
| Directory | `path` | `target`, `dependencies`, `description` | Copies one source directory. The target defaults to `path`. |
| File mappings | `files` | `dependencies`, `description` | Copies every `{ "src", "dest" }` mapping. |

All paths are normalized, project-relative paths with forward slashes.
Dependencies must name existing packages and cannot repeat. Unknown fields,
traversal paths, missing mappings, and dependency cycles are rejected.

## Transaction and security model

Codepull uses one shallow partial Git fetch per source operation and downloads
only requested blobs. It stages all content beside the target, pre-authorizes
every conflict before fetching, and activates all mappings as one transaction.
A failed fetch changes nothing; a failed activation or lockfile commit restores
the prior destinations.

Source manifests, tar entries, lockfiles, and destination paths are treated as
untrusted input. Codepull rejects path traversal, absolute and Windows-volume
paths, archive links and special entries, symlinked destination parents,
overlapping ownership, malformed digests, and unsafe Git refs.

## Development

```bash
corepack enable
pnpm install
pnpm check
```

`pnpm check` is read-only and runs the same formatting, lint, documentation,
and type checks used by CI. Run `pnpm check:fix` locally to apply Biome's
automatic fixes, then resolve any remaining reported issues manually.

The project uses strict TypeScript, ESM, Vitest, and Biome. CI runs the full
quality, coverage, and build suite with Node.js 24 on Linux, enforcing at least
90% statement and line coverage. It also runs the tests on Node.js 26/Linux and
Node.js 24/macOS and Windows, then smoke-tests the packed executable in every
matrix entry. Tests are colocated with their source modules; shared test-only
helpers live in `src/testing/` and are excluded from `dist`. pnpm also rejects
dependency releases newer than seven days.

## License

[MIT](LICENSE)
