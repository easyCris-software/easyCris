import { test, expect } from '@playwright/test'

/**
 * E2E tests for statistical analysis orchestration
 *
 * Tests the controller-driven dialog flow:
 * 1. User selects test type
 * 2. User selects columns
 * 3. Validation passes
 * 4. Controller orchestrates conditional dialogs
 * 5. Test executes and results appear
 */

test.describe('Statistical Analysis Orchestration', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app (assumes tauri:dev is running)
    await page.goto('http://localhost:1420')

    // Wait for app to load
    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 })
  })

  test('Two-Way ANOVA: DV selection → Factor encoding → Results', async ({ page }) => {
    // 1. Import sample dataset (or use pre-loaded test data)
    // TODO: Add data import step once we have test data fixtures

    // 2. Navigate to Statistical Analysis
    await page.click('[data-testid="nav-statistical-analysis"]')

    // 3. Click "Run Analysis" button
    await page.click('[data-testid="run-analysis-button"]')

    // 4. Select "Two-Way ANOVA" from test selection dialog
    await page.waitForSelector('[data-testid="test-selection-dialog"]')
    await page.click('[data-testid="test-two-way-anova"]')
    await page.click('[data-testid="test-selection-confirm"]')

    // 5. Select columns (1 numeric DV + 2 categorical factors)
    await page.waitForSelector('[data-testid="column-selection-dialog"]')
    await page.click('[data-testid="column-checkbox-0"]') // Numeric column
    await page.click('[data-testid="column-checkbox-1"]') // Factor 1
    await page.click('[data-testid="column-checkbox-2"]') // Factor 2
    await page.click('[data-testid="column-selection-confirm"]')

    // 6. DV Selection Dialog should appear
    await page.waitForSelector('[data-testid="dv-selection-dialog"]')

    // CRITICAL: Should be radio buttons (single-select), not checkboxes
    const dvRadios = await page.locator('[data-testid^="dv-radio-"]')
    expect(await dvRadios.count()).toBeGreaterThan(0)

    // Select the numeric column as DV
    await page.click('[data-testid="dv-radio-0"]')
    await page.click('[data-testid="dv-selection-confirm"]')

    // 7. Factor Encoding Dialog should appear (for 2 factors, not 3)
    await page.waitForSelector('[data-testid="factor-encoding-dialog"]')

    // Should show only 2 factors (DV excluded)
    const factorCards = await page.locator('[data-testid^="factor-card-"]')
    expect(await factorCards.count()).toBe(2)

    // Select baselines for each factor
    await page.selectOption('[data-testid="factor-0-baseline"]', '0')
    await page.selectOption('[data-testid="factor-1-baseline"]', '0')

    // Enable simple effects (optional)
    await page.click('[data-testid="simple-effects-factor-a-within-b"]')

    await page.click('[data-testid="factor-encoding-confirm"]')

    // 8. Test should execute and results appear
    await page.waitForSelector('[data-testid="results-panel"]', { timeout: 30000 })

    // Verify results contain expected elements
    expect(await page.locator('[data-testid="result-statistics"]').isVisible()).toBe(true)
    expect(await page.locator('[data-testid="result-summary"]').isVisible()).toBe(true)
  })

  test('Binary Logistic Regression: DV selection → DV encoding → Results', async ({ page }) => {
    // 1. Navigate to Statistical Analysis
    await page.click('[data-testid="nav-statistical-analysis"]')

    // 2. Click "Run Analysis"
    await page.click('[data-testid="run-analysis-button"]')

    // 3. Select "Binary Logistic Regression"
    await page.waitForSelector('[data-testid="test-selection-dialog"]')
    await page.click('[data-testid="test-binary-logistic"]')
    await page.click('[data-testid="test-selection-confirm"]')

    // 4. Select columns (1 binary DV + 2 predictors)
    await page.waitForSelector('[data-testid="column-selection-dialog"]')
    await page.click('[data-testid="column-checkbox-0"]') // Binary outcome
    await page.click('[data-testid="column-checkbox-1"]') // Predictor 1
    await page.click('[data-testid="column-checkbox-2"]') // Predictor 2
    await page.click('[data-testid="column-selection-confirm"]')

    // 5. DV Selection Dialog
    await page.waitForSelector('[data-testid="dv-selection-dialog"]')
    await page.click('[data-testid="dv-radio-0"]') // Select binary column
    await page.click('[data-testid="dv-selection-confirm"]')

    // 6. DV Encoding Dialog should appear (binary mode)
    await page.waitForSelector('[data-testid="dv-encoding-dialog"]')

    // Should show 2 levels (binary)
    const levelButtons = await page.locator('[data-testid^="dv-level-"]')
    expect(await levelButtons.count()).toBe(2)

    // Select reference level (baseline = 0)
    await page.click('[data-testid="dv-level-0"]')
    await page.click('[data-testid="dv-encoding-confirm"]')

    // 7. Test executes and results appear
    await page.waitForSelector('[data-testid="results-panel"]', { timeout: 30000 })

    // Verify logistic regression results
    expect(await page.locator('[data-testid="result-coefficients"]').isVisible()).toBe(true)
    expect(await page.locator('[data-testid="result-odds-ratios"]').isVisible()).toBe(true)
  })

  test('Multi-Factorial ANOVA: DV selection → Multi-factor config → Results', async ({ page }) => {
    // Similar flow but with Multi-Factorial dialog
    await page.click('[data-testid="nav-statistical-analysis"]')
    await page.click('[data-testid="run-analysis-button"]')

    await page.waitForSelector('[data-testid="test-selection-dialog"]')
    await page.click('[data-testid="test-multi-factorial-anova"]')
    await page.click('[data-testid="test-selection-confirm"]')

    // Select 1 numeric + 3 categorical factors
    await page.waitForSelector('[data-testid="column-selection-dialog"]')
    await page.click('[data-testid="column-checkbox-0"]')
    await page.click('[data-testid="column-checkbox-1"]')
    await page.click('[data-testid="column-checkbox-2"]')
    await page.click('[data-testid="column-checkbox-3"]')
    await page.click('[data-testid="column-selection-confirm"]')

    // DV Selection
    await page.waitForSelector('[data-testid="dv-selection-dialog"]')
    await page.click('[data-testid="dv-radio-0"]')
    await page.click('[data-testid="dv-selection-confirm"]')

    // Multi-Factorial Dialog should appear
    await page.waitForSelector('[data-testid="multi-factorial-dialog"]')

    // Should show 3 factors (DV excluded)
    const factors = await page.locator('[data-testid^="multi-factor-"]')
    expect(await factors.count()).toBe(3)

    // Set interaction depth
    await page.selectOption('[data-testid="interaction-depth"]', '2') // Up to 2-way

    // Enable simple effects
    await page.click('[data-testid="simple-effects-grid-0-1"]')

    await page.click('[data-testid="multi-factorial-confirm"]')

    // Results should appear
    await page.waitForSelector('[data-testid="results-panel"]', { timeout: 30000 })
    expect(await page.locator('[data-testid="result-factorial-table"]').isVisible()).toBe(true)
  })
})
