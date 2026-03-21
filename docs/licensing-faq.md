# Licensing FAQ

## What license is easyCris released under?

easyCris uses a dual-license model:

1. `AGPL-3.0-only` for open-source usage and redistribution.
2. A separate commercial license for teams that cannot use AGPL terms.

## Do I need to open-source my modifications?

Under AGPL, if you distribute or provide network access to a modified version, you must provide corresponding source under AGPL terms.

## Can my organization purchase a commercial license?

Yes. Contact `hello@easycris.com`.

## Are official binaries and source builds the same?

No. Official release binaries are the recommended path for end users. Source builds are primarily for development and contribution workflows.

## Where are the governing license files?

- `LICENSE` (AGPL-3.0-only)
- `COMMERCIAL_LICENSE.md`
- `CLA.md`

## How is third-party license compliance enforced?

The public lane uses repo-local license manifests and CI checks. Run `npm run -s license:summary:check` to verify `THIRD_PARTY_LICENSES` artifacts are synchronized and policy-compliant.
