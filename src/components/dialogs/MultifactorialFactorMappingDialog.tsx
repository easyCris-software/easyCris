/**
 * Multifactorial ANOVA Factor Mapping Dialog
 *
 * Allows users to explicitly assign factor roles for Multifactorial ANOVA (3+ factors):
 * - Primary (x-axis)
 * - Secondary (grouping/series)
 * - Facets (remaining factors in user-defined order)
 *
 * This dialog appears after DV selection and before analysis runs.
 * It ensures clear, explicit factor role assignment independent of column order or level counts.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertCircle, Grid3x3, Layers, PanelsTopLeft } from 'lucide-react'

/**
 * Column info for the mapper
 */
export interface MultifactorialFactorColumnInfo {
  columnName: string
  columnId: string
}

/**
 * Result of the factor role mapping
 */
export interface MultifactorialFactorMapping {
  primary: string // columnId for primary factor (x-axis)
  secondary: string // columnId for secondary factor (grouping/series)
  facets: string[] // columnIds for facet factors (ordered)
}

interface MultifactorialFactorMappingDialogProps {
  open: boolean
  columns: MultifactorialFactorColumnInfo[] // Categorical factors only (DV already selected)
  onConfirm: (mapping: MultifactorialFactorMapping) => void
  onCancel: () => void
}

/**
 * Multifactorial Factor Mapping Dialog Component
 */
