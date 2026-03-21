import { test, expect } from '@playwright/test'

test.describe('Phase 0 Verification - E2E Shim', () => {
  test('window.__E2E__ API is available and functional', async ({ page }) => {
    // Capture console logs and errors
    const errors: string[] = []
    const logs: string[] = []

    page.on('console', (msg) => {
      const text = msg.text()
      logs.push(`[${msg.type()}] ${text}`)
      if (msg.type() === 'error') {
        errors.push(text)
      }
    })

    page.on('pageerror', (error) => {
      errors.push(`Page error: ${error.message}`)
      console.error('Page error:', error.message)
    })

    // Navigate to app
    await page.goto('http://localhost:1420')

    // Wait a bit for any errors to surface
    await page.waitForTimeout(2000)

    // If there are errors, log them and fail
    if (errors.length > 0) {
      console.error('Errors detected:')
      errors.forEach(err => console.error('  -', err))
      console.log('\nAll console logs:')
      logs.forEach(log => console.log('  ', log))
      throw new Error(`App has errors: ${errors.join('; ')}`)
    }

    await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 })

    // Test 1: Verify __E2E__ exists
    const shimExists = await page.evaluate(() => {
      return typeof window.__E2E__ !== 'undefined'
    })
    expect(shimExists).toBe(true)
    console.log('✓ Test 1: window.__E2E__ exists')

    // Test 2: Verify all 4 API methods exist
    const hasAllMethods = await page.evaluate(() => {
      return (
        typeof window.__E2E__?.loadFixture === 'function' &&
        typeof window.__E2E__?.runTest === 'function' &&
        typeof window.__E2E__?.getDatasetCount === 'function' &&
        typeof window.__E2E__?.clearAllData === 'function'
      )
    })
    expect(hasAllMethods).toBe(true)
    console.log('✓ Test 2: All 4 API methods exist')

    // Test 3: Initial dataset count should be 0
    const initialCount = await page.evaluate(() => window.__E2E__!.getDatasetCount())
    expect(initialCount).toBe(0)
    console.log(`✓ Test 3: Initial dataset count = ${initialCount}`)

    // Test 4: Load ANOVA fixture
    console.log('Loading fixture: anova_two_way.ecp...')
    await page.evaluate(async () => {
      await window.__E2E__!.loadFixture(
        'e2e/fixtures/datasets/Group1_Hypothesis_Testing/anova_two_way/anova_two_way.ecp'
      )
    })

    // Wait for data to load
    await page.waitForTimeout(2000)

    // Test 5: Dataset count should be 1 after loading
    const afterLoadCount = await page.evaluate(() => window.__E2E__!.getDatasetCount())
    expect(afterLoadCount).toBe(1)
    console.log(`✓ Test 4: Dataset count after load = ${afterLoadCount}`)

    // Test 6: Clear all data
    console.log('Clearing all data...')
    await page.evaluate(async () => {
      await window.__E2E__!.clearAllData()
    })

    // Wait for data to clear
    await page.waitForTimeout(1000)

    // Test 7: Dataset count should be 0 after clearing
    const afterClearCount = await page.evaluate(() => window.__E2E__!.getDatasetCount())
    expect(afterClearCount).toBe(0)
    console.log(`✓ Test 5: Dataset count after clear = ${afterClearCount}`)

    console.log('\n✅ All E2E shim tests passed!')
    console.log('Phase 0 verification complete - ready for Phase 1 implementation')
  })
})
