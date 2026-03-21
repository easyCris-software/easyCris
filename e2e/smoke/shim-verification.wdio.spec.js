/**
 * Phase 0 Verification - E2E Shim with tauri-driver
 *
 * Tests the window.__E2E__ API in the REAL Tauri runtime
 * (not a browser - this runs the full Rust + Python + DuckDB stack)
 */

describe('Phase 0 Verification - E2E Shim (Tauri Runtime)', () => {
  it('should have window.__E2E__ API available', async () => {
    // Test 1: Verify __E2E__ exists
    const shimExists = await browser.execute(() => {
      return typeof window.__E2E__ !== 'undefined'
    })
    expect(shimExists).toBe(true)
    console.log('✓ Test 1: window.__E2E__ exists')

    // Test 2: Verify all 4 API methods exist
    const hasAllMethods = await browser.execute(() => {
      return (
        typeof window.__E2E__?.loadFixture === 'function' &&
        typeof window.__E2E__?.runTest === 'function' &&
        typeof window.__E2E__?.getDatasetCount === 'function' &&
        typeof window.__E2E__?.clearAllData === 'function'
      )
    })
    expect(hasAllMethods).toBe(true)
    console.log('✓ Test 2: All 4 API methods exist')
  })

  it('should return correct initial dataset count', async () => {
    const initialCount = await browser.execute(() => {
      return window.__E2E__.getDatasetCount()
    })
    expect(initialCount).toBe(0)
    console.log(`✓ Test 3: Initial dataset count = ${initialCount}`)
  })

  it('should load fixture and update dataset count', async () => {
    // Load ANOVA fixture
    await browser.execute(async () => {
      await window.__E2E__.loadFixture(
        'e2e/fixtures/datasets/Group1_Hypothesis_Testing/anova_two_way/anova_two_way.ecp'
      )
    })

    // Wait for data to load
    await browser.pause(2000)

    // Check dataset count
    const afterLoadCount = await browser.execute(() => {
      return window.__E2E__.getDatasetCount()
    })
    expect(afterLoadCount).toBe(1)
    console.log(`✓ Test 4: Dataset count after load = ${afterLoadCount}`)
  })

  it('should clear all data', async () => {
    // Clear data
    await browser.execute(async () => {
      await window.__E2E__.clearAllData()
    })

    // Wait for clear
    await browser.pause(1000)

    // Verify cleared
    const afterClearCount = await browser.execute(() => {
      return window.__E2E__.getDatasetCount()
    })
    expect(afterClearCount).toBe(0)
    console.log(`✓ Test 5: Dataset count after clear = ${afterClearCount}`)

    console.log('\n✅ All E2E shim tests passed with Tauri runtime!')
    console.log('Phase 0 verification complete - ready for Phase 1 implementation')
  })
})
