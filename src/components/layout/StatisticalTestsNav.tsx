/**
 * Statistical Tests Navigation Component
 *
 * Displays hierarchical navigation for all statistical test families.
 * Uses testRegistry.ts as single source of truth for test definitions.
 *
 * Phase 4 Fix:
 * - All groups collapsed by default
 * - Color themes for each test family
 * - Proper scrollability
 * - All 7 test groups from validation
 */

import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  CaretDown,
  CaretRight,
  ChartBar,
  ChartLineDown,
  ChartPie,
  Flask,
  Table,
  TrendUp,
} from '@phosphor-icons/react'
import { MediationModerationIcon } from '@/components/icons/MediationModerationIcon'
import { useAnalysisStore } from '@/store/analysis-store'
import { toStoreTestDefinition } from '@/utils/testDefinitionMapping'
import {
  TEST_GROUP_ORDER,
  TEST_GROUPS,
  getTestsByGroup,
  type TestGroupId,
  type TestDefinition,
} from '@/config/testRegistry'

// =============================================================================
// THEME COLORS FOR EACH GROUP
// =============================================================================

const groupThemes: Record<TestGroupId, { bg: string; border: string; text: string; icon: string }> = {
  hypothesis_testing: {
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    border: 'border-blue-200 dark:border-blue-800',
    text: 'text-blue-700 dark:text-blue-300',
    icon: 'text-blue-600 dark:text-blue-400',
  },
  pharmacology: {
    bg: 'bg-purple-50 dark:bg-purple-950/30',
    border: 'border-purple-200 dark:border-purple-800',
    text: 'text-purple-700 dark:text-purple-300',
    icon: 'text-purple-600 dark:text-purple-400',
  },
  regression_correlation: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-700 dark:text-emerald-300',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  categorical: {
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    border: 'border-amber-200 dark:border-amber-800',
    text: 'text-amber-700 dark:text-amber-300',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  distribution_descriptive: {
    bg: 'bg-slate-50 dark:bg-slate-950/30',
    border: 'border-slate-200 dark:border-slate-700',
    text: 'text-slate-700 dark:text-slate-300',
    icon: 'text-slate-600 dark:text-slate-400',
  },
  survival: {
    bg: 'bg-rose-50 dark:bg-rose-950/30',
    border: 'border-rose-200 dark:border-rose-800',
    text: 'text-rose-700 dark:text-rose-300',
    icon: 'text-rose-600 dark:text-rose-400',
  },
  mediation_moderation: {
    bg: 'bg-cyan-50 dark:bg-cyan-950/30',
    border: 'border-cyan-200 dark:border-cyan-800',
    text: 'text-cyan-700 dark:text-cyan-300',
    icon: 'text-cyan-600 dark:text-cyan-400',
  },
}

// =============================================================================
// FAMILY ICON MAPPING
// =============================================================================

const groupIcons: Record<TestGroupId, React.ReactNode> = {
  hypothesis_testing: <ChartBar size={20} weight="regular" />,
  pharmacology: <Flask size={20} weight="regular" />,
  regression_correlation: <TrendUp size={20} weight="regular" />,
  categorical: <ChartPie size={20} weight="regular" />,
  distribution_descriptive: <Table size={20} weight="regular" />,
  survival: <ChartLineDown size={20} weight="regular" />,
  mediation_moderation: <MediationModerationIcon size={24} />,
}

// =============================================================================
// COMPONENT
// =============================================================================

interface StatisticalTestsNavProps {
  className?: string
  defaultOpenGroups?: TestGroupId[]
  onSelectTest?: (testId: string) => void
}

export function StatisticalTestsNav({
  className,
  defaultOpenGroups = [], // Phase 4 Fix: All collapsed by default
  onSelectTest,
}: StatisticalTestsNavProps) {
  const { selectedTestId, selectTest } = useAnalysisStore()
  const [expandedGroups, setExpandedGroups] = useState<Set<TestGroupId>>(
    new Set(defaultOpenGroups)
  )

  /**
   * Toggle group expansion
   */
  const toggleGroup = (groupId: TestGroupId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  /**
   * Convert TestDefinition to StoreStatisticalTest format for analysis store
   */
  const handleTestClick = (testDef: TestDefinition) => {
    selectTest(toStoreTestDefinition(testDef))

    // Call optional callback
    onSelectTest?.(testDef.id)
  }

  // Build groups from registry
  const groups = TEST_GROUP_ORDER.map(groupId => {
    const group = TEST_GROUPS.find(g => g.id === groupId)
    if (!group) return null
    const tests = getTestsByGroup(groupId)
    if (tests.length === 0) return null

    return {
      id: group.id,
      name: group.displayName,
      description: group.description,
      icon: groupIcons[group.id],
      theme: groupThemes[group.id],
      tests,
    }
  }).filter((group): group is NonNullable<typeof group> => group !== null)

  // Count only selectable tests shown in the grouped navigation.
  const totalTests = groups.reduce((sum, group) => sum + group.tests.length, 0)

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* Header */}
      <div className="border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Statistical Tests</h2>
        <p className="text-sm text-muted-foreground">
          Select a test to begin analysis
        </p>
      </div>

      {/* Scrollable Navigation */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-2 px-2 space-y-2">
          {groups.map(group => {
            const isExpanded = expandedGroups.has(group.id)
            const theme = group.theme

            return (
              <div
                key={group.id}
                className={cn(
                  'rounded-lg border overflow-hidden transition-all',
                  theme.border
                )}
              >
                {/* Group Header - Clickable to expand/collapse */}
                <button
                  data-testid={`test-group-${group.id}`}
                  onClick={() => toggleGroup(group.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 transition-colors',
                    'hover:bg-accent/50',
                    isExpanded && theme.bg
                  )}
                >
                  <span className={theme.icon}>{group.icon}</span>
                  <div className="flex-1 text-left">
                    <div className={cn('font-medium', isExpanded && theme.text)}>
                      {group.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {group.tests.length} test{group.tests.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {isExpanded ? (
                    <CaretDown size={16} className="text-muted-foreground" />
                  ) : (
                    <CaretRight size={16} className="text-muted-foreground" />
                  )}
                </button>

                {/* Group Tests - Only shown when expanded */}
                {isExpanded && (
                  <div className={cn('border-t px-2 py-2 space-y-1', theme.border, theme.bg)}>
                    {group.tests.map(test => {
                      const isSelected = selectedTestId === test.id

                      return (
                        <button
                          key={test.id}
                          data-testid={`test-${test.id}`}
                          onClick={() => handleTestClick(test)}
                          aria-pressed={isSelected}
                          className={cn(
                            'w-full rounded-md px-3 py-2.5 text-left transition-all',
                            'hover:bg-background/80',
                            isSelected && 'bg-background shadow-sm ring-1 ring-primary/20'
                          )}
                        >
                          <div className={cn(
                            'font-medium text-sm',
                            isSelected && 'text-primary'
                          )}>
                            {test.displayName}
                          </div>
                          {test.description && (
                            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {test.description}
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {/* Footer with test count */}
      <div className="border-t px-4 py-3 text-center text-xs text-muted-foreground">
        {totalTests} tests across {groups.length} categories
      </div>
    </div>
  )
}

export default StatisticalTestsNav
