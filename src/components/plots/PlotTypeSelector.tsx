/**
 * PlotTypeSelector - button grid for choosing plot types
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PlotType } from '@/config/plotRegistry'
import { getPlotTemplate } from '@/config/plotRegistry'
import { getPlotIcon } from '@/config/plotIconMap'

export interface PlotTypeSelectorProps {
  plotTypes: PlotType[]
  selected: PlotType
  onSelect: (plotType: PlotType) => void
  className?: string
}

export function PlotTypeSelector({
  plotTypes,
  selected,
  onSelect,
  className,
}: PlotTypeSelectorProps) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {plotTypes.map((plotType) => {
        const template = getPlotTemplate(plotType)
        const Icon = getPlotIcon(template?.icon)
        const isSelected = selected === plotType
        return (
          <Button
            key={plotType}
            variant={isSelected ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSelect(plotType)}
            className={cn('gap-1.5', isSelected && 'ring-2 ring-primary/20')}
            data-plot-type={plotType}
          >
            <Icon className="h-4 w-4" />
            {template?.displayName ?? plotType}
          </Button>
        )
      })}
    </div>
  )
}

export default PlotTypeSelector
