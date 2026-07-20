# EasyCris PyDESeq2 0.5.3 Patch

These files are derived from PyDESeq2 0.5.3 and retain its MIT license in
`LICENSE`. The EasyCris changes reproduce the RNA-seq implementation validated
against the application's R baselines, including local dispersion/VST fitting
and lazy matplotlib loading.

`scripts/apply_rnaseq_pydeseq2_patch.py` applies the files only when the target
matches the expected stock PyDESeq2 0.5.3 source hashes. Do not edit the
vendored files without rerunning both RNA E2E tests and the 19-model comparator.
