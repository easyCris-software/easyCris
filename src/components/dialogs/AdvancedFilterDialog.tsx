/**
 * Advanced Filter Dialog
 *
 * Filter rows with multiple conditions (AND/OR logic)
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogFooter,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { X, Plus, Lightbulb, AlertCircle, Code2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FilterConfig, FilterCondition, FilterGroup } from '@/services/dataTransformService'
import type { ColumnMetadata } from '@/store/data-store'
import DataTransformService from '@/services/dataTransformService'

interface AdvancedFilterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnMetadata: ColumnMetadata[]
  data?: Record<string, any>[]
  totalRowCount?: number
  getColumnUniqueValues?: (columnId: string) => Promise<unknown[]>
  getFilterMatchCount?: (config: FilterConfig) => Promise<{ count: number; totalRows?: number } | number | null>
  onApply: (config: FilterConfig | null) => void
  initialConfig?: FilterConfig | null
}

type OperatorType = FilterCondition['operator']
type GroupHintKind = 'duplicate' | 'contradiction'

interface GroupHint {
  kind: GroupHintKind
  text: string
}

const OPERATORS: Array<{ value: OperatorType; label: string; needsValue: boolean }> = [
  { value: 'eq', label: 'equals (=)', needsValue: true },
  { value: 'ne', label: 'not equals (≠)', needsValue: true },
  { value: 'gt', label: 'greater than (>)', needsValue: true },
  { value: 'gte', label: 'greater or equal (≥)', needsValue: true },
  { value: 'lt', label: 'less than (<)', needsValue: true },
  { value: 'lte', label: 'less or equal (≤)', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'endsWith', label: 'ends with', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false },
  { value: 'regex', label: 'matches regex', needsValue: true },
]

const OPERATORS_NEEDING_VALUE = new Set(
  OPERATORS.filter((op) => op.needsValue).map((op) => op.value)
)

const OPERATOR_SYMBOLS: Record<OperatorType, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  regex: 'matches',
}

const NUMERIC_OPERATORS = new Set<OperatorType>(['gt', 'gte', 'lt', 'lte'])

function normalizeConditionValue(
  condition: FilterCondition,
  options?: { respectCase?: boolean }
): string {
  const respectCase = options?.respectCase ?? true
  const raw = condition.value ?? ''
  const text = String(raw).trim()
  if (!respectCase) {
    return text.toLowerCase()
  }
  if (condition.caseSensitive === false) {
    return text.toLowerCase()
  }
  return text
}

function toNumericValue(value: unknown): number | null {
  const candidate = typeof value === 'string' ? value.trim() : value
  const parsed = Number(candidate)
  return Number.isFinite(parsed) ? parsed : null
}

function createEmptyCondition(): FilterCondition {
  return {
    columnId: '',
    operator: 'eq',
    value: '',
    caseSensitive: false,
  }
}

function createEmptyGroup(): FilterGroup {
  return {
    op: 'AND',
    conditions: [createEmptyCondition()],
  }
}

function normalizeUniqueValues(values: unknown[]): Array<string | number> {
  const seen = new Set<string>()
  const result: Array<string | number> = []
  for (const raw of values) {
    const value = raw == null ? '' : typeof raw === 'number' ? raw : String(raw)
    const key = `${typeof value}:${String(value)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
}

type UniqueValueLoadState = {
  values: Array<string | number>
  truncated: boolean
  loading: boolean
  error?: string | null
}

type FilterMatchCountState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; count: number }

export function AdvancedFilterDialog({
  open,
  onOpenChange,
  columnMetadata,
  data = [],
  getColumnUniqueValues,
  getFilterMatchCount,
  onApply,
  initialConfig,
}: AdvancedFilterDialogProps) {
  const [groups, setGroups] = useState<FilterGroup[]>([createEmptyGroup()])
  const [groupOperator, setGroupOperator] = useState<'AND' | 'OR'>('AND')
  const [showGuide, setShowGuide] = useState(true)
  const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set())
  const [loadedUniqueValues, setLoadedUniqueValues] = useState(new Map<string, UniqueValueLoadState>())
  const [matchCountState, setMatchCountState] = useState<FilterMatchCountState>({ status: 'idle' })
  const loadedUniqueValuesRef = useRef(new Map<string, UniqueValueLoadState>())
  const columnRequestSeqRef = useRef(new Map<string, number>())
  const matchCountRequestSeqRef = useRef(0)
  const matchCountDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dialogOpenRef = useRef(open)
  dialogOpenRef.current = open
  const updateLoadedUniqueValues = useCallback((updater: (prev: Map<string, UniqueValueLoadState>) => Map<string, UniqueValueLoadState>) => {
    setLoadedUniqueValues((prev) => {
      const next = updater(prev)
      loadedUniqueValuesRef.current = next
      return next
    })
  }, [])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      if (initialConfig && Array.isArray(initialConfig.groups) && initialConfig.groups.length > 0) {
        const availableIds = new Set(columnMetadata.map((col) => col.id))
        const normalizedGroups = initialConfig.groups.map((group) => ({
          op: group.op ?? 'AND',
          conditions: group.conditions.length > 0
            ? group.conditions.map((condition) => ({
              ...condition,
              columnId: availableIds.has(condition.columnId) ? condition.columnId : '',
              value: condition.value ?? '',
              caseSensitive: condition.caseSensitive ?? false,
            }))
            : [createEmptyCondition()],
        }))
        setGroups(normalizedGroups)
        setGroupOperator(initialConfig.groupOperator ?? 'AND')
      } else {
        setGroups([createEmptyGroup()])
        setGroupOperator('AND')
      }
      setValidationErrors(new Set())
      setMatchCountState({ status: 'idle' })
      const empty = new Map<string, UniqueValueLoadState>()
      loadedUniqueValuesRef.current = empty
      setLoadedUniqueValues(empty)
      for (const [columnId, requestSeq] of columnRequestSeqRef.current.entries()) {
        columnRequestSeqRef.current.set(columnId, requestSeq + 1)
      }
    }
  }, [open, initialConfig, columnMetadata])

  useEffect(() => {
    return () => {
      if (matchCountDebounceRef.current) {
        clearTimeout(matchCountDebounceRef.current)
      }
    }
  }, [])

  // Sample fallback only. Full-column Quick values are loaded lazily per selected column.
  const sampleUniqueValues = useMemo(() => {
    if (getColumnUniqueValues || !data.length) {
      return new Map<string, { values: Array<string | number>; truncated: boolean }>()
    }

    const valuesMap = new Map<string, { values: Array<string | number>; truncated: boolean }>()

    for (const col of columnMetadata) {
      try {
        const uniqueVals = DataTransformService.getUniqueValues(data, col.id)
        const truncated = uniqueVals.length > 20
        valuesMap.set(col.id, { values: uniqueVals.slice(0, 20), truncated })
      } catch (error) {
        console.warn(`Failed to get unique values for ${col.name}:`, error)
      }
    }

    return valuesMap
  }, [data, columnMetadata])

  const selectedValueColumnIds = useMemo(() => {
    const ids = new Set<string>()
    const availableIds = new Set(columnMetadata.map((col) => col.id))
    for (const group of groups) {
      for (const condition of group.conditions) {
        if (
          condition.columnId &&
          availableIds.has(condition.columnId) &&
          OPERATORS_NEEDING_VALUE.has(condition.operator)
        ) {
          ids.add(condition.columnId)
        }
      }
    }
    return Array.from(ids)
  }, [groups, columnMetadata])

  useEffect(() => {
    if (!open || !getColumnUniqueValues) return

    for (const columnId of selectedValueColumnIds) {
      const existing = loadedUniqueValuesRef.current.get(columnId)
      if (existing && (existing.loading || existing.values.length > 0 || existing.error)) continue

      const requestSeq = (columnRequestSeqRef.current.get(columnId) ?? 0) + 1
      columnRequestSeqRef.current.set(columnId, requestSeq)

      updateLoadedUniqueValues((prev) => {
        const next = new Map(prev)
        next.set(columnId, { values: prev.get(columnId)?.values ?? [], truncated: false, loading: true, error: null })
        return next
      })

      void getColumnUniqueValues(columnId)
        .then((values) => {
          if (!dialogOpenRef.current || columnRequestSeqRef.current.get(columnId) !== requestSeq) return
          const uniqueValues = normalizeUniqueValues(values)
          const truncated = uniqueValues.length > 20
          updateLoadedUniqueValues((prev) => {
            const next = new Map(prev)
            next.set(columnId, { values: uniqueValues.slice(0, 20), truncated, loading: false, error: null })
            return next
          })
        })
        .catch((error) => {
          if (!dialogOpenRef.current || columnRequestSeqRef.current.get(columnId) !== requestSeq) return
          console.warn(`Failed to load unique values for column ${columnId}:`, error)
          updateLoadedUniqueValues((prev) => {
            const next = new Map(prev)
            next.set(columnId, {
              values: [],
              truncated: false,
              loading: false,
              error: 'Full-column quick values are unavailable.',
            })
            return next
          })
        })
    }
  }, [open, getColumnUniqueValues, selectedValueColumnIds, updateLoadedUniqueValues])

  const hasValidFilterConditions = useMemo(() => {
    return groups.every((group) =>
      group.conditions.every((cond) => {
        if (!cond.columnId) return false
        if (OPERATORS_NEEDING_VALUE.has(cond.operator) && cond.value === '') return false
        return true
      })
    )
  }, [groups])

  useEffect(() => {
    if (matchCountDebounceRef.current) {
      clearTimeout(matchCountDebounceRef.current)
      matchCountDebounceRef.current = null
    }
    if (!open || !getFilterMatchCount || !hasValidFilterConditions) {
      matchCountRequestSeqRef.current += 1
      setMatchCountState({ status: 'idle' })
      return
    }

    const requestSeq = ++matchCountRequestSeqRef.current
    const config: FilterConfig = { groups, groupOperator }
    matchCountDebounceRef.current = setTimeout(() => {
      if (!dialogOpenRef.current || matchCountRequestSeqRef.current !== requestSeq) return
      setMatchCountState({ status: 'loading' })
      void getFilterMatchCount(config)
        .then((result) => {
          if (!dialogOpenRef.current || matchCountRequestSeqRef.current !== requestSeq) return
          const count = typeof result === 'number' ? result : result?.count
          if (typeof count !== 'number' || !Number.isFinite(count)) {
            setMatchCountState({ status: 'idle' })
            return
          }
          setMatchCountState({ status: 'ready', count })
        })
        .catch((error) => {
          if (!dialogOpenRef.current || matchCountRequestSeqRef.current !== requestSeq) return
          console.warn('Failed to count advanced filter matches:', error)
          setMatchCountState({ status: 'idle' })
        })
    }, 300)
  }, [open, getFilterMatchCount, hasValidFilterConditions, groups, groupOperator])

  // Build a column-name lookup for expression rendering
  const columnNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columnMetadata) {
      map.set(col.id, col.name)
    }
    return map
  }, [columnMetadata])

  // Build the live parenthesized expression preview
  const expressionElements = useMemo(() => {
    const hasContent = groups.some((g) =>
      g.conditions.some((c) => c.columnId || c.value)
    )
    if (!hasContent) return null

    const elements: React.ReactNode[] = []

    const renderCondition = (condition: FilterCondition, key: string) => {
      const colName = condition.columnId
        ? columnNameById.get(condition.columnId) ?? '?'
        : '?'
      const opSymbol = OPERATOR_SYMBOLS[condition.operator] ?? condition.operator
      const needsVal = OPERATORS_NEEDING_VALUE.has(condition.operator)

      return (
        <span key={key} className="inline-flex items-baseline gap-1">
          <span className="text-blue-600 dark:text-blue-400 font-medium">{colName}</span>
          <span className="text-gray-500 dark:text-gray-400">{opSymbol}</span>
          {needsVal && (
            <span className="text-emerald-600 dark:text-emerald-400">
              {condition.value !== '' ? `"${condition.value}"` : '?'}
            </span>
          )}
        </span>
      )
    }

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]
      if (!group) continue

      // Add group operator between groups
      if (gi > 0) {
        elements.push(
          <span
            key={`gop-${gi}`}
            className="text-orange-600 dark:text-orange-400 font-bold mx-1.5"
          >
            {groupOperator}
          </span>
        )
      }

      const useParens = groups.length > 1 || group.conditions.length > 1
      if (useParens) {
        elements.push(
          <span key={`lp-${gi}`} className="text-gray-400 dark:text-gray-500 font-bold">
            (
          </span>
        )
      }

      for (let ci = 0; ci < group.conditions.length; ci++) {
        const condition = group.conditions[ci]
        if (!condition) continue

        if (ci > 0) {
          elements.push(
            <span
              key={`cop-${gi}-${ci}`}
              className="text-purple-600 dark:text-purple-400 font-semibold mx-1"
            >
              {group.op}
            </span>
          )
        }

        elements.push(renderCondition(condition, `cond-${gi}-${ci}`))
      }

      if (useParens) {
        elements.push(
          <span key={`rp-${gi}`} className="text-gray-400 dark:text-gray-500 font-bold">
            )
          </span>
        )
      }
    }

    return elements
  }, [groups, groupOperator, columnNameById])

  const groupHints = useMemo<GroupHint[][]>(() => {
    return groups.map((group) => {
      const hints: GroupHint[] = []
      const readyConditions = group.conditions.filter((condition) => {
        if (!condition.columnId) return false
        if (OPERATORS_NEEDING_VALUE.has(condition.operator) && condition.value === '') return false
        return true
      })

      if (readyConditions.length === 0) {
        return hints
      }

      const describeCondition = (condition: FilterCondition) => {
        const columnName = columnNameById.get(condition.columnId) ?? condition.columnId
        const symbol = OPERATOR_SYMBOLS[condition.operator] ?? condition.operator
        if (!OPERATORS_NEEDING_VALUE.has(condition.operator)) {
          return `${columnName} ${symbol}`
        }
        return `${columnName} ${symbol} "${String(condition.value ?? '')}"`
      }

      // Exact duplicates in the same group (non-blocking hint).
      const duplicateMap = new Map<string, { count: number; label: string }>()
      for (const condition of readyConditions) {
        const valueToken = OPERATORS_NEEDING_VALUE.has(condition.operator)
          ? normalizeConditionValue(condition, { respectCase: true })
          : ''
        const duplicateKey = [
          condition.columnId,
          condition.operator,
          condition.caseSensitive ? 'case' : 'nocase',
          valueToken,
        ].join('|')
        const entry = duplicateMap.get(duplicateKey)
        if (entry) {
          entry.count += 1
        } else {
          duplicateMap.set(duplicateKey, { count: 1, label: describeCondition(condition) })
        }
      }
      const duplicateLabels = Array.from(duplicateMap.values())
        .filter((entry) => entry.count > 1)
        .map((entry) => entry.label)
      if (duplicateLabels.length > 0) {
        const preview = duplicateLabels.slice(0, 2).join('; ')
        const suffix = duplicateLabels.length > 2 ? '; ...' : ''
        hints.push({
          kind: 'duplicate',
          text: `Duplicate condition(s) detected: ${preview}${suffix}.`,
        })
      }

      // Contradictions only make sense for AND logic inside a group.
      if (group.op !== 'AND') {
        return hints
      }

      const byColumn = new Map<string, FilterCondition[]>()
      for (const condition of readyConditions) {
        const existing = byColumn.get(condition.columnId)
        if (existing) {
          existing.push(condition)
        } else {
          byColumn.set(condition.columnId, [condition])
        }
      }

      for (const [columnId, conditions] of byColumn.entries()) {
        const columnName = columnNameById.get(columnId) ?? columnId
        const contradictionMessages = new Set<string>()

        const eqValues = new Set<string>()
        const neValues = new Set<string>()
        let hasIsEmpty = false
        let hasIsNotEmpty = false

        let lowerBound: { value: number; inclusive: boolean } | null = null
        let upperBound: { value: number; inclusive: boolean } | null = null

        for (const condition of conditions) {
          if (condition.operator === 'eq') {
            eqValues.add(normalizeConditionValue(condition, { respectCase: false }))
          } else if (condition.operator === 'ne') {
            neValues.add(normalizeConditionValue(condition, { respectCase: false }))
          } else if (condition.operator === 'isEmpty') {
            hasIsEmpty = true
          } else if (condition.operator === 'isNotEmpty') {
            hasIsNotEmpty = true
          }

          if (NUMERIC_OPERATORS.has(condition.operator)) {
            const numericValue = toNumericValue(condition.value)
            if (numericValue === null) continue
            if (condition.operator === 'gt' || condition.operator === 'gte') {
              const candidate = { value: numericValue, inclusive: condition.operator === 'gte' }
              if (
                !lowerBound ||
                candidate.value > lowerBound.value ||
                (candidate.value === lowerBound.value && !candidate.inclusive && lowerBound.inclusive)
              ) {
                lowerBound = candidate
              }
            } else if (condition.operator === 'lt' || condition.operator === 'lte') {
              const candidate = { value: numericValue, inclusive: condition.operator === 'lte' }
              if (
                !upperBound ||
                candidate.value < upperBound.value ||
                (candidate.value === upperBound.value && !candidate.inclusive && upperBound.inclusive)
              ) {
                upperBound = candidate
              }
            }
          }
        }

        if (eqValues.size > 1) {
          contradictionMessages.add(
            `"${columnName}" has multiple equals values in an AND group.`
          )
        }
        for (const value of eqValues) {
          if (neValues.has(value)) {
            contradictionMessages.add(
              `"${columnName}" is required to both equal and not equal "${value}".`
            )
          }
        }
        if (hasIsEmpty && hasIsNotEmpty) {
          contradictionMessages.add(
            `"${columnName}" is required to be both empty and not empty.`
          )
        }
        if (lowerBound && upperBound) {
          if (lowerBound.value > upperBound.value) {
            contradictionMessages.add(
              `"${columnName}" has an impossible numeric range.`
            )
          } else if (
            lowerBound.value === upperBound.value &&
            (!lowerBound.inclusive || !upperBound.inclusive)
          ) {
            contradictionMessages.add(
              `"${columnName}" has an impossible numeric range at ${lowerBound.value}.`
            )
          }
        }
        if (eqValues.size === 1 && (lowerBound || upperBound)) {
          const eqNumeric = toNumericValue(Array.from(eqValues)[0])
          if (eqNumeric !== null) {
            if (
              lowerBound &&
              (eqNumeric < lowerBound.value ||
                (eqNumeric === lowerBound.value && !lowerBound.inclusive))
            ) {
              contradictionMessages.add(
                `"${columnName}" equals ${eqNumeric} conflicts with lower-bound condition(s).`
              )
            }
            if (
              upperBound &&
              (eqNumeric > upperBound.value ||
                (eqNumeric === upperBound.value && !upperBound.inclusive))
            ) {
              contradictionMessages.add(
                `"${columnName}" equals ${eqNumeric} conflicts with upper-bound condition(s).`
              )
            }
          }
        }

        contradictionMessages.forEach((text) => {
          hints.push({ kind: 'contradiction', text })
        })
      }

      return hints
    })
  }, [groups, columnNameById])

  const validateCondition = useCallback(
    (groupIndex: number, conditionIndex: number, condition: FilterCondition): string | null => {
      if (!condition.columnId) {
        return `g${groupIndex}-c${conditionIndex}-column`
      }
      if (OPERATORS_NEEDING_VALUE.has(condition.operator) && condition.value === '') {
        return `g${groupIndex}-c${conditionIndex}-value`
      }
      return null
    },
    []
  )

  const handleApply = useCallback(() => {
    // Validate all conditions
    const errors = new Set<string>()
    let hasErrors = false

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]
      if (!group) continue
      for (let ci = 0; ci < group.conditions.length; ci++) {
        const cond = group.conditions[ci]
        if (!cond) continue
        const error = validateCondition(gi, ci, cond)
        if (error) {
          errors.add(error)
          hasErrors = true
        }
      }
    }

    setValidationErrors(errors)

    if (hasErrors) {
      toast.error('Please fill in all required fields', {
        description: 'Each condition needs a column selected and a value (unless using is empty/not empty).',
      })
      return
    }

    const config: FilterConfig = { groups, groupOperator }
    onApply(config)
    onOpenChange(false)
  }, [groups, groupOperator, onApply, onOpenChange, validateCondition])

  const handleReset = useCallback(() => {
    setGroups([createEmptyGroup()])
    setGroupOperator('AND')
    setValidationErrors(new Set())
  }, [])

  const addGroup = useCallback(() => {
    setGroups((prev) => [...prev, createEmptyGroup()])
  }, [])

  const removeGroup = useCallback((groupIndex: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== groupIndex))
  }, [])

  const addCondition = useCallback((groupIndex: number) => {
    setGroups((prev) => {
      const next = [...prev]
      const group = next[groupIndex]
      if (!group) return prev
      next[groupIndex] = {
        ...group,
        conditions: [...group.conditions, createEmptyCondition()],
      }
      return next
    })
  }, [])

  const removeCondition = useCallback((groupIndex: number, conditionIndex: number) => {
    setGroups((prev) => {
      const next = [...prev]
      const group = next[groupIndex]
      if (!group) return prev
      next[groupIndex] = {
        ...group,
        conditions: group.conditions.filter((_, i) => i !== conditionIndex),
      }
      return next
    })
  }, [])

  const updateGroupOp = useCallback((groupIndex: number, op: 'AND' | 'OR') => {
    setGroups((prev) => {
      const next = [...prev]
      const group = next[groupIndex]
      if (!group) return prev
      next[groupIndex] = { ...group, op }
      return next
    })
  }, [])

  const updateCondition = useCallback(
    (groupIndex: number, conditionIndex: number, field: keyof FilterCondition, value: any) => {
      setGroups((prev) => {
        const next = [...prev]
        const group = next[groupIndex]
        if (!group) return prev
        const conditions = [...group.conditions]
        const condition = conditions[conditionIndex]
        if (!condition) return prev

        // Create new condition with updated field
        const normalizedValue =
          field === 'value' && (value === null || value === undefined) ? '' : value
        const updated = { ...condition, [field]: normalizedValue }

        // Clear value if switching to an operator that doesn't need it
        if (field === 'operator' && !OPERATORS_NEEDING_VALUE.has(value as OperatorType)) {
          updated.value = ''
        }

        conditions[conditionIndex] = updated
        next[groupIndex] = { ...group, conditions }
        return next
      })

      // Clear validation error for this field
      setValidationErrors((prev) => {
        const next = new Set(prev)
        next.delete(`g${groupIndex}-c${conditionIndex}-column`)
        next.delete(`g${groupIndex}-c${conditionIndex}-value`)
        return next
      })
    },
    []
  )

  const operatorNeedsValue = useCallback((operator: OperatorType): boolean => {
    return OPERATORS_NEEDING_VALUE.has(operator)
  }, [])

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={900}
      defaultHeight={700}
      minWidth={700}
      minHeight={560}
      persistKey="advanced-filter"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b">
          <ResizableDialogTitle>Advanced Filter</ResizableDialogTitle>
          <ResizableDialogDescription>
            Filter rows with multiple conditions using AND/OR logic.
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Visual Guide */}
          {showGuide && (
            <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">How it works</p>
                    <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                      <p><strong>Within a group:</strong> Choose AND (all match) or OR (any match)</p>
                      <p><strong>Between groups:</strong> Choose how to combine groups at the top</p>
                      <p className="text-blue-700 dark:text-blue-400 pt-1">Tip: Click values below inputs for quick fill. Use "is empty" to find blanks.</p>
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowGuide(false)}
                  className="h-6 w-6 p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Top-level group operator */}
          {groups.length > 1 && (
            <div className="flex items-center gap-2 px-1">
              <Label className="text-sm">Combine groups with:</Label>
              <Select
                value={groupOperator}
                onValueChange={(value) => setGroupOperator(value as 'AND' | 'OR')}
              >
                <SelectTrigger className="w-24 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AND">AND</SelectItem>
                  <SelectItem value="OR">OR</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {groupOperator === 'AND' ? '(all groups must match)' : '(any group can match)'}
              </span>
            </div>
          )}

          {groups.map((group, groupIndex) => (
            <div key={groupIndex} className="rounded-md border p-4 space-y-3">
              {/* Group header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-semibold">Group {groupIndex + 1}</Label>
                  <Select
                    value={group.op}
                    onValueChange={(value) => updateGroupOp(groupIndex, value as 'AND' | 'OR')}
                  >
                    <SelectTrigger className="w-24 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AND">AND</SelectItem>
                      <SelectItem value="OR">OR</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">within group</span>
                </div>
                {groups.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeGroup(groupIndex)}
                    className="h-8"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {groupHints[groupIndex] && groupHints[groupIndex].length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30">
                  <div className="space-y-1.5">
                    {groupHints[groupIndex].map((hint, hintIndex) => (
                      <div
                        key={`${groupIndex}-${hintIndex}`}
                        className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200"
                      >
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                        <span>
                          {hint.kind === 'duplicate' ? 'Duplicate:' : 'Potential contradiction:'} {hint.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Conditions */}
              {group.conditions.map((condition, conditionIndex) => {
                const asyncUniqueInfo = condition.columnId
                  ? loadedUniqueValues.get(condition.columnId)
                  : undefined
                const uniqueInfo = condition.columnId
                  ? getColumnUniqueValues
                    ? asyncUniqueInfo
                    : sampleUniqueValues.get(condition.columnId)
                  : undefined
                const uniqueValues = uniqueInfo?.values
                const needsValue = operatorNeedsValue(condition.operator)
                const hasColumnError = validationErrors.has(`g${groupIndex}-c${conditionIndex}-column`)
                const hasValueError = validationErrors.has(`g${groupIndex}-c${conditionIndex}-value`)

                return (
                  <div key={conditionIndex} className="space-y-2">
                    <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-3">
                      {/* Column */}
                      <Select
                        value={condition.columnId}
                        onValueChange={(value) =>
                          updateCondition(groupIndex, conditionIndex, 'columnId', value)
                        }
                      >
                      <SelectTrigger
                          className={`w-full min-w-0 ${hasColumnError ? 'border-red-500 ring-1 ring-red-500' : ''}`}
                        >
                          <SelectValue placeholder="Select column" />
                        </SelectTrigger>
                        <SelectContent>
                          {columnMetadata.map((col) => (
                            <SelectItem key={col.id} value={col.id}>
                              {col.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Operator */}
                      <Select
                        value={condition.operator}
                        onValueChange={(value) =>
                          updateCondition(groupIndex, conditionIndex, 'operator', value)
                        }
                      >
                        <SelectTrigger className="w-full min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPERATORS.map((op) => (
                            <SelectItem key={op.value} value={op.value}>
                              {op.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Value (only if operator needs it) */}
                      {needsValue ? (
                        <Input
                          value={(condition.value ?? '') as string | number}
                          onChange={(e) =>
                            updateCondition(groupIndex, conditionIndex, 'value', e.target.value)
                          }
                          placeholder={condition.operator === 'regex' ? 'Pattern (e.g., ^test.*)' : 'Value'}
                          className={`w-full min-w-0 ${hasValueError ? 'border-red-500 ring-1 ring-red-500' : ''}`}
                        />
                      ) : (
                        <div className="text-sm text-muted-foreground italic px-3">
                          (no value needed)
                        </div>
                      )}

                      {/* Case sensitivity toggle (for string operators) */}
                      {['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'regex'].includes(condition.operator) && needsValue && (
                        <div
                          className="flex items-center gap-1.5"
                          title="Case sensitive (off = ignores case)"
                        >
                          <Checkbox
                            id={`case-${groupIndex}-${conditionIndex}`}
                            checked={condition.caseSensitive ?? false}
                            onCheckedChange={(checked) =>
                              updateCondition(groupIndex, conditionIndex, 'caseSensitive', checked === true)
                            }
                          />
                          <Label
                            htmlFor={`case-${groupIndex}-${conditionIndex}`}
                            className="text-xs text-muted-foreground cursor-pointer"
                            title="Case sensitive (off = ignores case)"
                          >
                            Aa
                          </Label>
                        </div>
                      )}

                      {/* Remove condition */}
                      {group.conditions.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeCondition(groupIndex, conditionIndex)}
                          className="h-8 w-8 p-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    {/* Unique values (clickable chips) - preserve original type */}
                    {asyncUniqueInfo?.loading && needsValue && (
                      <div className="text-xs text-muted-foreground">Loading full-column values...</div>
                    )}
                    {asyncUniqueInfo?.error && needsValue && !asyncUniqueInfo.loading && (
                      <div className="text-xs text-amber-600 dark:text-amber-400">{asyncUniqueInfo.error}</div>
                    )}
                    {uniqueValues && uniqueValues.length > 0 && needsValue && !asyncUniqueInfo?.loading && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400 self-center">Quick:</span>
                        {uniqueValues.map((val, idx) => {
                          const isEmptyValue = val === '' || val === null || val === undefined
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() =>
                                updateCondition(groupIndex, conditionIndex, 'value', isEmptyValue ? '' : val)
                              }
                              className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-blue-100 dark:hover:bg-blue-900 hover:text-blue-700 dark:hover:text-blue-300 border border-gray-200 dark:border-gray-700 transition-colors"
                            >
                              {isEmptyValue ? '(empty)' : String(val)}
                            </button>
                          )
                        })}
                        {uniqueInfo?.truncated && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 self-center italic">
                            (+more)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Add condition to group */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => addCondition(groupIndex)}
                className="mt-2"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Condition
              </Button>
            </div>
          ))}
        </div>

        <ResizableDialogFooter className="px-6 py-4 border-t">
          <div className="w-full space-y-3">
            <Button variant="outline" onClick={addGroup} className="w-full">
              <Plus className="h-4 w-4 mr-1" />
              Add Group
            </Button>

            {/* Expression preview */}
            {expressionElements && (
              <div className="flex items-start gap-2 rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2">
                <Code2 className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm font-mono leading-relaxed flex flex-wrap items-baseline gap-y-1">
                  {expressionElements}
                </div>
              </div>
            )}

            {/* Match count */}
            {matchCountState.status !== 'idle' && (
              <div className="flex items-center justify-center gap-2 text-sm">
                {matchCountState.status === 'loading' ? (
                  <span className="text-muted-foreground">Counting matching rows...</span>
                ) : matchCountState.count === 0 ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                    <span className="text-amber-600 dark:text-amber-400">
                      No rows match this filter.
                    </span>
                  </>
                ) : matchCountState.count === 1 ? (
                  <span className="text-muted-foreground">1 row matches this filter.</span>
                ) : (
                  <span className="text-muted-foreground">{matchCountState.count.toLocaleString()} rows match this filter.</span>
                )}
              </div>
            )}

            <div className="flex justify-between gap-2">
              <div>
                {initialConfig && (
                  <Button
                    variant="outline"
                    onClick={() => { onApply(null); onOpenChange(false) }}
                  >
                    Clear Filter
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleReset}>
                  Reset
                </Button>
                <Button onClick={handleApply}>Apply Filter</Button>
              </div>
            </div>
          </div>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
