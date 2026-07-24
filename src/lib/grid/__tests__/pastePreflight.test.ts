import { describe, expect, it, vi } from 'vitest'
import {
  applyColumnExpansion,
  buildNewColumnDrafts,
  computeAffectedBlockKeys,
  computeDataRowCountPromotion,
  computePastePreflight,
  computeRequiredDataRowsForPaste,
  decidePasteOverflow,
  isViewTransformActive,
  resolvePasteLoopBounds,
  resolveTransformAwareRowCap,
  syncBlockSetsForActiveDataset,
  syncBlockSetsForRange,
} from '@/lib/grid/pastePreflight'
import type {
  ColumnExpansionCallbacks,
  NewColumnDraft,
} from '@/lib/grid/pastePreflight'

describe('pastePreflight block helpers', () => {
  it('computes dataset-scoped block keys for inclusive model row range', () => {
    const keys = computeAffectedBlockKeys('ds-1', 510, 1030, 512)
    expect(keys).toEqual(['ds-1:block:0', 'ds-1:block:1', 'ds-1:block:2'])
  })

  it('returns empty keys when max row is before min row', () => {
    expect(computeAffectedBlockKeys('ds-1', 5, 4, 512)).toEqual([])
  })

  it('clamps negative rows to block 0 for consistency with range loader', () => {
    expect(computeAffectedBlockKeys('ds-1', -10, 10, 512)).toEqual(['ds-1:block:0'])
  })

  it('invalidates loaded/pending and marks wanted for affected blocks only', () => {
    const loaded = new Set<string>(['ds-1:block:0', 'ds-1:block:1', 'ds-2:block:0'])
    const pending = new Set<string>(['ds-1:block:1', 'ds-1:block:2', 'ds-2:block:1'])
    const wanted = new Set<string>(['ds-1:block:5'])

    const touched = syncBlockSetsForRange({
      datasetId: 'ds-1',
      minModelRow: 510,
      maxModelRow: 1030,
      blockSize: 512,
      loaded,
      pending,
      wanted,
    })

    expect(touched).toEqual(['ds-1:block:0', 'ds-1:block:1', 'ds-1:block:2'])
    expect(loaded.has('ds-1:block:0')).toBe(false)
    expect(loaded.has('ds-1:block:1')).toBe(false)
    expect(loaded.has('ds-2:block:0')).toBe(true)

    expect(pending.has('ds-1:block:1')).toBe(false)
    expect(pending.has('ds-1:block:2')).toBe(false)
    expect(pending.has('ds-2:block:1')).toBe(true)

    expect(wanted.has('ds-1:block:0')).toBe(true)
    expect(wanted.has('ds-1:block:1')).toBe(true)
    expect(wanted.has('ds-1:block:2')).toBe(true)
    expect(wanted.has('ds-1:block:5')).toBe(true)
  })

  it('does not mutate block sets when active dataset does not match target dataset', () => {
    const loaded = new Set<string>(['ds-1:block:0', 'ds-1:block:1'])
    const pending = new Set<string>(['ds-1:block:1'])
    const wanted = new Set<string>(['ds-1:block:5'])

    const touched = syncBlockSetsForActiveDataset({
      activeDatasetId: 'ds-2',
      datasetId: 'ds-1',
      minModelRow: 0,
      maxModelRow: 1024,
      blockSize: 512,
      loaded,
      pending,
      wanted,
    })

    expect(touched).toEqual([])
    expect(Array.from(loaded)).toEqual(['ds-1:block:0', 'ds-1:block:1'])
    expect(Array.from(pending)).toEqual(['ds-1:block:1'])
    expect(Array.from(wanted)).toEqual(['ds-1:block:5'])
  })

  it('mutates block sets when active dataset matches target dataset', () => {
    const loaded = new Set<string>(['ds-1:block:0'])
    const pending = new Set<string>(['ds-1:block:0'])
    const wanted = new Set<string>()

    const touched = syncBlockSetsForActiveDataset({
      activeDatasetId: 'ds-1',
      datasetId: 'ds-1',
      minModelRow: 0,
      maxModelRow: 511,
      blockSize: 512,
      loaded,
      pending,
      wanted,
    })

    expect(touched).toEqual(['ds-1:block:0'])
    expect(loaded.has('ds-1:block:0')).toBe(false)
    expect(pending.has('ds-1:block:0')).toBe(false)
    expect(wanted.has('ds-1:block:0')).toBe(true)
  })
})

