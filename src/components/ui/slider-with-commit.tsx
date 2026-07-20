/**
 * SliderWithCommit - Slider that only updates on drag end
 *
 * Keeps local state while dragging for smooth interaction,
 * commits value only when user releases the thumb.
 * Optionally wraps commit in startTransition for non-blocking updates.
 */

import * as React from 'react'
import { startTransition } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { Slider } from '@/components/ui/slider'

type SliderRootProps = ComponentPropsWithoutRef<typeof Slider>

interface SliderWithCommitProps extends Omit<SliderRootProps, 'value' | 'onValueChange' | 'onValueCommit'> {
  value: number
  onCommit: (value: number) => void
  useTransition?: boolean
}

export function SliderWithCommit({
  value,
  onCommit,
  useTransition = true,
  ...rest
}: SliderWithCommitProps) {
  const [localValue, setLocalValue] = React.useState(value)

  // Sync local state when external value changes (e.g., reset or different result selected)
  React.useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleValueChange = (values: number[]) => {
    setLocalValue(values[0] ?? value)
  }

  const handleValueCommit = (values: number[]) => {
    const newValue = values[0] ?? value
    if (useTransition) {
      startTransition(() => {
        onCommit(newValue)
      })
    } else {
      onCommit(newValue)
    }
  }

  return (
    <Slider
      {...rest}
      value={[localValue]}
      onValueChange={handleValueChange}
      onValueCommit={handleValueCommit}
    />
  )
}
