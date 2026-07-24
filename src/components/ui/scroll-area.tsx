import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'

import { cn } from '@/lib/utils'

type ScrollbarSide = 'left' | 'right'
type LeftViewportPadding = 'none' | 'sm' | 'md'

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  scrollbarSide?: ScrollbarSide
  leftViewportPadding?: LeftViewportPadding
}

function ScrollArea({
  className,
  children,
  scrollbarSide = 'right',
  leftViewportPadding = 'md',
  ...props
}: ScrollAreaProps) {
  const leftPaddingClass =
    leftViewportPadding === 'none'
      ? ''
      : leftViewportPadding === 'sm'
        ? 'pl-1'
        : 'pl-2'

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          'focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1',
          scrollbarSide === 'left' && leftPaddingClass
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar scrollbarSide={scrollbarSide} />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

type ScrollBarProps = React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  scrollbarSide?: ScrollbarSide
}

function ScrollBar({
  className,
  orientation = 'vertical',
  scrollbarSide = 'right',
  style,
  ...props
}: ScrollBarProps) {
  const resolvedStyle =
    orientation === 'vertical' && scrollbarSide === 'left'
      ? { left: 0, right: 'auto', ...(style as React.CSSProperties) }
      : style

  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      style={resolvedStyle}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' &&
          (scrollbarSide === 'left'
            ? 'h-full w-2.5 left-0 right-auto border-r border-r-transparent'
            : 'h-full w-2.5 border-l border-l-transparent'),
        orientation === 'horizontal' &&
          'h-2.5 flex-col border-t border-t-transparent',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
