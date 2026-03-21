# Desktop Device Linking Reference

**Date:** 2026-03-07

This repo implements the desktop side of the approved cross-repo device-linking design.

Primary design source:
- `C:\Users\RajLord_new\Desktop\easycris_web\docs\plans\2026-03-07-desktop-device-linking-design.md`

Implementation plan source:
- `C:\Users\RajLord_new\Desktop\easycris_web\docs\plans\2026-03-07-desktop-device-linking.md`

## Decision Summary

1. The web repo remains the single account, entitlement, revoke, and device-management control plane.
2. The Tauri app remains local-first and guest-first.
3. Desktop sign-in is optional.
4. The first-launch CTA order is:
   - `Link this device`
   - `Continue as guest`
5. The desktop app uses the web repo's existing device-code flow instead of direct OAuth.
6. The installed desktop app, not the browser, becomes the linked device record for a user.
7. Desktop-to-web auth calls run through native Tauri commands backed by Rust `reqwest`; raw WebView fetch is not used for the linked-device auth flow.
8. Desktop self-sign-out must use a real backend revoke contract rather than only clearing local state.
9. The desktop session token belongs in native secure storage; only the fingerprint and non-sensitive metadata stay in app-local persistence.
10. Linked email remains nullable in the desktop UI even though the web validation contract can now return it.

## Tauri Scope

This repo is responsible for:

- starting a desktop linking request
- showing the approval code
- opening the web approval page
- polling for approval
- storing a desktop session token in native secure storage
- validating and refreshing that token on startup/heartbeat
- falling back to guest mode if the linked device is revoked or invalid
- exposing guest/linked account state in onboarding and preferences
