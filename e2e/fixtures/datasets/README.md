# E2E Fixture Datasets Directory

This directory contains `.ecp` fixture bundles for E2E testing.

## Directory Structure

```
datasets/
└── Group1_Hypothesis_Testing/    # All fixtures (prevents data bleed)
    ├── anova_two_way/
    │   ├── anova_two_way.ecp
    │   └── anova_two_way_data/
    ├── anova_one_way/
    ├── t_test_two_sample/
    ├── t_test_paired/
    ├── t_test_one_sample/
    ├── mann_whitney/
    ├── wilcoxon_signed_rank/
    ├── kruskal_wallis/
    ├── scheirer_ray_hare/
    ├── multifactorial_anova/
    └── large_50k_rows/            # Performance/memory test fixture (50k rows)
        ├── large_50k_rows.ecp
        └── large_50k_rows_data/
```

## What Goes Here

**11 fixtures total** (created manually using easyCris UI):

1. Group1_Hypothesis_Testing/anova_two_way/
2. Group1_Hypothesis_Testing/anova_one_way/
3. Group1_Hypothesis_Testing/t_test_two_sample/
4. Group1_Hypothesis_Testing/t_test_paired/
5. Group1_Hypothesis_Testing/t_test_one_sample/
6. Group1_Hypothesis_Testing/mann_whitney/
7. Group1_Hypothesis_Testing/wilcoxon_signed_rank/
8. Group1_Hypothesis_Testing/kruskal_wallis/
9. Group1_Hypothesis_Testing/scheirer_ray_hare/
10. Group1_Hypothesis_Testing/multifactorial_anova/
11. Group1_Hypothesis_Testing/large_50k_rows/ (50k rows from counts.csv)

## How to Create

See parent `README.md` for detailed instructions.

**Quick Steps:**
1. Start easyCris: `npm run tauri:dev`
2. Import CSV from `_test_validation/Group1_Hypothesis_Testing/<test>/data/dataset_01.csv`
3. Save as .ecp to `Group1_Hypothesis_Testing/<test>/` subdirectory
4. Repeat for all 10 Group 1 fixtures
5. Import `_test_data/counts.csv` and save as `large_50k_rows.ecp` in `Group1_Hypothesis_Testing/large_50k_rows/`

## Important

- ⚠️ These files are NOT committed to git (.gitignore)
- ⚠️ Each fixture MUST include: `.ecp` + `_data/` directory (containing DuckDB files)
- ⚠️ Group 1 fixtures MUST be in `Group1_Hypothesis_Testing/<test_name>/` subdirectories
- ⚠️ Structured folders prevent data bleed between test fixtures
- ⚠️ Missing any part will cause E2E tests to fail
