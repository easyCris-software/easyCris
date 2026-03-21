# E2E Test Enablement

E2E helpers are enabled by **build mode**, not by `VITE_E2E_ENABLED`.

- `production` mode: no E2E shim bundled
- `e2e` mode: E2E shim bundled (`window.__E2E__` available)

## Recommended Selenium flow

Build the E2E binary:

```bash
npm run tauri:build:e2e
```

Then run tests:

```bash
npm run e2e:r-validation
```

or:

```bash
npm run e2e:smoke:e2e
```

Release smoke (shim-free contract):

```bash
npm run e2e:smoke:release
```

`e2e:r-validation` and `e2e:smoke:e2e` now build the E2E binary first and pass a deterministic app path automatically (`src-tauri/target/e2e/release/easycris.exe`).

Optionally override app binary path manually (PowerShell):

```powershell
$env:E2E_APP_PATH="C:\Users\RajLord_new\Desktop\tauri\src-tauri\target\e2e\release\easycris.exe"
```

## Frontend-only dev check

```bash
npm run dev -- --mode e2e
```

Use this only for local dev verification, not Selenium binary runs.
