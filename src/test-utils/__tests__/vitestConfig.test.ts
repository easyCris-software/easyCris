import { describe, expect, it } from 'vitest'

import { resolveVitestMaxWorkers } from '../../../vitest.workerPolicy'

describe('Vitest worker policy', () => {
  it('caps hosted CI runs at two workers', () => {
    expect(resolveVitestMaxWorkers({ ci: true, parallelism: 16 })).toBe(2)
  })

  it('keeps local runs adaptive up to four workers', () => {
    expect(resolveVitestMaxWorkers({ ci: false, parallelism: 16 })).toBe(4)
    expect(resolveVitestMaxWorkers({ ci: false, parallelism: 3 })).toBe(2)
    expect(resolveVitestMaxWorkers({ ci: false, parallelism: 1 })).toBe(1)
  })
})
