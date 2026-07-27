# Codepull

Codepull is a Node.js 24 CLI that copies selected source packages from a GitHub
monorepo into another project. It resolves package dependencies, installs files
transactionally, and records provenance in a root-owned lockfile.

## Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/)
format:

```text
<type>[optional scope]: <description>
```

Use an appropriate prefix such as `feat`, `fix`, `docs`, `test`, `refactor`,
`perf`, `build`, `ci`, or `chore`. Keep the description concise and imperative.
