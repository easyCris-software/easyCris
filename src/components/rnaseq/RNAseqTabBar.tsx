/**
 * RNAseqTabBar Component
 *
 * Tab navigation for RNA-seq project views:
 * - Counts: Count matrix data grid
 * - Metadata: Sample metadata grid
 * - Results: DEG results tables
 * - Plots: Interactive visualizations
 */

import { cn } from '@/lib/utils'
import { Table2, FileSpreadsheet, FileText, LineChart } from 'lucide-react'
import type { RNAseqTab } from '@/types/rnaseq'

interface RNAseqTabBarProps {
  activeTab: RNAseqTab
  onTabChange: (tab: RNAseqTab) => void
  hasCountsData: boolean
  hasMetadataData: boolean
  hasResults: boolean
  isLocked?: boolean
  className?: string
}

const TABS: { id: RNAseqTab; label: string; icon: React.ElementType; color: string }[] = [
  { id: 'counts', label: 'Counts', icon: Table2, color: 'text-[#2E86AB]' },
  { id: 'metadata', label: 'Metadata', icon: FileSpreadsheet, color: 'text-[#F59E0B]' },
  { id: 'results', label: 'Results', icon: FileText, color: 'text-[#8B5CF6]' },
  { id: 'plots', label: 'Plots', icon: LineChart, color: 'text-[#C73E1D]' },
]

export function RNAseqTabBar({
  activeTab,
  onTabChange,
  hasCountsData,
  hasMetadataData,
  hasResults,
  isLocked = false,
  className,
}: RNAseqTabBarProps) {
  // Determine tab availability
  const isTabEnabled = (tab: RNAseqTab): boolean => {
    switch (tab) {
      case 'counts':
        return true // Always enabled for import
      case 'metadata':
        return true // Always enabled for import
      case 'results':
        return hasResults
      case 'plots':
        return hasResults
      default:
        return false
    }
  }

  // Tab status indicators
  const getTabStatus = (tab: RNAseqTab): 'ready' | 'empty' | 'disabled' => {
    switch (tab) {
      case 'counts':
        return hasCountsData ? 'ready' : 'empty'
      case 'metadata':
        return hasMetadataData ? 'ready' : 'empty'
      case 'results':
        return hasResults ? 'ready' : 'disabled'
      case 'plots':
        return hasResults ? 'ready' : 'disabled'
      default:
        return 'disabled'
    }
  }

  return (
    <div className={cn('flex border-b bg-muted/30', className)}>
      {TABS.map(({ id, label, icon: Icon, color }) => {
        const enabled = isTabEnabled(id)
        const status = getTabStatus(id)
        const isActive = activeTab === id

        return (
          <button
            key={id}
            onClick={() => enabled && !isLocked && onTabChange(id)}
            disabled={!enabled || isLocked}
            className={cn(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
              'border-b-2 -mb-px',
              isActive
                ? 'border-primary text-primary bg-background'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50',
              (!enabled || isLocked) && 'opacity-50 cursor-not-allowed'
            )}
          >
            <Icon className={cn('h-4 w-4', color)} />
            <span>{label}</span>
            {status === 'empty' && (
              <span className="text-xs text-muted-foreground">(empty)</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export default RNAseqTabBar
