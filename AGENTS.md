# Project Instructions

## Development

- Use `bun install` to install dependencies.
- Use `bun run compile` for a quick local compile check.
- Use `bun test` when changing behavior covered by tests.
- Before development is considered complete, always run `bun run package`.

`bun run package` is the required final packaging/verification step. It runs
type checking, linting, and TypeScript compilation, and should pass before work
is handed off.

## Local Packaging

To produce a local VS Code extension package, run:

```bash
bun run vsix
```

This runs the package step first, then creates the `.vsix` artifact.

Before creating a local `.vsix`, check whether an `opencode-remote-*.vsix`
artifact already exists in the repository root. If a packaged `.vsix` already
exists locally, increment the patch version in `package.json` by 1 before
running `bun run vsix`, so the newly generated package has a fresh version
number.

After completing any bug fix or behavior change that should be tested in VS
Code, create a fresh local extension package before handing off the work. Follow
the same versioning rule above: if an `opencode-remote-*.vsix` already exists,
increment the patch version first, then run `bun run vsix` and report the new
`.vsix` filename.