describe('computeRequiredDataRowsForPaste', () => {
  it('uses model-row mapping for non-identity order', () => {
    const required = computeRequiredDataRowsForPaste(0, 3, (viewRow) => [10, 20, 30][viewRow] ?? -1)
    expect(required).toBe(31)
  })

  it('falls back conservatively when any mapped row is unresolved', () => {
    const required = computeRequiredDataRowsForPaste(5, 3, (viewRow) => {
      if (viewRow === 6) return -1
      return viewRow
    })
    expect(required).toBe(8)
  })

  it('uses conservative row requirement when all mapped rows are unresolved', () => {
    const required = computeRequiredDataRowsForPaste(12, 4, () => -1)
    expect(required).toBe(16)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 2D array of `rows` x `cols` dummy cells */
function makeMatrix(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => `r${r}c${c}`)
  )
}

// ---------------------------------------------------------------------------
// Core result shape
// ---------------------------------------------------------------------------

describe('computePastePreflight — result shape', () => {
  it('returns an object with all required fields', () => {
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(3, 2),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result).toHaveProperty('requiredRowCount')
    expect(result).toHaveProperty('requiredColCount')
    expect(result).toHaveProperty('rowOverflow')
    expect(result).toHaveProperty('colOverflow')
    expect(result).toHaveProperty('fitsInBounds')
  })

  it('handles paste matrices beyond the JavaScript argument spread limit', () => {
    const rowCount = 150_000
    const parsedData = Array.from({ length: rowCount }, (_, rowIndex) =>
      rowIndex === rowCount - 1 ? ['last', 'wide'] : ['value']
    )

    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData,
      currentRowCount: rowCount,
      currentColCount: 2,
    })

    expect(result.requiredRowCount).toBe(rowCount)
    expect(result.requiredColCount).toBe(2)
    expect(result.rowOverflow).toBe(0)
    expect(result.fitsInBounds).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fits within bounds (no overflow)
// ---------------------------------------------------------------------------

describe('computePastePreflight — fits within bounds', () => {
  it('reports fitsInBounds=true when paste is well inside grid', () => {
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(10, 5),
      currentRowCount: 100,
      currentColCount: 20,
    })

    expect(result.fitsInBounds).toBe(true)
    expect(result.rowOverflow).toBe(0)
    expect(result.colOverflow).toBe(0)
  })

  it('reports fitsInBounds=true when paste exactly fills remaining rows', () => {
    // startViewRow=90, paste 10 rows → needs rows 90–99 → exactly rowCount=100
    const result = computePastePreflight({
      startViewRow: 90,
      startCol: 0,
      parsedData: makeMatrix(10, 1),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(true)
    expect(result.rowOverflow).toBe(0)
  })

  it('reports fitsInBounds=true when paste exactly fills remaining cols', () => {
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 8,
      parsedData: makeMatrix(1, 2),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(true)
    expect(result.colOverflow).toBe(0)
  })

  it('reports fitsInBounds=true for single-cell paste', () => {
    const result = computePastePreflight({
      startViewRow: 5,
      startCol: 3,
      parsedData: [['hello']],
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(true)
    expect(result.rowOverflow).toBe(0)
    expect(result.colOverflow).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Row overflow
// ---------------------------------------------------------------------------

describe('computePastePreflight — row overflow', () => {
  it('detects row overflow when paste extends beyond rowCount', () => {
    // startViewRow=95, paste 10 rows → needs rows 95–104 → rowCount=100 → 5 overflow
    const result = computePastePreflight({
      startViewRow: 95,
      startCol: 0,
      parsedData: makeMatrix(10, 1),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.rowOverflow).toBe(5)
    expect(result.colOverflow).toBe(0)
  })

  it('counts rowOverflow as exact clipped row count', () => {
    const result = computePastePreflight({
      startViewRow: 600,
      startCol: 0,
      parsedData: makeMatrix(520, 20),
      currentRowCount: 700,  // 100 rows of headroom → 420 clipped
      currentColCount: 20,
    })

    expect(result.rowOverflow).toBe(420)
  })

  it('detects total overflow when paste starts past rowCount', () => {
    // Anchor is BEYOND current rowCount (midline paste into buffer that ran out)
    const result = computePastePreflight({
      startViewRow: 710,
      startCol: 0,
      parsedData: makeMatrix(5, 1),
      currentRowCount: 700,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.rowOverflow).toBeGreaterThan(0)
  })

  it('computes requiredRowCount as startViewRow + pastedRows', () => {
    const result = computePastePreflight({
      startViewRow: 200,
      startCol: 0,
      parsedData: makeMatrix(520, 1),
      currentRowCount: 700,
      currentColCount: 10,
    })

    expect(result.requiredRowCount).toBe(720) // 200 + 520
  })

  it('fitsInBounds=false when only 1 row overflows', () => {
    const result = computePastePreflight({
      startViewRow: 99,
      startCol: 0,
      parsedData: makeMatrix(2, 1), // needs rows 99, 100 → rowCount=100 → 1 overflow
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.rowOverflow).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Column overflow
// ---------------------------------------------------------------------------

describe('computePastePreflight — column overflow', () => {
  it('detects column overflow when paste extends beyond colCount', () => {
    // startCol=8, paste 5 cols → needs cols 8–12 → currentColCount=10 → 3 overflow
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 8,
      parsedData: makeMatrix(1, 5),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.colOverflow).toBe(3)
    expect(result.rowOverflow).toBe(0)
  })

  it('computes requiredColCount as startCol + pastedCols', () => {
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 15,
      parsedData: makeMatrix(1, 10),
      currentRowCount: 100,
      currentColCount: 20,
    })

    expect(result.requiredColCount).toBe(25) // 15 + 10
  })
})

// ---------------------------------------------------------------------------
// Both row and column overflow
// ---------------------------------------------------------------------------

describe('computePastePreflight — both row and column overflow', () => {
  it('detects both overflows simultaneously', () => {
    const result = computePastePreflight({
      startViewRow: 95,
      startCol: 8,
      parsedData: makeMatrix(10, 5),
      currentRowCount: 100,
      currentColCount: 10,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.rowOverflow).toBe(5)
    expect(result.colOverflow).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Real-world scenario: the user's actual case
// ---------------------------------------------------------------------------

describe('computePastePreflight — real-world scenario', () => {
  it('reproduces the 650-row / midline-paste data loss case', () => {
    // Statistics 1: 650 data rows + 50 ROW_BUFFER = 700 rowCount
    // Paste anchor: row 200 (midline), pasting Statistics 2 (520 rows × 20 cols)
    // Expected: needs 720 rows, overflows by 20
    const result = computePastePreflight({
      startViewRow: 200,
      startCol: 0,
      parsedData: makeMatrix(520, 20),
      currentRowCount: 700,
      currentColCount: 20,
    })

    expect(result.fitsInBounds).toBe(false)
    expect(result.requiredRowCount).toBe(720)
    expect(result.rowOverflow).toBe(20)
    expect(result.colOverflow).toBe(0)
  })

  it('handles paste at row 0 of a 520-row source into 650-row grid (fits)', () => {
    // startViewRow=0, 520 rows → requiredRowCount=520, currentRowCount=700 → fits
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(520, 20),
      currentRowCount: 700,
      currentColCount: 20,
    })

    expect(result.fitsInBounds).toBe(true)
    expect(result.rowOverflow).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Ragged clipboard (rows with different widths)
// ---------------------------------------------------------------------------

describe('computePastePreflight — ragged clipboard rows', () => {
  it('uses max row width, not first row width, for colOverflow', () => {
    // Clipboard has 3 rows: widths 2, 4, 3 — max is 4
    const raggredData = [
      ['a', 'b'],
      ['c', 'd', 'e', 'f'],  // widest row
      ['g', 'h', 'i'],
    ]
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: raggredData,
      currentRowCount: 100,
      currentColCount: 3, // only 3 cols — row [1] needs 4 → overflow of 1
    })

    expect(result.requiredColCount).toBe(4) // max(2,4,3) = 4
    expect(result.colOverflow).toBe(1)
    expect(result.fitsInBounds).toBe(false)
  })

  it('reports no overflow when max width fits even if later rows are narrower', () => {
    const raggredData = [
      ['a', 'b', 'c'],  // widest
      ['d', 'e'],
    ]
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: raggredData,
      currentRowCount: 100,
      currentColCount: 5,
    })

    expect(result.requiredColCount).toBe(3)
    expect(result.colOverflow).toBe(0)
    expect(result.fitsInBounds).toBe(true)
  })

  it('handles single-col ragged (all rows width 1) correctly', () => {
    const singleCol = [['a'], ['b'], ['c']]
    const result = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: singleCol,
      currentRowCount: 100,
      currentColCount: 5,
    })

    expect(result.requiredColCount).toBe(1)
    expect(result.colOverflow).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// resolvePasteLoopBounds — decision → effective loop caps
// ---------------------------------------------------------------------------

describe('resolvePasteLoopBounds — expand decision', () => {
  it('returns requiredRowCount as effectiveRowCap when expanding', () => {
    const preflight = computePastePreflight({
      startViewRow: 95,
      startCol: 0,
      parsedData: makeMatrix(10, 1),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'expand', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds).not.toBeNull()
    expect(bounds!.effectiveRowCap).toBe(105) // 95 + 10
  })

  it('returns requiredColCount as effectiveColCap when expanding', () => {
    const preflight = computePastePreflight({
      startViewRow: 0,
      startCol: 8,
      parsedData: makeMatrix(1, 5),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'expand', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds).not.toBeNull()
    expect(bounds!.effectiveColCap).toBe(13) // 8 + 5
  })

  it('returns current caps unchanged when paste already fits (expand is no-op)', () => {
    const preflight = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(5, 3),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'expand', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds!.effectiveRowCap).toBe(5)   // requiredRowCount = 0+5
    expect(bounds!.effectiveColCap).toBe(3)   // requiredColCount = 0+3
  })
})

describe('resolvePasteLoopBounds — within-bounds decision', () => {
  it('returns currentRowCount as effectiveRowCap (clips overflow intentionally)', () => {
    const preflight = computePastePreflight({
      startViewRow: 95,
      startCol: 0,
      parsedData: makeMatrix(10, 1),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'within-bounds', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds).not.toBeNull()
    expect(bounds!.effectiveRowCap).toBe(100) // existing capacity, clips 5 rows
  })

  it('returns currentColCount as effectiveColCap (clips col overflow intentionally)', () => {
    const preflight = computePastePreflight({
      startViewRow: 0,
      startCol: 8,
      parsedData: makeMatrix(1, 5),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'within-bounds', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds!.effectiveColCap).toBe(10) // clips 3 cols
  })
})

describe('resolvePasteLoopBounds — cancel decision', () => {
  it('returns null for cancel (no edits should be built)', () => {
    const preflight = computePastePreflight({
      startViewRow: 95,
      startCol: 0,
      parsedData: makeMatrix(10, 1),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'cancel', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds).toBeNull()
  })

  it('returns null for cancel even when paste fits (explicit cancel always aborts)', () => {
    const preflight = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(5, 3),
      currentRowCount: 100,
      currentColCount: 10,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'cancel', { currentRowCount: 100, currentColCount: 10 })

    expect(bounds).toBeNull()
  })
})

describe('resolvePasteLoopBounds — real-world scenario', () => {
  it('expand: all 520 rows write through when pasting at midline row 200 into 700-cap grid', () => {
    const preflight = computePastePreflight({
      startViewRow: 200,
      startCol: 0,
      parsedData: makeMatrix(520, 20),
      currentRowCount: 700,
      currentColCount: 20,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'expand', { currentRowCount: 700, currentColCount: 20 })

    expect(bounds!.effectiveRowCap).toBe(720) // 200 + 520 — no clipping
    expect(bounds!.effectiveColCap).toBe(20)  // exactly fits cols
  })

  it('within-bounds: 20 overflow rows are explicitly clipped, not silently lost', () => {
    const preflight = computePastePreflight({
      startViewRow: 200,
      startCol: 0,
      parsedData: makeMatrix(520, 20),
      currentRowCount: 700,
      currentColCount: 20,
    })
    const bounds = resolvePasteLoopBounds(preflight, 'within-bounds', { currentRowCount: 700, currentColCount: 20 })

    expect(bounds!.effectiveRowCap).toBe(700) // 20 rows intentionally clipped
  })
})

// ---------------------------------------------------------------------------
// Integration: isViewTransformActive — gate for overflow paste
// ---------------------------------------------------------------------------

describe('isViewTransformActive — overflow gate', () => {
  const noTransform = {
    sortModelLength: 0,
    enableExcelViewFilter: false,
    hasViewFilterConfig: false,
    groupByColumnId: null,
  }

  it('returns false when no sort, filter, or group is active', () => {
    expect(isViewTransformActive(noTransform)).toBe(false)
  })

  it('returns true when sort is active', () => {
    expect(isViewTransformActive({ ...noTransform, sortModelLength: 1 })).toBe(true)
  })

  it('returns true when excel filter is active with a filter config', () => {
    expect(isViewTransformActive({
      ...noTransform,
      enableExcelViewFilter: true,
      hasViewFilterConfig: true,
    })).toBe(true)
  })

  it('returns false when excel filter is enabled but no filter config (no active filter)', () => {
    expect(isViewTransformActive({
      ...noTransform,
      enableExcelViewFilter: true,
      hasViewFilterConfig: false,
    })).toBe(false)
  })

  it('returns false when filter config exists but excel filter is disabled', () => {
    // enableExcelViewFilter=false means filter is not applied to the view
    expect(isViewTransformActive({
      ...noTransform,
      enableExcelViewFilter: false,
      hasViewFilterConfig: true,
    })).toBe(false)
  })

  it('returns true when group is active', () => {
    expect(isViewTransformActive({ ...noTransform, groupByColumnId: 'col_123' })).toBe(true)
  })

  it('returns true when multiple transforms are active simultaneously', () => {
    expect(isViewTransformActive({
      sortModelLength: 2,
      enableExcelViewFilter: true,
      hasViewFilterConfig: true,
      groupByColumnId: 'col_456',
    })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: overflow paste allowed/blocked by transform state
// ---------------------------------------------------------------------------

describe('overflow paste gate — transform state integration', () => {
  const OVERFLOW_PREFLIGHT = computePastePreflight({
    startViewRow: 200,
    startCol: 0,
    parsedData: makeMatrix(520, 20),
    currentRowCount: 700,
    currentColCount: 20,
  })

  it('overflow paste should expand when no transform is active', () => {
    // Simulate SpreadsheetView logic: overflow + no transform → should NOT block
    const blocked = OVERFLOW_PREFLIGHT.rowOverflow > 0 && isViewTransformActive({
      sortModelLength: 0,
      enableExcelViewFilter: false,
      hasViewFilterConfig: false,
      groupByColumnId: null,
    })
    expect(blocked).toBe(false)

    // And the expand bounds give full capacity
    const bounds = resolvePasteLoopBounds(OVERFLOW_PREFLIGHT, 'expand', {
      currentRowCount: 700,
      currentColCount: 20,
    })
    expect(bounds!.effectiveRowCap).toBe(720)
  })

  it('overflow paste should be blocked when sort is active', () => {
    const blocked = OVERFLOW_PREFLIGHT.rowOverflow > 0 && isViewTransformActive({
      sortModelLength: 1,
      enableExcelViewFilter: false,
      hasViewFilterConfig: false,
      groupByColumnId: null,
    })
    expect(blocked).toBe(true)
  })

  it('overflow paste should be blocked when filter is active', () => {
    const blocked = OVERFLOW_PREFLIGHT.rowOverflow > 0 && isViewTransformActive({
      sortModelLength: 0,
      enableExcelViewFilter: true,
      hasViewFilterConfig: true,
      groupByColumnId: null,
    })
    expect(blocked).toBe(true)
  })

  it('overflow paste should be blocked when group is active', () => {
    const blocked = OVERFLOW_PREFLIGHT.rowOverflow > 0 && isViewTransformActive({
      sortModelLength: 0,
      enableExcelViewFilter: false,
      hasViewFilterConfig: false,
      groupByColumnId: 'col_strain',
    })
    expect(blocked).toBe(true)
  })

  it('paste within bounds is never blocked by transform state (no overflow = no block)', () => {
    const fits = computePastePreflight({
      startViewRow: 0,
      startCol: 0,
      parsedData: makeMatrix(10, 5),
      currentRowCount: 700,
      currentColCount: 20,
    })
    // rowOverflow = 0, so hasRowOverflow = false → block never fires regardless of transforms
    const blocked = fits.rowOverflow > 0 && isViewTransformActive({
      sortModelLength: 3,
      enableExcelViewFilter: true,
      hasViewFilterConfig: true,
      groupByColumnId: 'col_abc',
    })
    expect(blocked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildNewColumnDrafts — column pre-expansion for paste overflow
// ---------------------------------------------------------------------------

describe('buildNewColumnDrafts', () => {
  /** Stable allocator: returns 'Column N' where N increments from startN */
  function makeAllocator(startN = 5): () => string | null {
    let n = startN
    return () => `Column ${n++}`
  }

  /** Stable ID generator: returns 'col-test-N' */
  function makeIdGen(): () => string {
    let n = 0
    return () => `col-test-${n++}`
  }

  it('returns an empty array when colOverflow is 0', () => {
    const drafts = buildNewColumnDrafts(0, makeAllocator(), makeIdGen())
    expect(drafts).toEqual([])
  })

  it('returns one draft when colOverflow is 1', () => {
    const drafts = buildNewColumnDrafts(1, makeAllocator(5), makeIdGen())
    expect(drafts).not.toBeNull()
    expect(drafts!.length).toBe(1)
    const first = drafts![0]!
    expect(first.name).toBe('Column 5')
    expect(first.type).toBe('text')
    expect(first.id).toBe('col-test-0')
  })

  it('returns N drafts when colOverflow is N, names in allocation order', () => {
    const drafts = buildNewColumnDrafts(3, makeAllocator(10), makeIdGen())
    expect(drafts).not.toBeNull()
    expect(drafts!.length).toBe(3)
    expect(drafts!.map(d => d.name)).toEqual(['Column 10', 'Column 11', 'Column 12'])
    expect(drafts!.map(d => d.type)).toEqual(['text', 'text', 'text'])
    expect(drafts!.map(d => d.id)).toEqual(['col-test-0', 'col-test-1', 'col-test-2'])
  })

  it('returns null when allocateName returns null on the first call', () => {
    const result = buildNewColumnDrafts(2, () => null, makeIdGen())
    expect(result).toBeNull()
  })

  it('returns null when allocateName returns null partway through (partial failure)', () => {
    let calls = 0
    const allocator = () => {
      calls++
      return calls === 2 ? null : `Column ${calls + 9}`
    }
    const result = buildNewColumnDrafts(3, allocator, makeIdGen())
    expect(result).toBeNull()
    // allocateName was called at least twice (failed on 2nd)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('on partial failure: returns null and allocateName is not called past the failing slot', () => {
    const allocated: (string | null)[] = []
    const allocator = () => {
      const sequence = ['Column 5', null, 'Column 6'] as const
      const v = allocated.length < sequence.length ? sequence[allocated.length] ?? null : null
      allocated.push(v)
      return v
    }
    const result = buildNewColumnDrafts(3, allocator, makeIdGen())
    expect(result).toBeNull()
    // First call succeeded, second failed — third should never be called
    expect(allocated).toEqual(['Column 5', null])
  })

  it('generateId is not called when allocateName fails on first call', () => {
    let idCalls = 0
    const idGen = () => { idCalls++; return `col-${idCalls}` }
    buildNewColumnDrafts(3, () => null, idGen)
    expect(idCalls).toBe(0)
  })

  it('calls generateId exactly once per draft', () => {
    let idCalls = 0
    const idGen = () => { idCalls++; return `col-${idCalls}` }
    buildNewColumnDrafts(4, makeAllocator(), idGen)
    expect(idCalls).toBe(4)
  })

  it('each draft has a distinct id from generateId', () => {
    const drafts = buildNewColumnDrafts(3, makeAllocator(), makeIdGen())
    const ids = drafts!.map(d => d.id)
    expect(new Set(ids).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// applyColumnExpansion — transactional rollback journal
// ---------------------------------------------------------------------------

describe('applyColumnExpansion', () => {
  /** Build 2 test drafts */
  function twoMockDrafts(): NewColumnDraft[] {
    return [
      { id: 'col-a', name: 'Column 5', type: 'text' },
      { id: 'col-b', name: 'Column 6', type: 'text' },
    ]
  }

  /** Make a happy-path callbacks object (all succeed) */
  function makeHappyCbs(): ColumnExpansionCallbacks & {
    addToBackendCalls: string[]
    addToStoreCalls: Array<[number, string]>
    rollbackBackendCalls: string[]
    rollbackStoreCalls: number[]
    rollbackNameCalls: string[]
  } {
    const addToBackendCalls: string[] = []
    const addToStoreCalls: Array<[number, string]> = []
    const rollbackBackendCalls: string[] = []
    const rollbackStoreCalls: number[] = []
    const rollbackNameCalls: string[] = []
    return {
      addToBackendCalls,
      addToStoreCalls,
      rollbackBackendCalls,
      rollbackStoreCalls,
      rollbackNameCalls,
      addToBackend: vi.fn(async (id) => { addToBackendCalls.push(id) }),
      addToStore: vi.fn((idx, draft) => { addToStoreCalls.push([idx, draft.id]) }),
      rollbackBackend: vi.fn(async (id) => { rollbackBackendCalls.push(id) }),
      rollbackStore: vi.fn((idx) => { rollbackStoreCalls.push(idx) }),
      rollbackName: vi.fn((name) => { rollbackNameCalls.push(name) }),
    }
  }

  it('returns ok:true and calls addToBackend + addToStore for each draft on full success', async () => {
    const cbs = makeHappyCbs()
    const result = await applyColumnExpansion(twoMockDrafts(), 5, cbs)
    expect(result.ok).toBe(true)
    expect(cbs.addToBackendCalls).toEqual(['col-a', 'col-b'])
    expect(cbs.addToStoreCalls).toEqual([[5, 'col-a'], [6, 'col-b']])
    expect(cbs.rollbackBackendCalls).toHaveLength(0)
    expect(cbs.rollbackStoreCalls).toHaveLength(0)
    expect(cbs.rollbackNameCalls).toHaveLength(0)
  })

  it('returns ok:true with empty drafts and calls no callbacks', async () => {
    const cbs = makeHappyCbs()
    const result = await applyColumnExpansion([], 0, cbs)
    expect(result.ok).toBe(true)
    expect(cbs.addToBackendCalls).toHaveLength(0)
  })

  it('when backend fails on first draft: no backend/store rollback needed, names rolled back in reverse', async () => {
    const cbs = makeHappyCbs()
    ;(cbs.addToBackend as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DuckDB fail'))
    const result = await applyColumnExpansion(twoMockDrafts(), 5, cbs)
    expect(result.ok).toBe(false)
    // First backend add failed — nothing was committed
    expect(cbs.rollbackBackendCalls).toHaveLength(0)
    expect(cbs.rollbackStoreCalls).toHaveLength(0)
    // All names rolled back in reverse order (newest-to-oldest)
    expect(cbs.rollbackNameCalls).toEqual(['Column 6', 'Column 5'])
  })

  it('when backend fails on second draft: rolls back backend[0] then store[0], names in reverse', async () => {
    const cbs = makeHappyCbs()
    ;(cbs.addToBackend as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)   // draft 0 backend OK
      .mockRejectedValueOnce(new Error()) // draft 1 backend fails
    const result = await applyColumnExpansion(twoMockDrafts(), 5, cbs)
    expect(result.ok).toBe(false)
    // Backend rollback: draft 0 only (draft 1 backend failed, so not committed)
    expect(cbs.rollbackBackendCalls).toEqual(['col-a'])
    // Store rollback: draft 0 only (draft 1 store was never reached), in reverse
    expect(cbs.rollbackStoreCalls).toEqual([5])
    // Names in reverse order
    expect(cbs.rollbackNameCalls).toEqual(['Column 6', 'Column 5'])
  })

  it('rollback order: backend first (durability), then store, both in reverse-commit order', async () => {
    const callOrder: string[] = []
    const drafts: NewColumnDraft[] = [
      { id: 'col-a', name: 'Column 5', type: 'text' },
      { id: 'col-b', name: 'Column 6', type: 'text' },
      { id: 'col-c', name: 'Column 7', type: 'text' },
    ]
    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (_id) => { /* success */ }),
      addToStore: vi.fn((_idx, _draft) => { /* success */ }),
      // Third backend add fails
      rollbackBackend: vi.fn(async (id) => { callOrder.push(`backend:${id}`) }),
      rollbackStore: vi.fn((idx) => { callOrder.push(`store:${idx}`) }),
      rollbackName: vi.fn((name) => { callOrder.push(`name:${name}`) }),
    }
    ;(cbs.addToBackend as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error())
    await applyColumnExpansion(drafts, 10, cbs)
    // Backend rollback first: col-b, col-a (reverse of committed backends at col-a, col-b)
    // Then store rollback: indices 11, 10 (reverse of committed stores at 10, 11)
    const backendIdx = callOrder.filter(c => c.startsWith('backend:'))
    const storeIdx = callOrder.filter(c => c.startsWith('store:'))
    expect(backendIdx).toEqual(['backend:col-b', 'backend:col-a'])
    expect(storeIdx).toEqual(['store:11', 'store:10'])
    // All backends should come before all stores
    const lastBackend = callOrder.reduce((last, c, i) => c.startsWith('backend:') ? i : last, -1)
    const firstStore = callOrder.findIndex(c => c.startsWith('store:'))
    expect(lastBackend).toBeLessThan(firstStore)
  })

  it('when addToStore throws: rolls back backend first then store, backends before stores in call order', async () => {
    const callOrder: string[] = []
    const drafts: NewColumnDraft[] = [
      { id: 'col-a', name: 'Column 10', type: 'text' },
      { id: 'col-b', name: 'Column 11', type: 'text' },
    ]
    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (_id) => { /* both succeed */ }),
      addToStore: vi.fn()
        .mockImplementationOnce((_idx: number, _draft: NewColumnDraft) => { /* first store succeeds */ })
        .mockImplementationOnce(() => { throw new Error('Zustand invalid state') }),
      rollbackBackend: vi.fn(async (id) => { callOrder.push(`backend:${id}`) }),
      rollbackStore: vi.fn((idx) => { callOrder.push(`store:${idx}`) }),
      rollbackName: vi.fn((_name) => { /* not asserting order here */ }),
    }
    const result = await applyColumnExpansion(drafts, 5, cbs)
    expect(result.ok).toBe(false)
    // Both backends committed; rollback both in reverse
    expect(callOrder.filter(c => c.startsWith('backend:'))).toEqual(['backend:col-b', 'backend:col-a'])
    // Only first store committed; rollback it (at insertBase + 0 = 5)
    expect(callOrder.filter(c => c.startsWith('store:'))).toEqual(['store:5'])
    // All backends must appear before all stores in the call sequence
    const lastBackend = callOrder.reduce((last, c, i) => c.startsWith('backend:') ? i : last, -1)
    const firstStore = callOrder.findIndex(c => c.startsWith('store:'))
    expect(lastBackend).toBeLessThan(firstStore)
  })

  it('names are rolled back in reverse (newest-to-oldest allocation) regardless of failure point', async () => {
    const cbs = makeHappyCbs()
    ;(cbs.addToBackend as ReturnType<typeof vi.fn>).mockRejectedValue(new Error())
    const drafts: NewColumnDraft[] = [
      { id: 'col-a', name: 'Column 10', type: 'text' },
      { id: 'col-b', name: 'Column 11', type: 'text' },
      { id: 'col-c', name: 'Column 12', type: 'text' },
    ]
    await applyColumnExpansion(drafts, 0, cbs)
    expect(cbs.rollbackNameCalls).toEqual(['Column 12', 'Column 11', 'Column 10'])
  })
})

// ---------------------------------------------------------------------------
// decidePasteOverflow — no-dialog expand decision policy
// ---------------------------------------------------------------------------

describe('decidePasteOverflow', () => {
  /** Preflight with no overflow */
  const FIT = computePastePreflight({
    startViewRow: 0, startCol: 0,
    parsedData: makeMatrix(5, 3),
    currentRowCount: 100, currentColCount: 10,
  })

  /** Preflight with small row overflow (≤ threshold) */
  const SMALL_ROW = computePastePreflight({
    startViewRow: 95, startCol: 0,
    parsedData: makeMatrix(10, 3),
    currentRowCount: 100, currentColCount: 10,
  }) // rowOverflow = 5, colOverflow = 0

  /** Preflight with row overflow exactly at threshold */
  const AT_THRESHOLD = computePastePreflight({
    startViewRow: 90, startCol: 0,
    parsedData: makeMatrix(20, 3),
    currentRowCount: 100, currentColCount: 10,
  }) // rowOverflow = 10 (= THRESHOLD), colOverflow = 0

  /** Preflight with large row overflow (> threshold) */
  const LARGE_ROW = computePastePreflight({
    startViewRow: 90, startCol: 0,
    parsedData: makeMatrix(30, 3),
    currentRowCount: 100, currentColCount: 10,
  }) // rowOverflow = 20, colOverflow = 0

  /** Preflight with col overflow only (no row overflow) */
  const COL_ONLY = computePastePreflight({
    startViewRow: 0, startCol: 8,
    parsedData: makeMatrix(5, 5),
    currentRowCount: 100, currentColCount: 10,
  }) // rowOverflow = 0, colOverflow = 3

  /** Preflight with both small row + col overflow */
  const SMALL_ROW_AND_COL = computePastePreflight({
    startViewRow: 98, startCol: 9,
    parsedData: makeMatrix(3, 4),
    currentRowCount: 100, currentColCount: 10,
  }) // rowOverflow = 1, colOverflow = 3

  it('returns within-bounds immediately when fitsInBounds', async () => {
    const result = await decidePasteOverflow(FIT)
    expect(result).toBe('within-bounds')
  })

  it('returns expand when row overflow is present', async () => {
    const result = await decidePasteOverflow(SMALL_ROW)
    expect(result).toBe('expand')
  })

  it('returns expand when row overflow equals the old threshold boundary', async () => {
    const result = await decidePasteOverflow(AT_THRESHOLD)
    expect(result).toBe('expand')
  })

  it('returns expand when row overflow exceeds the old threshold', async () => {
    const result = await decidePasteOverflow(LARGE_ROW)
    expect(result).toBe('expand')
  })

  it('returns expand when column overflow is present, even with small row overflow', async () => {
    const result = await decidePasteOverflow(SMALL_ROW_AND_COL)
    expect(result).toBe('expand')
  })

  it('returns expand when column overflow is present without row overflow', async () => {
    const result = await decidePasteOverflow(COL_ONLY)
    expect(result).toBe('expand')
  })
})

// ---------------------------------------------------------------------------
// applyColumnExpansion — shouldAbort gate (dataset-switch mid-loop protection)
// ---------------------------------------------------------------------------

describe('applyColumnExpansion — shouldAbort gate', () => {
  function threeDrafts(): NewColumnDraft[] {
    return [
      { id: 'col-a', name: 'Column 5', type: 'text' },
      { id: 'col-b', name: 'Column 6', type: 'text' },
      { id: 'col-c', name: 'Column 7', type: 'text' },
    ]
  }

  it('completes successfully when shouldAbort always returns false', async () => {
    const addToBackendCalls: string[] = []
    const addToStoreCalls: Array<[number, string]> = []
    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (id) => { addToBackendCalls.push(id) }),
      addToStore: vi.fn((idx, draft) => { addToStoreCalls.push([idx, draft.id]) }),
      rollbackBackend: vi.fn(async () => {}),
      rollbackStore: vi.fn(() => {}),
      rollbackName: vi.fn(() => {}),
      shouldAbort: () => false,
    }
    const result = await applyColumnExpansion(threeDrafts(), 0, cbs)
    expect(result.ok).toBe(true)
    expect(addToBackendCalls).toEqual(['col-a', 'col-b', 'col-c'])
    expect(addToStoreCalls).toHaveLength(3)
  })

  it('aborts before first backend call when shouldAbort is true from the start', async () => {
    const addToBackendCalls: string[] = []
    const rollbackBackendCalls: string[] = []
    const rollbackNameCalls: string[] = []
    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (id) => { addToBackendCalls.push(id) }),
      addToStore: vi.fn(() => {}),
      rollbackBackend: vi.fn(async (id) => { rollbackBackendCalls.push(id) }),
      rollbackStore: vi.fn(() => {}),
      rollbackName: vi.fn((name) => { rollbackNameCalls.push(name) }),
      shouldAbort: () => true,
    }
    const result = await applyColumnExpansion(threeDrafts(), 0, cbs)
    expect(result.ok).toBe(false)
    expect(addToBackendCalls).toHaveLength(0) // no backend call made
    expect(rollbackBackendCalls).toHaveLength(0) // nothing to roll back
    expect(rollbackNameCalls).toEqual(['Column 7', 'Column 6', 'Column 5']) // names rolled back newest-first
  })

  it('aborts after first backend commit but before first store insert when shouldAbort becomes true after addToBackend resolves', async () => {
    // Simulates: dataset switches DURING the first addToBackend await.
    // shouldAbort is false before the call, true after it resolves.
    const addToStoreCalls: string[] = []
    const rollbackBackendCalls: string[] = []
    const rollbackStoreCalls: number[] = []
    const rollbackNameCalls: string[] = []

    let abortAfterFirstBackend = false
    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (id) => {
        if (id === 'col-a') abortAfterFirstBackend = true // flip during first backend call
      }),
      addToStore: vi.fn((_idx, draft) => { addToStoreCalls.push(draft.id as string) }),
      rollbackBackend: vi.fn(async (id) => { rollbackBackendCalls.push(id) }),
      rollbackStore: vi.fn((idx) => { rollbackStoreCalls.push(idx) }),
      rollbackName: vi.fn((name) => { rollbackNameCalls.push(name) }),
      shouldAbort: () => abortAfterFirstBackend,
    }
    const result = await applyColumnExpansion(threeDrafts(), 5, cbs)
    expect(result.ok).toBe(false)
    // addToStore must NOT have been called — the guard fires after backend but before store
    expect(addToStoreCalls).toHaveLength(0)
    // Backend for col-a was committed; it must be rolled back
    expect(rollbackBackendCalls).toEqual(['col-a'])
    // No store commits to roll back
    expect(rollbackStoreCalls).toHaveLength(0)
    // All names rolled back newest-first
    expect(rollbackNameCalls).toEqual(['Column 7', 'Column 6', 'Column 5'])
  })

  it('aborts before second backend call after first iteration completes (switch between iterations)', async () => {
    const addToBackendCalls: string[] = []
    const addToStoreCalls: string[] = []
    const rollbackBackendCalls: string[] = []
    const rollbackStoreCalls: number[] = []

    const cbs: ColumnExpansionCallbacks = {
      addToBackend: vi.fn(async (id) => { addToBackendCalls.push(id) }),
      addToStore: vi.fn((_idx, draft) => { addToStoreCalls.push(draft.id as string) }),
      rollbackBackend: vi.fn(async (id) => { rollbackBackendCalls.push(id) }),
      rollbackStore: vi.fn((idx) => { rollbackStoreCalls.push(idx) }),
      rollbackName: vi.fn(() => {}),
      // addToStore is sync — addToStoreCalls.length >= 1 only becomes true after
      // the first store insert completes, so gate(a) of i=1 sees it as true.
      // gate(b) of i=0 sees it as false (store hasn't run yet), so the first
      // store insert IS allowed to complete before the abort fires.
      shouldAbort: () => addToStoreCalls.length >= 1,
    }
    const result = await applyColumnExpansion(threeDrafts(), 0, cbs)
    expect(result.ok).toBe(false)
    // Only first backend call was made
    expect(addToBackendCalls).toEqual(['col-a'])
    // First store insert completed before gate(a) of i=1 fired
    expect(addToStoreCalls).toEqual(['col-a'])
    // Backend col-a was committed; must be rolled back
    expect(rollbackBackendCalls).toEqual(['col-a'])
    // Store index 0 was committed; must be rolled back
    expect(rollbackStoreCalls).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// buildNewColumnDrafts — rollback on partial allocation failure (Issue 3)
// ---------------------------------------------------------------------------

describe('buildNewColumnDrafts — rollback on partial failure', () => {
  function makeIdGen(): () => string {
    let n = 0
    return () => `col-test-${n++}`
  }

  it('does not call rollbackName when all allocations succeed', () => {
    const rollback = vi.fn()
    let n = 0
    const allocator = () => `Column ${++n}`
    const result = buildNewColumnDrafts(3, allocator, makeIdGen(), rollback)
    expect(result).not.toBeNull()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('calls rollbackName for first allocated name when second allocation fails', () => {
    const rollback = vi.fn()
    let calls = 0
    const allocator = () => {
      calls++
      if (calls === 2) return null
      return `Column ${calls + 9}`
    }
    const result = buildNewColumnDrafts(3, allocator, makeIdGen(), rollback)
    expect(result).toBeNull()
    // First name ('Column 10') was allocated and must be rolled back
    expect(rollback).toHaveBeenCalledWith('Column 10')
  })

  it('calls rollbackName in reverse order (newest-first) on partial failure', () => {
    const rollbackCalls: string[] = []
    const rollback = vi.fn((name: string) => rollbackCalls.push(name))
    let calls = 0
    // Fail on the 3rd of 4 allocations
    const allocator = () => {
      calls++
      if (calls === 3) return null
      return `Column ${calls + 9}`
    }
    const result = buildNewColumnDrafts(4, allocator, makeIdGen(), rollback)
    expect(result).toBeNull()
    // Names 'Column 10' and 'Column 11' were allocated (calls 1 and 2)
    // Rollback must be newest-first: 'Column 11' then 'Column 10'
    expect(rollbackCalls).toEqual(['Column 11', 'Column 10'])
  })

  it('calls rollbackName with every allocated name when first call fails (zero names to rollback)', () => {
    const rollback = vi.fn()
    const result = buildNewColumnDrafts(3, () => null, makeIdGen(), rollback)
    expect(result).toBeNull()
    // Nothing was allocated before the failure
    expect(rollback).not.toHaveBeenCalled()
  })

  it('works without rollbackName argument (backward compat, no throw on partial failure)', () => {
    let calls = 0
    const allocator = () => {
      calls++
      return calls === 2 ? null : `Column ${calls}`
    }
    // Should not throw even without rollbackName
    expect(() => buildNewColumnDrafts(3, allocator, makeIdGen())).not.toThrow()
    const result = buildNewColumnDrafts(3, () => null, makeIdGen())
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveTransformAwareRowCap — clamps effectiveRowCap to rowOrderLength
// when a view transform (sort/filter/group) is active (Issue 2)
// ---------------------------------------------------------------------------

describe('resolveTransformAwareRowCap', () => {
  it('returns effectiveRowCap unchanged when no transform is active', () => {
    expect(resolveTransformAwareRowCap(100, 50, false)).toBe(100)
  })

  it('clamps effectiveRowCap to rowOrderLength when transform is active and rowOrder is shorter', () => {
    // Filter active: 50 rows visible out of 100 model rows.
    // Paste cap is 100 but viewRows 50-99 have no rowOrder entry → must clamp to 50.
    expect(resolveTransformAwareRowCap(100, 50, true)).toBe(50)
  })

  it('returns effectiveRowCap unchanged when transform is active but rowOrder covers all rows', () => {
    // rowOrderLength >= effectiveRowCap: no clamping needed
    expect(resolveTransformAwareRowCap(50, 100, true)).toBe(50)
  })

  it('returns effectiveRowCap when transform active and rowOrder exactly equals cap', () => {
    expect(resolveTransformAwareRowCap(80, 80, true)).toBe(80)
  })

  it('returns 0 when rowOrderLength is 0 and transform is active', () => {
    // Empty filtered view — nothing to paste into
    expect(resolveTransformAwareRowCap(100, 0, true)).toBe(0)
  })

  it('is a no-op when effectiveRowCap is 0 regardless of transform', () => {
    expect(resolveTransformAwareRowCap(0, 100, true)).toBe(0)
    expect(resolveTransformAwareRowCap(0, 0, false)).toBe(0)
  })
})

describe('computeDataRowCountPromotion', () => {
  it('returns null when edited row is below dataRowCount (no promotion needed)', () => {
    // Row 3 edited, dataRowCount is 10 → already a data row, no promotion
    expect(computeDataRowCountPromotion(3, 10)).toBeNull()
  })

  it('returns maxEditedRowIndex + 1 when edited row equals dataRowCount (first buffer row)', () => {
    // dataRowCount=10: row 10 is the first buffer row — promote to 11 data rows
    expect(computeDataRowCountPromotion(10, 10)).toBe(11)
  })

  it('returns maxEditedRowIndex + 1 when edited row is beyond dataRowCount', () => {
    // Row 15 edited, dataRowCount=10 → promote to 16
    expect(computeDataRowCountPromotion(15, 10)).toBe(16)
  })

  it('returns 1 when editing row 0 in an empty dataset (dataRowCount=0)', () => {
    expect(computeDataRowCountPromotion(0, 0)).toBe(1)
  })

  it('returns null when edited row is row 0 and dataRowCount is already 1', () => {
    // Row 0 is already a data row — no promotion
    expect(computeDataRowCountPromotion(0, 1)).toBeNull()
  })
})

