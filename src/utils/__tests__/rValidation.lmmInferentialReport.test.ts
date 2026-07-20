import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

import {
  compareInferentialReportRows,
  extractInferentialReportFromUI,
} from '../../../e2e/utils/r-validation.mjs'

function withDom<T>(dom: InstanceType<typeof JSDOM>, fn: () => T): T {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  })

  try {
    return fn()
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
    })
  }
}

describe('LMM inferential report extraction', () => {
  it('extracts clean inferential report rows from the rendered ECP table', async () => {
    const dom = new JSDOM(`
      <div data-testid="results-table">
        <div class="ecp-table">
          <div class="ecp-title">Inferential Report</div>
          <div class="ecp-content">
            <table>
              <tbody>
                <tr class="ecp-header">
                  <th>Section</th>
                  <th>Effect</th>
                  <th>Within Factor</th>
                  <th>Within Level</th>
                  <th>Comparison</th>
                  <th>Estimate</th>
                  <th>Std Error</th>
                  <th>Statistic</th>
                  <th>NumDF</th>
                  <th>DenDF</th>
                  <th>Raw p</th>
                  <th>Adj. p-value</th>
                  <th>Sig</th>
                </tr>
                <tr class="ecp-separator"><td colspan="13"></td></tr>
                <tr class="ecp-data-row">
                  <td>Main Effect</td>
                  <td>Treatment</td>
                  <td>.</td>
                  <td>.</td>
                  <td>.</td>
                  <td>.</td>
                  <td>.</td>
                  <td>9066.8732</td>
                  <td>1</td>
                  <td>24</td>
                  <td>&lt;0.001</td>
                  <td>.</td>
                  <td>***</td>
                </tr>
                <tr class="ecp-data-row">
                  <td>Simple Effect</td>
                  <td>Treatment</td>
                  <td>Day</td>
                  <td>D0</td>
                  <td>A vs B</td>
                  <td>-2.5200</td>
                  <td>0.0435</td>
                  <td>-57.9069</td>
                  <td>.</td>
                  <td>68.5996</td>
                  <td>&lt;0.001</td>
                  <td>&lt;0.001</td>
                  <td>***</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `)

    const driver = {
      async executeScript(script: () => unknown) {
        return withDom(dom, script)
      },
    }

    const rows = await extractInferentialReportFromUI(driver)

    expect(rows).toEqual([
      {
        section: 'Main Effect',
        effect: 'Treatment',
        withinFactor: '.',
        withinLevel: '.',
        comparison: '.',
        estimate: null,
        stdError: null,
        statistic: 9066.8732,
        numDf: 1,
        denDf: 24,
        rawP: '<0.001',
        adjustedP: '.',
        sig: '***',
      },
      {
        section: 'Simple Effect',
        effect: 'Treatment',
        withinFactor: 'Day',
        withinLevel: 'D0',
        comparison: 'A vs B',
        estimate: -2.52,
        stdError: 0.0435,
        statistic: -57.9069,
        numDf: null,
        denDf: 68.5996,
        rawP: '<0.001',
        adjustedP: '<0.001',
        sig: '***',
      },
    ])
  })

  it('compares inferential report rows with numeric tolerance and row ordering', () => {
    const actual = [
      {
        section: 'Main Effect',
        effect: 'Treatment',
        withinFactor: '.',
        withinLevel: '.',
        comparison: '.',
        estimate: null,
        stdError: null,
        statistic: 9066.87321,
        numDf: 1,
        denDf: 24.00001,
        rawP: '<0.001',
        adjustedP: '.',
        sig: '***',
      },
    ]
    const baseline = [
      {
        section: 'Main Effect',
        effect: 'Treatment',
        withinFactor: '.',
        withinLevel: '.',
        comparison: '.',
        estimate: null,
        stdError: null,
        statistic: 9066.8732,
        numDf: 1,
        denDf: 24,
        rawP: '<0.001',
        adjustedP: '.',
        sig: '***',
      },
    ]

    const comparison = compareInferentialReportRows(actual, baseline, 0.0001)

    expect(comparison.passed).toBe(true)
    expect(comparison.totalRows).toBe(1)
    expect(comparison.totalFieldsCompared).toBeGreaterThan(5)
  })
})
