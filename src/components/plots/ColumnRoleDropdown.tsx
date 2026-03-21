/**
 * ColumnRoleDropdown - shared column assignment dropdown
 */

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PlotRole, PlotDataType } from '@/config/plotRegistry'

export interface ColumnOption {
  id: string
  name: string
  inferredType: PlotDataType
}

export interface ColumnRoleDropdownProps {
  role: PlotRole
  label: string
  required: boolean
  value: string | null
  columns: ColumnOption[]
  onChange: (role: PlotRole, value: string | null) => void
}

export function ColumnRoleDropdown({
  role,
  label,
  required,
  value,
  columns,
  onChange,
}: ColumnRoleDropdownProps) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm text-muted-foreground">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <Select
        value={value ?? 'none'}
        onValueChange={(val) => onChange(role, val === 'none' ? null : val)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select column..." />
        </SelectTrigger>
        <SelectContent>
          {!required && (
            <SelectItem value="none">
              <span className="text-muted-foreground">None</span>
            </SelectItem>
          )}
          {columns.map((col) => (
            <SelectItem key={col.id} value={col.id}>
              <div className="flex items-center gap-2">
                <span>{col.name}</span>
                <span className="text-xs text-muted-foreground">
                  ({col.inferredType})
                </span>
              </div>
            </SelectItem>
          ))}
          {columns.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No compatible columns
            </div>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

export default ColumnRoleDropdown
