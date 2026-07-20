/**
 * Formula Persistence Tests - Phase 7
 *
 * Tests that formulas + computed values survive .ecp project save/load round-trip.
 * Validates the complete persistence loop without touching Tauri backend.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useDataStore } from '@/store/data-store'
import type { Dataset } from '@/store/data-store'
import { createFormulaService } from '@/lib/grid/formulas/formulaService'

describe('Formula Persistence - Project Save/Load', () => {
  beforeEach(() => {
    // Reset data store before each test
    const { clearAllDatasets } = useDataStore.getState()
    clearAllDatasets()
  })

  it('should persist formulas across project save/load cycle', () => {
    // Step 1: Create a dataset with some data
    const dataset: Dataset = {
      id: 'test-dataset-1',
      name: 'Test Dataset',
      rowCount: 100,
      columnCount: 3,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
        { id: 'col-c', name: 'C', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const { addDataset, setCacheData, setDatasetFormulas, getDatasetFormulas } = useDataStore.getState()
    addDataset(dataset)

    // Step 2: Set up rowData with values in columns A and B
    const rowData = new Map<number, Record<string, unknown>>([
      [0, { 'col-a': 10, 'col-b': 20, 'col-c': 0 }],
      [1, { 'col-a': 5, 'col-b': 15, 'col-c': 0 }],
      [2, { 'col-a': 8, 'col-b': 12, 'col-c': 0 }],
    ])

    setCacheData(`dataset:${dataset.id}`, Array.from({ length: 100 }, (_, i) => rowData.get(i) || {}))

    // Step 3: Create FormulaService and register formulas
    const formulaService = createFormulaService(() => rowData, dataset.columns)

    // Register formulas:
    // - C1: =1+1 (simple arithmetic)
    // - C2: =A2*2 (cell reference with arithmetic)
    // - C3: =SUM(A1:A3) (range function)
    const formulas = new Map<string, string>([
      ['0:col-c', '=1+1'],
      ['1:col-c', '=A2*2'],
      ['2:col-c', '=SUM(A1:A3)'],
    ])

    const formulaEdits = formulaService.setFormulas(formulas)

    // Apply computed values to rowData
    for (const edit of formulaEdits) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Step 4: Sync formulas to persistence layer (simulating what SpreadsheetView does)
    const allFormulas = formulaService.getAllFormulas()
    setDatasetFormulas(dataset.id, allFormulas)

    // Verify initial state
    expect(rowData.get(0)?.['col-c']).toBe(2) // =1+1
    expect(rowData.get(1)?.['col-c']).toBe(10) // =5*2
    expect(rowData.get(2)?.['col-c']).toBe(23) // =SUM(10,5,8)

    // Step 5: Simulate project save - get formulas from store
    const savedFormulas = getDatasetFormulas(dataset.id)
    expect(savedFormulas.size).toBe(3)
    expect(savedFormulas.get('0:col-c')).toBe('=1+1')
    expect(savedFormulas.get('1:col-c')).toBe('=A2*2')
    expect(savedFormulas.get('2:col-c')).toBe('=SUM(A1:A3)')

    // Step 6: Simulate project load - clear current state
    formulaService.clear()
    rowData.clear()
    rowData.set(0, { 'col-a': 10, 'col-b': 20, 'col-c': 0 })
    rowData.set(1, { 'col-a': 5, 'col-b': 15, 'col-c': 0 })
    rowData.set(2, { 'col-a': 8, 'col-b': 12, 'col-c': 0 })

    // Step 7: Restore formulas from saved state (simulating what SpreadsheetView does on mount)
    const restoredFormulas = savedFormulas
    const restoredEdits = formulaService.setFormulas(restoredFormulas)

    // Apply computed values
    for (const edit of restoredEdits) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Step 8: Verify restored state
    expect(rowData.get(0)?.['col-c']).toBe(2) // =1+1
    expect(rowData.get(1)?.['col-c']).toBe(10) // =5*2
    expect(rowData.get(2)?.['col-c']).toBe(23) // =SUM(10,5,8)

    // Verify formulas are restored in FormulaService
    const restoredFormulasFromService = formulaService.getAllFormulas()
    expect(restoredFormulasFromService.size).toBe(3)
    expect(restoredFormulasFromService.get('0:col-c')).toBe('=1+1')
    expect(restoredFormulasFromService.get('1:col-c')).toBe('=A2*2')
    expect(restoredFormulasFromService.get('2:col-c')).toBe('=SUM(A1:A3)')
  })

  it('should preserve formula dependencies after load', () => {
    // Create dataset
    const dataset: Dataset = {
      id: 'test-dataset-2',
      name: 'Dependency Test',
      rowCount: 100,
      columnCount: 3,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
        { id: 'col-c', name: 'C', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const { addDataset, setDatasetFormulas, getDatasetFormulas } = useDataStore.getState()
    addDataset(dataset)

    const rowData = new Map<number, Record<string, unknown>>([
      [0, { 'col-a': 10, 'col-b': 0, 'col-c': 0 }],
    ])

    // Create formulas with dependencies: B1 = A1*2, C1 = B1+5
    // Note: Register formulas in dependency order to ensure correct evaluation
    const formulaService = createFormulaService(() => rowData, dataset.columns)

    // Register B1 first
    const formulas1 = new Map<string, string>([['0:col-b', '=A1*2']])
    const edits1 = formulaService.setFormulas(formulas1)
    for (const edit of edits1) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Then register C1 (which depends on B1's computed value)
    const formulas2 = new Map<string, string>([['0:col-c', '=B1+5']])
    const edits2 = formulaService.setFormulas(formulas2)
    for (const edit of edits2) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Initial values: A1=10, B1=20, C1=25
    expect(rowData.get(0)?.['col-b']).toBe(20)
    expect(rowData.get(0)?.['col-c']).toBe(25)

    // Save formulas
    setDatasetFormulas(dataset.id, formulaService.getAllFormulas())
    const savedFormulas = getDatasetFormulas(dataset.id)

    // Simulate reload
    formulaService.clear()
    rowData.set(0, { 'col-a': 10, 'col-b': 0, 'col-c': 0 })

    // Restore formulas - need to apply in two passes due to dependency chain
    // In real SpreadsheetView, the dependency graph handles this automatically during recalculation
    // but initial load needs the values applied before dependent formulas evaluate
    const restoredEdits = formulaService.setFormulas(savedFormulas)
    for (const edit of restoredEdits) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Trigger recalculation of C1 since it depends on B1's computed value
    const dependentEdits = formulaService.recalculateDependents('0:col-b')
    for (const edit of dependentEdits) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // Verify restored values
    expect(rowData.get(0)?.['col-b']).toBe(20)
    expect(rowData.get(0)?.['col-c']).toBe(25)

    // Test dependency recalculation: change A1 → should recalc B1 and C1
    rowData.set(0, { 'col-a': 15, 'col-b': 20, 'col-c': 25 })

    const recalcEdits = formulaService.recalculateDependents('0:col-a')
    for (const edit of recalcEdits) {
      const row = rowData.get(edit.row) || {}
      rowData.set(edit.row, { ...row, [edit.columnId]: edit.computedValue })
    }

    // A1=15 → B1=30 → C1=35
    expect(rowData.get(0)?.['col-b']).toBe(30)
    expect(rowData.get(0)?.['col-c']).toBe(35)
  })

  it('should handle empty formula state on new dataset', () => {
    const dataset: Dataset = {
      id: 'test-dataset-3',
      name: 'Empty Dataset',
      rowCount: 100,
      columnCount: 3,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
        { id: 'col-c', name: 'C', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const { addDataset, getDatasetFormulas } = useDataStore.getState()
    addDataset(dataset)

    // New dataset should have no formulas
    const formulas = getDatasetFormulas(dataset.id)
    expect(formulas.size).toBe(0)
  })

  it('should clean up formulas when dataset is removed', () => {
    const dataset: Dataset = {
      id: 'test-dataset-4',
      name: 'Cleanup Test',
      rowCount: 100,
      columnCount: 2,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const { addDataset, setDatasetFormulas, getDatasetFormulas, removeDataset } = useDataStore.getState()
    addDataset(dataset)

    // Add some formulas
    const formulas = new Map<string, string>([['0:col-b', '=A1*2']])
    setDatasetFormulas(dataset.id, formulas)

    expect(getDatasetFormulas(dataset.id).size).toBe(1)

    // Remove dataset
    removeDataset(dataset.id)

    // Formulas should be cleaned up
    expect(getDatasetFormulas(dataset.id).size).toBe(0)
  })

  it('should handle multiple datasets with separate formulas', () => {
    const dataset1: Dataset = {
      id: 'dataset-1',
      name: 'Dataset 1',
      rowCount: 100,
      columnCount: 2,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const dataset2: Dataset = {
      id: 'dataset-2',
      name: 'Dataset 2',
      rowCount: 100,
      columnCount: 2,
      columns: [
        { id: 'col-a', name: 'A', type: 'numeric', width: 88 },
        { id: 'col-b', name: 'B', type: 'numeric', width: 88 },
      ],
      importedAt: new Date(),
      modifiedAt: new Date(),
    }

    const { addDataset, setDatasetFormulas, getDatasetFormulas } = useDataStore.getState()
    addDataset(dataset1)
    addDataset(dataset2)

    // Set different formulas for each dataset
    const formulas1 = new Map<string, string>([['0:col-b', '=A1*2']])
    const formulas2 = new Map<string, string>([['0:col-b', '=A1+10']])

    setDatasetFormulas(dataset1.id, formulas1)
    setDatasetFormulas(dataset2.id, formulas2)

    // Verify each dataset has its own formulas
    expect(getDatasetFormulas(dataset1.id).get('0:col-b')).toBe('=A1*2')
    expect(getDatasetFormulas(dataset2.id).get('0:col-b')).toBe('=A1+10')

    // Verify they don't interfere
    expect(getDatasetFormulas(dataset1.id).size).toBe(1)
    expect(getDatasetFormulas(dataset2.id).size).toBe(1)
  })
})
