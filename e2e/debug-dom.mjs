import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'
import { runDoseResponse3PL, waitForResults } from './utils/ui-workflow.mjs'

async function runTest() {
  let driver, webdriver
  try {
    logStep('Debug: Checking DOM for dose-response 3PL...')
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver
    await verifyCleanState(driver)
    
    const fixture = await loadFixture(driver, 'dose_response_3pl')
    logStep(`Loaded fixture`)
    
    await runDoseResponse3PL(driver, {})
    await waitForResults(driver)
    
    // Debug: Log all results table contents
    const debugInfo = await driver.executeScript(() => {
      const table = document.querySelector('[data-testid="results-table"]')
      if (!table) return { error: 'No results table found' }
      
      // Get all text content
      const text = table.innerText.substring(0, 5000)
      
      // Get all data-stat cells
      const statCells = Array.from(table.querySelectorAll('[data-stat]'))
      const stats = statCells.map(cell => ({
        stat: cell.getAttribute('data-stat'),
        value: cell.textContent.trim()
      }))
      
      // Get table HTML structure (first 3000 chars)
      const html = table.innerHTML.substring(0, 3000)
      
      // Check for error messages
      const hasError = text.toLowerCase().includes('error') || text.toLowerCase().includes('failed')
      
      return {
        textPreview: text,
        statsFound: stats,
        statsCount: stats.length,
        hasError,
        htmlPreview: html
      }
    })
    
    console.log('\n=== DEBUG INFO ===')
    console.log('Stats found:', debugInfo.statsCount)
    console.log('Stats:', JSON.stringify(debugInfo.statsFound, null, 2))
    console.log('\nHas error:', debugInfo.hasError)
    console.log('\nText preview:\n', debugInfo.textPreview)
    console.log('\nHTML preview:\n', debugInfo.htmlPreview)
    
  } catch (error) {
    console.error(`FAILED: ${error.message}`)
    throw error
  } finally {
    if (driver && webdriver) {
      await cleanupTest(driver, webdriver)
    }
  }
}

runTest().catch(err => {
  console.error('Execution failed:', err)
  process.exit(1)
})