export function MultifactorialFactorMappingDialog({
  open,
  columns,
  onConfirm,
  onCancel,
}: MultifactorialFactorMappingDialogProps) {
  // State for factor role mapping
  const [primary, setPrimary] = useState<string>('')
  const [secondary, setSecondary] = useState<string>('')
  const [facets, setFacets] = useState<string[]>([])

  // Reset mapping when dialog opens
  useEffect(() => {
    if (open) {
      // Auto-assign if exactly 3 factors (user can still change)
      if (columns.length === 3) {
        setPrimary(columns[0]?.columnId || '')
        setSecondary(columns[1]?.columnId || '')
        setFacets([columns[2]?.columnId || ''])
      } else if (columns.length > 3) {
        // Auto-assign first 2, rest become facets
        setPrimary(columns[0]?.columnId || '')
        setSecondary(columns[1]?.columnId || '')
        setFacets(columns.slice(2).map(c => c.columnId))
      } else {
        setPrimary('')
        setSecondary('')
        setFacets([])
      }
    }
  }, [open, columns])

  // Get available columns excluding already selected ones
  const getAvailableForPrimary = useMemo(() => columns, [columns])

  const getAvailableForSecondary = useMemo(() => columns, [columns])

  const getAvailableForFacets = useMemo(() => columns, [columns])

  // Check if mapping is complete
  const isComplete = useMemo(() => {
    return Boolean(primary && secondary && facets.length > 0)
  }, [primary, secondary, facets])

  // Check for duplicates
  const hasDuplicates = useMemo(() => {
    const allSelected = [primary, secondary, ...facets].filter(Boolean)
    return new Set(allSelected).size !== allSelected.length
  }, [primary, secondary, facets])

  // Validation message
  const validationMessage = useMemo(() => {
    if (hasDuplicates) {
      return 'Each factor can only be assigned to one role.'
    }
    if (!primary) {
      return 'Please select a primary factor (x-axis).'
    }
    if (!secondary) {
      return 'Please select a secondary factor (grouping/series).'
    }
    if (facets.length === 0) {
      return 'Please assign at least one facet factor.'
    }
    return null
  }, [primary, secondary, facets, hasDuplicates])

  const handlePrimaryChange = useCallback((value: string) => {
    setPrimary(value)
  }, [])

  const handleSecondaryChange = useCallback((value: string) => {
    setSecondary(value)
  }, [])

  const handleFacetChange = useCallback((index: number, value: string) => {
    setFacets(prev => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }, [])

  const handleAddFacet = useCallback(() => {
    const available = getAvailableForFacets.filter(
      col => !facets.includes(col.columnId)
    )
    if (available.length > 0) {
      setFacets(prev => [...prev, available[0]!.columnId])
    }
  }, [getAvailableForFacets, facets])

  const handleRemoveFacet = useCallback((index: number) => {
    setFacets(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleConfirm = useCallback(() => {
    if (isComplete && !hasDuplicates) {
      onConfirm({
        primary,
        secondary,
        facets,
      })
    }
  }, [primary, secondary, facets, isComplete, hasDuplicates, onConfirm])

  const handleCancel = useCallback(() => {
    setPrimary('')
    setSecondary('')
    setFacets([])
    onCancel()
  }, [onCancel])

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
            <PanelsTopLeft className="h-5 w-5" />
            Assign Factor Roles
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Choose which factors should be primary (x-axis), secondary
            (grouping), and facets (panels) for Multifactorial ANOVA analysis
            and plots.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-4">
          {/* Info banner */}
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-200">
            <p>
              <strong>Tip:</strong> Primary factor appears on the x-axis,
              secondary factor defines the groups/colors, and facet factors
              split the plot into separate panels. This assignment affects plot
              layout and interaction interpretation.
            </p>
          </div>

          {/* Field mappings */}
          <div className="space-y-4">
            {/* Primary Factor */}
            <div className="space-y-2">
              <Label
                htmlFor="primary"
                className="flex items-center gap-2 font-medium"
              >
                <Grid3x3 className="h-4 w-4 text-muted-foreground" />
                Primary Factor (X-Axis)
              </Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Main independent variable on x-axis
              </p>
              <Select value={primary} onValueChange={handlePrimaryChange}>
                <SelectTrigger id="primary" className="w-full">
                  <SelectValue placeholder="Select primary factor..." />
                </SelectTrigger>
                <SelectContent>
                  {getAvailableForPrimary.length === 0 && (
                    <div className="p-2 text-xs text-muted-foreground text-center">
                      No available columns
                    </div>
                  )}
                  {getAvailableForPrimary.map(col => (
                    <SelectItem key={col.columnId} value={col.columnId}>
                      {col.columnName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Secondary Factor */}
            <div className="space-y-2">
              <Label
                htmlFor="secondary"
                className="flex items-center gap-2 font-medium"
              >
                <Layers className="h-4 w-4 text-muted-foreground" />
                Secondary Factor (Grouping/Series)
              </Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Grouping variable for colors/legend within each panel
              </p>
              <Select value={secondary} onValueChange={handleSecondaryChange}>
                <SelectTrigger id="secondary" className="w-full">
                  <SelectValue placeholder="Select secondary factor..." />
                </SelectTrigger>
                <SelectContent>
                  {getAvailableForSecondary.length === 0 && (
                    <div className="p-2 text-xs text-muted-foreground text-center">
                      No available columns
                    </div>
                  )}
                  {getAvailableForSecondary.map(col => (
                    <SelectItem key={col.columnId} value={col.columnId}>
                      {col.columnName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Facet Factors */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2 font-medium">
                <PanelsTopLeft className="h-4 w-4 text-muted-foreground" />
                Facet Factors (Panels)
              </Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Factors that split the plot into separate panels (ordered)
              </p>

              {facets.map((facetId, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Select
                    value={facetId}
                    onValueChange={value => handleFacetChange(index, value)}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue
                        placeholder={`Select facet ${index + 1}...`}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {getAvailableForFacets
                        .filter(
                          col =>
                            !facets.includes(col.columnId) ||
                            col.columnId === facetId
                        )
                        .map(col => (
                          <SelectItem key={col.columnId} value={col.columnId}>
                            {col.columnName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {facets.length > 1 && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleRemoveFacet(index)}
                      className="shrink-0"
                    >
                      ✕
                    </Button>
                  )}
                </div>
              ))}

              {getAvailableForFacets.filter(
                col => !facets.includes(col.columnId)
              ).length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddFacet}
                  className="w-full mt-2"
                >
                  + Add Facet Factor
                </Button>
              )}
            </div>
          </div>

          {/* Validation message */}
          {validationMessage && (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{validationMessage}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!isComplete || hasDuplicates}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MultifactorialFactorMappingDialog
