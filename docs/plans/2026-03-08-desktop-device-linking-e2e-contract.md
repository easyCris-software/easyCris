# Desktop Device Linking E2E Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic Tauri-side end-to-end proof for desktop device linking, covering first-launch linking, Preferences > Account linking, restart persistence, and guest fallback after revoke/sign-out, without changing `easycris_web`.

**Architecture:** Keep `easycris_web` as the unchanged auth/device control plane. Add a narrow device-linking contract lane in the Tauri repo that uses Selenium for the desktop window, minimal e2e-only observability hooks for auth cleanup/state inspection, and a deterministic backend approval helper that speaks to the existing web-side contract without importing the web repo's Playwright fixtures.

**Tech Stack:** Tauri + React + Zustand + native Rust commands, Selenium WebDriver (`@tauri-e2e/selenium`), existing Tauri E2E shim, Node helper scripts, Supabase service-role test helper patterns, Vitest for unit/contract helpers.

---

## Scope and Assumptions

### In scope

- Prove the real desktop-linking handshake from the Tauri repo.
- Cover both user entry points:
  - first-launch `Link this device`
  - Preferences > Account `Link this device`
- Cover known fragile state:
  - pairing code appears reliably
  - approval resolves polling
  - linked state persists after restart
  - revoke/sign-out returns to guest/invalid correctly
- Add minimal e2e-only auth cleanup/inspection hooks needed to keep tests deterministic.

### Out of scope

- No changes to `C:\Users\RajLord_new\Desktop\easycris_web`.
- No rewrite of desktop auth architecture before E2E exposes a concrete failure.
- No attempt to import Playwright fixtures or storage state from the web repo.
- No full browser-driven `/auth/device` UI smoke in the first pass.

### Key design decision

The first proof should use a deterministic approval helper in the Tauri repo, not a copied web Playwright login flow and not a direct anonymous call to `/api/desktop-auth/approve`.

Reason:

- `/api/desktop-auth/approve` requires a signed-in web user.
- The Tauri repo needs proof of the desktop-to-web contract, not duplication of web browser-auth coverage.
- A deterministic helper can validate the contract faster and with less cross-repo brittleness.

---

## Existing Context to Reuse

### Tauri runtime and UI

- `src/components/dialogs/DeviceLinkDialog.tsx`
- `src/components/preferences/panes/AccountPane.tsx`
- `src/components/onboarding/WelcomeScreen.tsx`
- `src/services/deviceAuthService.ts`
- `src/services/deviceAuthRuntime.ts`
- `src/services/deviceAuthStorage.ts`
- `src/store/deviceAuthStore.ts`
- `src/App.tsx`

### Existing Tauri tests worth preserving/expanding conceptually

- `src/components/dialogs/DeviceLinkDialog.test.tsx`
- `src/components/preferences/panes/AccountPane.test.tsx`
- `src/services/__tests__/deviceAuthService.test.ts`
- `src/services/__tests__/deviceAuthRuntime.test.ts`
- `src/store/deviceAuthStore.test.ts`
- `src/components/onboarding/WelcomeScreen.test.tsx`

### Existing Tauri E2E infrastructure

- `e2e/README.md`
- `e2e/utils/selenium-setup.mjs`
- `src/utils/e2eMode.ts`
- current `window.__E2E__` shim and cleanup model

### Web-side contract references only

- `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\start\route.ts`
- `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\poll\route.ts`
- `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\approve\route.ts`
- `C:\Users\RajLord_new\Desktop\easycris_web\app\auth\device\device-auth-client.tsx`
- `C:\Users\RajLord_new\Desktop\easycris_web\tests\README.md`
- `C:\Users\RajLord_new\Desktop\easycris_web\_documentation\e2e\e2e-workflow.md`

---

## Desired Test Matrix

### Contract scenarios required in this plan

1. First-launch link flow succeeds.
2. Preferences > Account link flow succeeds.
3. Linked state survives app restart.
4. Desktop sign-out/revoke returns to guest.
5. Invalid or revoked session falls back cleanly on refresh/startup.

### Failure states to cover if time permits after the core lane

1. Expired code.
2. Denied code.
3. Polling timeout/expired approval.
4. Known “Loading…” bug on the link dialog where the code never appears.

---

## Task 1: Create Deterministic Device-Linking E2E Test Architecture

**Files:**
- Create: `C:\Users\RajLord_new\Desktop\tauri\e2e\features\auth\device-linking.test.mjs`
- Create: `C:\Users\RajLord_new\Desktop\tauri\e2e\utils\device-auth-workflow.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\e2e\utils\selenium-setup.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\e2e\README.md`

**Intent:**
Add one focused Selenium contract suite instead of spreading auth-link checks across unrelated smoke/spec files.

**Step 1: Write the failing E2E shell**

Add a new file that describes the desired contract tests and initially fails because the helper functions do not exist yet:

- `first-launch link flow links the desktop`
- `preferences account link flow links the desktop`
- `linked state persists after restart`
- `desktop sign-out returns to guest`

**Step 2: Run only the new suite to confirm it fails for missing helpers**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

Expected:
- test harness finds the new file
- fails due to missing workflow/helper functions or missing state hooks

**Step 3: Add a dedicated workflow helper module**

Create `e2e/utils/device-auth-workflow.mjs` with functions for:

- open first-launch link flow
- open preferences account link flow
- wait for pairing code to appear
- read displayed `userCode`
- wait for linked state in desktop UI
- assert guest state in desktop UI
- relaunch app session in a controlled way
- relaunch app while explicitly preserving auth state for the persistence test only

**Step 4: Re-run the new suite and confirm the next real failure is contract-related**

Run the same command again.

Expected:
- no missing-helper failure
- tests now fail on missing auth cleanup/approval capability

**Step 5: Commit**

```powershell
git add e2e/features/auth/device-linking.test.mjs e2e/utils/device-auth-workflow.mjs
git commit -m "test: scaffold desktop device-linking contract lane"
```

---

## Task 2: Add Minimal E2E-Only Auth Cleanup and Inspection Hooks

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\src\utils\e2eMode.ts`
- Modify: Tauri E2E shim file that currently exposes `window.__E2E__`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\e2e\utils\selenium-setup.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src/services/deviceAuthStorage.ts`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src/store/deviceAuthStore.ts`
- Test: `C:\Users\RajLord_new\Desktop\tauri\src\utils\__tests__\e2eAuthHooks.test.ts`

**Intent:**
Current E2E reset is dataset-focused. Device-linking tests need deterministic auth cleanup and state inspection.

**Step 1: Write failing tests for auth cleanup/inspection**

Add or expand a shim-focused test to require these E2E-only capabilities:

- clear desktop auth session/token
- clear stored fingerprint if requested
- reset `hasSeenWelcome`
- read current auth mode/session summary

**Step 2: Implement minimal shim APIs**

Expose e2e-only helpers such as:

- `window.__E2E__.clearDeviceAuthState()`
- `window.__E2E__.getDeviceAuthSnapshot()`
- `window.__E2E__.setFirstLaunchState(true|false)`

Constraints:

- E2E mode only
- no production exposure
- no broad mutation surface beyond test determinism needs

**Step 2a: Add explicit runner semantics for auth reset**

Add one of these to the Selenium harness before writing the restart-persistence test:

- `setupTest({ skipAuthReset: true })`
- `cleanupTest({ skipAuthReset: true })`
- or a dedicated `relaunchPreservingAuthState()` helper in `e2e/utils/device-auth-workflow.mjs`

Constraint:

- full dataset/auth reset remains the default between tests
- auth preservation is allowed only inside the restart-persistence scenario

**Step 3: Wire `selenium-setup.mjs` reset to call the new auth cleanup hooks**

Update reset flow so auth-link tests start from known state, not only clean datasets.

**Step 4: Re-run shim/reset tests**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
npm run test:run -- src/utils/__tests__/e2eAuthHooks.test.ts
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

Expected:
- auth cleanup hooks exist
- device-linking suite now advances to approval/polling failure instead of stale-state flake

**Step 5: Commit**

```powershell
git add src e2e/utils/selenium-setup.mjs
git commit -m "test: add e2e auth cleanup hooks for device linking"
```

---

## Task 3: Add a Deterministic Approval Helper That Uses Proper Authority

**Files:**
- Create: `C:\Users\RajLord_new\Desktop\tauri\e2e\utils\device-approval-helper.mjs`
- Create: `C:\Users\RajLord_new\Desktop\tauri\src\services\__tests__\deviceApprovalHelper.test.ts`
- Reference: `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\approve\route.ts`
- Reference: `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\start\route.ts`
- Reference: `C:\Users\RajLord_new\Desktop\easycris_web\app\api\desktop-auth\poll\route.ts`
- Reference pattern only: `C:\Users\RajLord_new\Desktop\easycris_web\tests\e2e\helpers\test-user-provisioning.ts`
- Reference pattern only: `C:\Users\RajLord_new\Desktop\easycris_web\tests\e2e\helpers\trusted-device.ts`

**Intent:**
Approve a desktop `userCode` deterministically from the Tauri repo without importing web Playwright fixtures and without adding web-repo code.

**Recommended first implementation:**
Use a service-authorized helper that reproduces the same approval semantics against the same backend data model/RPC layer the web route uses.

**Explicit non-goal:**
Do not try to call `/api/desktop-auth/approve` anonymously. It requires a signed-in web user.

**Exact contract guardrail:**
The helper must use the same request-selection semantics and the same `easycris_approve_auth_request` RPC path that the web route relies on. It must not handcraft approval by mutating `desktop_auth_requests` or related tables directly.

**Step 1: Write failing helper tests**

Add explicit Vitest coverage in `src/services/__tests__/deviceApprovalHelper.test.ts` for:

- missing env fails loudly
- helper can find a seeded auth user
- helper can resolve a pending `userCode`
- helper can mark a request approved through the same backend contract layer

**Step 2: Implement helper inputs**

Use envs such as:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TEST_USER_EMAIL`
- `TEST_USER_PASSWORD` if needed for provisioning
- optional `VITE_EASYCRIS_WEB_URL`

**Step 3: Implement helper operations**

The helper should:

1. find or provision the test user
2. find the newest pending `desktop_auth_requests` row by `user_code`
3. approve it using the same request lookup semantics and `easycris_approve_auth_request` RPC path that the web route ultimately relies on
4. return enough diagnostics for the test if approval fails

**Step 4: Keep helper scope narrow**

The helper is only for Tauri device-linking E2E.
It should not become a generic auth utility library.

Document this explicitly in the helper and test file header:

- this proves the backend approval contract used by desktop polling
- it does not replace web-route auth/rate-limit/UI coverage that belongs to `easycris_web`

**Step 5: Re-run helper tests**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
npm run test:run -- src/services/__tests__/deviceApprovalHelper.test.ts
```

Expected:
- helper passes env/approval tests

**Step 6: Commit**

```powershell
git add e2e/utils/device-approval-helper.mjs src/services/__tests__/deviceApprovalHelper.test.ts
git commit -m "test: add deterministic desktop approval helper"
```

---

## Task 4: Cover First-Launch `Link this device`

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\e2e\features\auth\device-linking.test.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src\components\onboarding\WelcomeScreen.tsx`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src\components\layout\AppShell.tsx`

**Intent:**
Prove the onboarding trigger actually works, since this is one of the product entry points you called out.

**Step 1: Write the failing first-launch test**

Test shape:

1. launch app in clean state with welcome visible
2. click `Link this device`
3. confirm dialog opens
4. wait for real `userCode` to appear instead of infinite `Loading...`
5. use deterministic helper to approve the code
6. wait for dialog to show success / linked state

**Step 2: Run only this test and confirm the current bug shape**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

Expected:
- fail either because code never appears or desktop never transitions to linked

**Step 3: Fix only what this test proves**

Likely touchpoints if it fails:

- `src/components/dialogs/DeviceLinkDialog.tsx`
- `src/services/deviceAuthService.ts`
- `src/store/deviceAuthStore.ts`

No speculative rewrites.

**Step 4: Re-run until it passes**

Expected:
- onboarding link path becomes deterministic

**Step 5: Commit**

```powershell
git add e2e/ src/components/dialogs src/services src/store
git commit -m "fix: stabilize first-launch desktop linking"
```

---

## Task 5: Cover Preferences > Account `Link this device`

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\e2e\features\auth\device-linking.test.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src\components\preferences\panes\AccountPane.tsx`

**Intent:**
Prove the Preferences trigger works too, especially because the current button is described as buggy.

**Step 1: Write the failing Preferences flow test**

Test shape:

1. start from guest state with welcome dismissed
2. open Preferences > Account
3. click `Link this device`
4. assert pairing dialog opens
5. assert code appears
6. approve via helper
7. assert linked state is shown in Account pane

**Step 2: Run this test in isolation**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

Expected:
- fail on the currently buggy behavior

**Step 3: Fix only this path’s concrete failure**

Likely areas:

- button handler in `AccountPane.tsx`
- store/dialog state transitions
- stale link-dialog state across flows

**Step 4: Re-run until it passes**

**Step 5: Commit**

```powershell
git add e2e/ src/components/preferences src/components/dialogs src/store
git commit -m "fix: stabilize account-pane desktop linking"
```

---

## Task 6: Cover Restart Persistence

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\e2e\features\auth\device-linking.test.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src/services/deviceAuthRuntime.ts`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src/services/deviceAuthStorage.ts`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src\App.tsx`

**Intent:**
Prove the stored desktop session survives restart and restores linked mode.

**Important harness note:**
This task cannot use the default full reset path between the two launches. It must use the auth-preserving relaunch primitive added in Task 2 so stored session state survives while keeping the rest of the runner deterministic.

**Step 1: Write the failing restart test**

Test shape:

1. complete a link flow
2. quit the app/session without calling auth reset
3. relaunch app with stored auth preserved
4. wait for bootstrap
5. assert linked state is restored in UI

Recommended helper contract:

- `relaunchPreservingAuthState()`
  - quits the current WebDriver/app process
  - does not call `clearDeviceAuthState()`
  - relaunches with the same user-data/auth state intact
- default setup/cleanup for every other test still performs full reset

**Step 2: Run just this test**

Expected:
- fail if storage, bootstrap, or validation does not restore correctly

**Step 3: Fix only restart persistence issues**

Likely areas:

- `deviceAuthStorage.ts`
- `deviceAuthRuntime.ts`
- startup bootstrap in `App.tsx`

**Step 4: Re-run until it passes**

**Step 5: Commit**

```powershell
git add e2e/ src/services src/App.tsx
git commit -m "fix: restore linked desktop auth on restart"
```

---

## Task 7: Cover Desktop Sign-Out / Revoke Fallback

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\e2e\features\auth\device-linking.test.mjs`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src\components\preferences\panes\AccountPane.tsx`
- Reference: `C:\Users\RajLord_new\Desktop\tauri\src/services/deviceAuthRuntime.ts`

**Intent:**
Prove the desktop can leave linked mode safely.

**Step 1: Write the failing sign-out/revoke fallback test**

Recommended first version:

1. start from linked desktop state
2. trigger desktop `Sign out this device`
3. assert guest mode in UI
4. optionally relaunch and confirm guest remains

Optional second version:

1. revoke server-side via deterministic helper
2. trigger refresh/startup validation
3. assert invalid/guest fallback

**Step 2: Run the test**

Expected:
- fail on missing state cleanup or stale linked UI

**Step 3: Fix only the proven fallback issue**

Likely areas:

- `AccountPane.tsx`
- `deviceAuthRuntime.ts`
- `deviceAuthStorage.ts`

**Step 4: Re-run until it passes**

**Step 5: Commit**

```powershell
git add e2e/ src/components/preferences src/services
git commit -m "fix: return desktop auth to guest on revoke"
```

---

## Task 8: Add Documentation and Test Running Rules

**Files:**
- Modify: `C:\Users\RajLord_new\Desktop\tauri\e2e\README.md`
- Modify: `C:\Users\RajLord_new\Desktop\tauri\docs\plans\2026-03-07-desktop-device-linking-reference.md`

**Intent:**
Make the new lane runnable and maintainable.

**Step 1: Document required env**

Include:

- web base URL
- service-role/test-user envs
- app binary path for e2e mode
- whether the helper provisions/assumes user state

**Step 2: Document cleanup expectations**

Spell out:

- auth cleanup hooks are mandatory for device-link E2E determinism
- disposable auth state must be cleaned between tests

**Step 3: Document what this lane proves and what it does not**

It proves desktop-to-web contract correctness.
It does not prove the browser approval page UX unless a later browser smoke is added.

**Step 4: Run docs-aware verification**

Run:

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
npm run lint
npm run typecheck
npm run test:run
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

**Step 5: Commit**

```powershell
git add e2e/README.md docs/plans/2026-03-07-desktop-device-linking-reference.md
git commit -m "docs: document desktop device-linking e2e lane"
```

---

## Verification Matrix

### Minimum per-task verification

- relevant Vitest file
- affected Selenium device-linking test(s)
- `npm run lint`
- `npm run typecheck`

### Full lane verification before merge

```powershell
cd C:\Users\RajLord_new\Desktop\tauri
npm run lint
npm run typecheck
npm run test:run
node e2e/run-tests.mjs features/auth --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe
```

### Optional deeper verification after the contract lane is green

- relaunch persistence test in isolation
- revoke fallback test in isolation
- release-mode smoke to ensure no e2e-only auth hooks leak into release binaries

---

## Risks and Guardrails

1. **Do not add cross-repo fixture imports.**
   Keep Tauri tests independent from `easycris_web` internal file paths.

2. **Do not add broad test-only auth powers to production code.**
   Any new inspection/cleanup hook must be e2e-mode only.

3. **Do not rewrite the device-link runtime before a failing test proves the need.**

4. **Do not let the helper become a second auth system.**
   It exists only to approve deterministic test device requests.

5. **Keep disposable test artifacts cleaned.**
   Follow the same cleanup discipline used in the web repo for disposable auth data.

---

## Expected Outcome

When this plan is complete, the Tauri repo will have a narrow but trustworthy device-linking E2E lane that proves:

- first-launch linking works
- Preferences linking works
- the buggy link flow is either fixed or precisely localized by failing tests
- linked state persists across restart
- guest fallback works after sign-out/revoke

without changing the stable web repo and without coupling Tauri Selenium to web Playwright fixtures.

---

Plan complete and saved to `docs/plans/2026-03-08-desktop-device-linking-e2e-contract.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

npm run -s e2e:prepare:e2e-binary

build e2e binary
