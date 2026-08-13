# Local Desktop Commander Dependency Design

## Goal

Run Desktop Commander from this project's installed dependencies rather than resolving it through `bunx` every time `desktop-remote` starts.

## Scope

- Add `@wonderwhy-er/desktop-commander` as a runtime dependency with the compatible range `^0.2.47`.
- Change the default child command from `bunx` to the locally installed Desktop Commander executable.
- Preserve `--cmd` as the explicit override and forward its arguments unchanged.
- Update the usage documentation to instruct users to run `bun install` once and use the local command afterward.

## Architecture

`src/launcher.ts` chooses the process command and its arguments. Without `--cmd`, it will run the executable exposed by the local package; the default argument list becomes only the Desktop Commander remote arguments because package resolution is handled by Bun during installation. With `--cmd`, the wrapper keeps the user-provided executable and forwards only their requested arguments.

The project lockfile records the resolved compatible release. `bun install` performs Puppeteer's postinstall once when the dependency is installed or updated; normal `bun run start` executions do not resolve or install packages.

## Error Handling

If the local executable is unavailable, the spawned process reports the operating-system error instead of falling back to a network install. This makes a missing `bun install` visible and avoids unexpected runtime dependency changes.

## Testing

- Test that the default launcher is the local Desktop Commander executable with only remote arguments.
- Test that `--cmd` preserves the supplied executable and arguments.
- Run the full `bun test` suite after the change.

## Documentation

README usage will state `bun install` as the one-time setup step. The direct and pipe examples will use the local binary instead of `bunx`.
