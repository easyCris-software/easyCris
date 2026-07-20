import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { extractStatsFromUI } from '../../../e2e/utils/r-validation.mjs'

describe('extractStatsFromUI', () => {
  it('extracts CI metadata from visible CI cells without data-stat', async () => {
    const dom = new JSDOM(`
      <div data-testid="results-table">
        <table>
          <tbody>
            <tr>
              <td data-stat="me1_estimate">-3.5500</td>
              <td
                data-ci-lower-stat="me1_ci_lower"
                data-ci-lower-value="-4.6906"
                data-ci-upper-stat="me1_ci_upper"
                data-ci-upper-value="-2.4094"
              >
                [-4.6906, -2.4094]
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    `)

    const driver = {
      async executeScript(script: () => Record<string, unknown>) {
        const previousWindow = globalThis.window
        const previousDocument = globalThis.document

        Object.assign(globalThis, {
          window: dom.window,
          document: dom.window.document,
        })

        try {
          return script()
        } finally {
          Object.assign(globalThis, {
            window: previousWindow,
            document: previousDocument,
          })
        }
      },
    }

    const stats = await extractStatsFromUI(driver, 'anova_two_way')

    expect(stats.me1_estimate).toBe(-3.55)
    expect(stats.me1_ci_lower).toBe(-4.6906)
    expect(stats.me1_ci_upper).toBe(-2.4094)
  })
})
