# Tauri Command Permissions and Build Profiles

This note documents a startup failure mode that is easy to reintroduce when adding new Tauri commands or local build profiles.

## Command Permission Rule

Tauri v2 has two separate command gates in this app:

1. `src-tauri/isolation/index.html`
   - `ALLOWED_CUSTOM_COMMANDS` is the renderer isolation allowlist.
   - If a command is missing here, the isolated renderer rejects the invoke before it reaches Tauri.

2. `src-tauri/permissions/*.toml` plus `src-tauri/capabilities/default.json`
   - These are Tauri's runtime command permissions.
   - If a custom command is registered in Rust and allowed by isolation, but missing from a permission TOML referenced by `default.json`, the frontend can render while startup invokes fail with `not allowed. Command not found`.

The app command permission surface lives in:

- `src-tauri/permissions/app-commands.toml`
- referenced by `"app-commands"` in `src-tauri/capabilities/default.json`

Remote-session commands are included in `app-commands.toml`. Keep one app command permission file so command lists cannot drift across multiple TOML files.

`execute_python_script` is a deliberate debug-only exception: Rust registers it behind `#[cfg(debug_assertions)]`, and the frontend wrapper rejects it outside `import.meta.env.DEV`. It remains in `app-commands.toml` so dev builds can use it.

## Required Check

Run this after adding, renaming, or removing any frontend `invoke(...)` call or Rust Tauri command:

```powershell
npm run -s isolation:allowlist:check
```

That check enforces:

- every frontend `invoke()` command is present in the isolation allowlist
- `default.json` references `app-commands`
- every isolation-allowed command is present in `app-commands.toml`
- every Rust `generate_handler![]` command is present in both the isolation allowlist and `app-commands.toml`

This is intentionally stricter than Tauri itself, because the broken state is otherwise easy to miss: the window opens, React renders, but startup commands are denied before Rust receives them.

## Dev, E2E, and Release Profiles

Dev, E2E, and release builds must not share the same app identity or DuckDB cache directory.

Current identities:

- release: `com.easycris.app`
- dev: `com.easycris.app.dev`
- e2e: `com.easycris.app.e2e`

Current DuckDB cache roots:

- release: `%LOCALAPPDATA%\easyCris\duckdb_cache`
- dev: `%LOCALAPPDATA%\easyCris-dev\duckdb_cache`
- e2e: `%LOCALAPPDATA%\easyCris-e2e\duckdb_cache`

Why this matters:

- `tauri-plugin-single-instance` keys off the app identity. If dev and release share an identifier, one process can steal focus from the other and make the new run appear partially started.
- DuckDB files are single-writer. If dev, E2E, and release share cache files, stale locks or cross-run writes can corrupt diagnosis and user data.

Use the npm wrappers rather than invoking Tauri directly:

```powershell
npm run tauri dev
npm run tauri:build:e2e
```

Direct `npx tauri dev` bypasses the dev config overlay and can restore the production identifier.
