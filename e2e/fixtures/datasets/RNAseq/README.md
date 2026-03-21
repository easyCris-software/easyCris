# RNA-seq E2E Fixtures

## Creating the .ecp Fixture

The RNA-seq test requires a pre-loaded `.ecp` fixture with DESeq2 analysis results.

### Prerequisites

1. App must be running in E2E mode:
   ```bash
   # In .env file
   VITE_E2E_ENABLED=true

   # Start app
   npm run tauri:dev
   ```

2. Input CSV files must exist:
   - `e2e/fixtures/datasets/RNAseq/counts.csv` (gene counts matrix)
   - `e2e/fixtures/datasets/RNAseq/metadata.csv` (sample metadata)

### Automated Creation (Recommended)

Run the fixture creation script:

```bash
node e2e/scripts/create-rnaseq-fixture.mjs
```

This will:
1. Launch the app via Selenium
2. Import counts + metadata CSVs
3. Create RNA-seq project
4. Run DESeq2 analysis
5. Save as `e2e/fixtures/datasets/RNAseq/rnaseq_deseq2/rnaseq_deseq2.ecp`
6. (Recommended) Generate PCA ellipse baselines from the fixture (ggplot2/MASS equivalent)
   ```bash
   cd _test_validation/RNA_seq/r
   Rscript run_pca_baselines_from_fixture.R
   ```

**Time**: ~2-3 minutes (DESeq2 analysis is slow on large datasets)

### Manual Creation (Alternative)

1. Open app (with `VITE_E2E_ENABLED=true`)
2. Import `counts.csv` and `metadata.csv`
3. Create new RNA-seq project
4. Link counts/metadata datasets
5. Run DESeq2 analysis with these settings:
   ```
   - Design: ~ Treatment
   - Reference: vehicle
   - Test: THC
   - Alpha: 0.05
   - Min Count: 10
   - Apply Shrinkage: false
   - PCA Top Genes: 500
   ```
6. Open browser console and run:
   ```javascript
   await window.__E2E__.saveProject('e2e/fixtures/datasets/RNAseq/rnaseq_deseq2/rnaseq_deseq2.ecp')
   ```

### Verification

Check that the fixture was created:

```bash
ls -lh e2e/fixtures/datasets/RNAseq/rnaseq_deseq2/rnaseq_deseq2.ecp
```

File should be ~50-100KB (compressed project snapshot).

### Usage in Tests

```javascript
import { loadFixture } from '../../utils/fixtures.mjs'

// Load fixture (automatically imports counts + metadata, creates project, runs analysis)
const fixture = await loadFixture(driver, 'rnaseq_deseq2')
```

This is equivalent to the manual CSV import + project setup, but:
- ✅ Single line of code
- ✅ Matches validated statistics pattern
- ✅ Faster (no DESeq2 re-run)
- ✅ Deterministic (same results every time)

## Fixture Contents

The `.ecp` file contains:
- 2 datasets (counts matrix + metadata)
- 1 RNA-seq project
- 1 DESeq2 analysis result (~55k genes)
- Pre-computed PCA data
- Plot configurations

**Size**: ~1.5MB uncompressed, ~100KB compressed
