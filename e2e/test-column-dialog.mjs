/**
 * Debug: Understand column selection dialog structure
 */

import { setupTest, cleanupTest, verifyCleanState } from './utils/selenium-setup.mjs'
import { loadFixture } from './utils/fixtures.mjs'
import { logStep } from './utils/assertions.mjs'
import { until } from 'selenium-webdriver'

async function runTest() {
  let driver, webdriver

  try {
    const result = await setupTest()
    driver = result.driver
    webdriver = result.webdriver

    await verifyCleanState(driver)
    const fixture = await loadFixture(driver, 't_test_two_sample')
    logStep(`Fixture loaded`)

    // Navigate to column dialog
    // Wait for data
    await driver.wait(async () => {
      return await driver.executeScript(() => {
        const datasetCount = window.__E2E__?.getDatasetCount?.() || 0
        const canvasCount = document.querySelectorAll('canvas').length
        return datasetCount > 0 && canvasCount > 0
      })
    }, 15000)

    await driver.sleep(1000)

    // Click Perform Test
    const button = await driver.wait(until.elementLocated({ css: '[data-testid="run-analysis-button"]' }), 10000)
    await button.click()
    await driver.sleep(1000)

    // Expand hypothesis_testing
    const groupBtn = await driver.wait(until.elementLocated({ css: '[data-testid="test-group-hypothesis_testing"]' }), 10000)
    await groupBtn.click()
    await driver.sleep(500)

    // Select independent_ttest
    const testBtn = await driver.wait(until.elementLocated({ css: '[data-testid="test-independent_ttest"]' }), 10000)
    await testBtn.click()
    await driver.sleep(300)

    // Confirm
    const confirmBtn = await driver.findElements({ css: '[data-testid="confirm-test-selection"]' })
    if (confirmBtn.length > 0) {
      await confirmBtn[0].click()
    } else {
      const buttons = await driver.findElements({ css: 'button' })
      for (const btn of buttons) {
        const text = await btn.getText()
        if (text.includes('Select a Test')) {
          await btn.click()
          break
        }
      }
    }

    logStep('Confirmed test, waiting for column dialog...')
    await driver.sleep(2000)

    // Now analyze column dialog structure
    const dialogInfo = await driver.executeScript(() => {
      const info = {
        dialogText: document.body.innerText.includes('Select Columns'),
        allInputs: document.querySelectorAll('input').length,
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
        radioButtons: document.querySelectorAll('input[type="radio"]').length,
        clickableDivs: Array.from(document.querySelectorAll('div')).filter(d =>
          d.onclick || d.classList.contains('cursor-pointer') || window.getComputedStyle(d).cursor === 'pointer'
        ).length,
        columnCards: [],
      }

      // Find elements containing "BINARY" or "NUMERIC"
      const divs = Array.from(document.querySelectorAll('div'))
      const cards = divs.filter(el => {
        const text = el.innerText
        return (text.includes('BINARY') || text.includes('NUMERIC')) && text.includes('unique values')
      })

      cards.forEach((card, idx) => {
        const cardInfo = {
          index: idx,
          text: card.innerText.substring(0, 200),
          classList: Array.from(card.classList),
          hasOnClick: !!card.onclick,
          cursor: window.getComputedStyle(card).cursor,
          childInputs: card.querySelectorAll('input').length,
          childCheckboxes: card.querySelectorAll('input[type="checkbox"]').length,
        }
        info.columnCards.push(cardInfo)
      })

      return info
    })

    console.log('\n=== COLUMN DIALOG STRUCTURE ===')
    console.log(JSON.stringify(dialogInfo, null, 2))

    logStep('Analysis complete - keeping app open for inspection')
    await driver.sleep(60000)

  } catch (error) {
    console.error(`TEST FAILED: ${error.message}`)
    console.error(error.stack)
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
