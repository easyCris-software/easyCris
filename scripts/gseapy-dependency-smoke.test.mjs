import assert from 'node:assert/strict'
import test from 'node:test'

import { validateGseapySmoke } from './gseapy-dependency-smoke.mjs'

function validResult() {
  const run = {
    pathways: [
      {
        name: 'PATHWAY_ALPHA',
        es: 0.75,
        nes: 1.25,
        nominal_p_value: 0.03125,
        fdr_q_value: 0.0625,
      },
      {
        name: 'PATHWAY_BETA',
        es: -0.5,
        nes: -1.125,
        nominal_p_value: 0.125,
        fdr_q_value: 0.25,
      },
    ],
  }
  return {
    version: '1.1.11',
    seed: 20260728,
    runs: [structuredClone(run), structuredClone(run)],
  }
}

test('accepts exact GSEApy and deterministic finite public pathway results', () => {
  assert.deepEqual(validateGseapySmoke(validResult()), [])
})

test('rejects a missing or wrong GSEApy version', () => {
  const missing = validResult()
  delete missing.version
  const wrong = validResult()
  wrong.version = '1.1.10'

  assert.match(validateGseapySmoke(missing).join('\n'), /version/i)
  assert.match(validateGseapySmoke(wrong).join('\n'), /version/i)
})

test('rejects a missing expected pathway', () => {
  const result = validResult()
  result.runs[0].pathways.pop()

  assert.match(validateGseapySmoke(result).join('\n'), /pathway/i)
})

test('rejects a non-finite metric', () => {
  const result = validResult()
  result.runs[0].pathways[0].nes = Number.POSITIVE_INFINITY

  assert.match(validateGseapySmoke(result).join('\n'), /finite/i)
})

test('rejects a nondeterministic same-runtime repeat', () => {
  const result = validResult()
  result.runs[1].pathways[1].fdr_q_value += 0.00001

  assert.match(validateGseapySmoke(result).join('\n'), /deterministic/i)
})
