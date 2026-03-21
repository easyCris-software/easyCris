# E2E Test Fixtures

This directory contains fixtures for E2E testing with R baseline validation.

## Directory Structure

```
e2e/fixtures/
├── baselines/              # R baseline JSON files (auto-generated)
│   ├── anova_two_way_r_baseline.json
│   ├── anova_one_way_r_baseline.json
│   ├── t_test_two_sample_r_baseline.json
│   ├── t_test_paired_r_baseline.json
│   ├── t_test_one_sample_r_baseline.json
│   ├── mann_whitney_r_baseline.json
│   ├── wilcoxon_signed_rank_r_baseline.json
│   ├── kruskal_wallis_r_baseline.json
│   ├── scheirer_ray_hare_r_baseline.json
│   └── multifactorial_anova_r_baseline.json
│
├── datasets/               # .ecp bundles (manual creation required)
│   └── Group1_Hypothesis_Testing/
│       ├── anova_two_way/
│       │   ├── anova_two_way.ecp
│       │   └── anova_two_way_data/
│       ├── anova_one_way/
│       ├── t_test_two_sample/
│       ├── t_test_paired/
│       ├── t_test_one_sample/
│       ├── mann_whitney/
│       ├── wilcoxon_signed_rank/
│       ├── kruskal_wallis/
│       ├── scheirer_ray_hare/
│       ├── multifactorial_anova/
│       └── large_50k_rows/
│           ├── large_50k_rows.ecp
│           └── large_50k_rows_data/
│
├── manifest.json           # Fixture metadata
└── README.md               # This file
```

## Setup Instructions

### Step 1: Generate R Baseline JSON Files ✅ DONE

```bash
npm run convert:validation-fixtures
```

This converts R validation CSVs to JSON format for E2E tests.

**Status:** ✅ Complete (10/10 files generated, 358 metrics)

### Step 2: Create .ecp Fixture Bundles ⚠️ MANUAL REQUIRED

For each of the 10 Group 1 tests, create an `.ecp` bundle using the easyCris UI:

#### Required Fixtures (10 tests):

1. **anova_two_way** (74 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/data/dataset_01.csv`
   - Steps:
     1. Open easyCris (`npm run tauri:dev`)
     2. Import CSV file
     3. Save as `anova_two_way.ecp`
     4. Copy `.ecp` + `_data/` to `e2e/fixtures/datasets/Group1_Hypothesis_Testing/anova_two_way/`

2. **anova_one_way** (43 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/anova_one_way/data/dataset_01.csv`

3. **t_test_two_sample** (45 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/t_test_two_sample/data/dataset_01.csv`

4. **t_test_paired** (18 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/t_test_paired/data/dataset_01.csv`

5. **t_test_one_sample** (19 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/t_test_one_sample/data/dataset_01.csv`

6. **mann_whitney** (21 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/mann_whitney/data/dataset_01.csv`

7. **wilcoxon_signed_rank** (17 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/wilcoxon_signed_rank/data/dataset_01.csv`

8. **kruskal_wallis** (26 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/kruskal_wallis/data/dataset_01.csv`

9. **scheirer_ray_hare** (23 metrics)
   - Source: `_test_validation/Group1_Hypothesis_Testing/scheirer_ray_hare/data/dataset_01.csv`

10. **multifactorial_anova** (72 metrics)
    - Source: `_test_validation/Group1_Hypothesis_Testing/multifactorial_anova/data/dataset_01.csv`

#### Large Dataset Fixture (1 fixture):

11. **large_50k_rows** (memory/performance test)
    - Source: `C:\Users\RajLord_new\Desktop\tauri\_test_data\counts.csv` (50k rows)
    - Import this file into easyCris
    - Save as `large_50k_rows.ecp`
    - Purpose: Test DuckDB persistence, memory leak detection, scroll performance

### Step 3: Verify Fixture Structure

Each fixture bundle must include:

```
datasets/Group1_Hypothesis_Testing/<test_name>/
├── <test_name>.ecp              # JSON manifest
└── <test_name>_data/            # DuckDB table directory
    ├── blank-*.ecpdb            # DuckDB blank database
    ├── dataset-*.ecpdb          # DuckDB dataset file
    └── metadata.json            # Table metadata (optional)
```

**Note:** The structured folder approach prevents data bleed between test fixtures.

**Missing any of these files will cause E2E tests to fail!**

## Usage in E2E Tests

```typescript
// Load fixture via window.__E2E__ shim
await page.evaluate(() =>
  window.__E2E__!.loadFixture('e2e/fixtures/datasets/Group1_Hypothesis_Testing/anova_two_way/anova_two_way.ecp')
)

// Load R baseline for comparison
import baseline from '../fixtures/baselines/anova_two_way_r_baseline.json'

// For memory tests, use the large dataset
await page.evaluate(() =>
  window.__E2E__!.loadFixture('e2e/fixtures/datasets/Group1_Hypothesis_Testing/large_50k_rows/large_50k_rows.ecp')
)
```

## Validation

To verify fixtures are correctly created:

1. **Check file existence:**
   ```bash
   ls e2e/fixtures/datasets/Group1_Hypothesis_Testing/
   ```

2. **Verify DuckDB files:**
   ```bash
   ls e2e/fixtures/datasets/Group1_Hypothesis_Testing/anova_two_way/anova_two_way_data/
   ```

3. **Load in easyCris UI:**
   - File > Open Project
   - Select `.ecp` file from `Group1_Hypothesis_Testing/<test_name>/` folder
   - Verify data loads correctly

## Checklist

**Phase 0.3 Complete when:**

- [x] 10 R baseline JSON files exist in `baselines/`
- [x] 10 `.ecp` bundles exist in `datasets/Group1_Hypothesis_Testing/` (with `_data/`)
- [x] 1 `large_50k_rows.ecp` fixture exists (from counts.csv)
- [x] `manifest.json` exists with updated paths

**Status:** ✅ 4/4 complete - Phase 0.3 COMPLETE!

## Notes

- **Do not commit `.ecp`/`.ecpdb` files to git** - They are large binary files
- Add `e2e/fixtures/datasets/*.ecp` to `.gitignore`
- Share fixtures via external storage if needed for team collaboration
- Fixtures must be regenerated if source CSV data changes
