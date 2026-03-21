/**
 * ResizableDialog - Resizable and draggable dialog wrapper
 *
 * Wraps Radix UI Dialog with react-rnd for resize/drag functionality.
 * Maintains the same API as Dialog for easy migration.
 */

import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react'
import { Rnd } from 'react-rnd'
import { X } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Dialog,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DialogOverlay,
  DialogPortal,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface ResizableDialogSize {
  width: number
  height: number
}

interface ResizableDialogPosition {
  x: number
  y: number
}

interface ResizableDialogContextValue {
  onOpenChange: (open: boolean) => void
  showCloseButton: boolean
  shouldIgnoreInteraction?: () => boolean
}

const ResizableDialogContext = createContext<ResizableDialogContextValue | null>(null)

const useResizableDialogContext = () => {
  const context = useContext(ResizableDialogContext)
  if (!context) {
    throw new Error('ResizableDialog components must be used within ResizableDialog')
  }
  return context
}

interface ResizableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  /** Unique key for persisting size/position to localStorage */
  persistKey?: string
  /** Allow dragging */
  draggable?: boolean
  /** Allow resizing */
  resizable?: boolean
  /** Show close button */
  showCloseButton?: boolean
}

/**
 * ResizableDialog - Main wrapper
 */
export function ResizableDialog({
  open,
  onOpenChange,
  children,
  defaultWidth = 800,
  defaultHeight = 600,
  minWidth = 400,
  minHeight = 300,
  maxWidth,
  maxHeight,
  persistKey,
  draggable = true,
  resizable = true,
  showCloseButton = true,
}: ResizableDialogProps) {
  const hasStoredPositionRef = useRef(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastOpenedAtRef = useRef<number | null>(null)
  const minVisible = 32
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const ignoreOutsideMs = 200
  const shouldIgnoreOutside = () => {
    const openedAt = lastOpenedAtRef.current
    return openedAt != null && Date.now() - openedAt < ignoreOutsideMs
  }
  const isPortaledElement = (target: EventTarget | null) => {
    if (!target) return false
    const element = target as HTMLElement
    if (typeof element.closest !== 'function') return false
    return Boolean(
      element.closest('[data-radix-popper-content-wrapper]') ||
        element.closest('[data-slot="select-content"]') ||
        element.closest('[data-slot="dropdown-menu-content"]') ||
        element.closest('[data-slot="context-menu-content"]') ||
        element.closest('[data-slot="popover-content"]') ||
        element.closest('[data-slot="tooltip-content"]')
    )
  }
  const shouldIgnoreOutsideEvent = (event: Event) =>
    shouldIgnoreOutside() || isPortaledElement(event.target)
  const clampPosition = (
    nextPosition: ResizableDialogPosition,
    nextSize: ResizableDialogSize
  ): ResizableDialogPosition => {
    if (typeof window === 'undefined') return nextPosition
    const width = viewportSize.width || window.innerWidth
    const height = viewportSize.height || window.innerHeight
    const maxX = Math.max(minVisible, width - nextSize.width)
    const maxY = Math.max(minVisible, height - nextSize.height)
    return {
      x: Math.min(Math.max(minVisible, nextPosition.x), maxX),
      y: Math.min(Math.max(minVisible, nextPosition.y), maxY),
    }
  }
  const [size, setSize] = useState<ResizableDialogSize>(() => {
    if (persistKey && typeof window !== 'undefined') {
      const stored = localStorage.getItem(`dialog-size-${persistKey}`)
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          return { width: parsed.width || defaultWidth, height: parsed.height || defaultHeight }
        } catch {
          // Fallback to defaults
        }
      }
    }
    return { width: defaultWidth, height: defaultHeight }
  })

  const [position, setPosition] = useState<ResizableDialogPosition>(() => {
    if (persistKey && typeof window !== 'undefined') {
      const stored = localStorage.getItem(`dialog-position-${persistKey}`)
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          hasStoredPositionRef.current = true
          return {
            x: typeof parsed.x === 'number' ? parsed.x : 0,
            y: typeof parsed.y === 'number' ? parsed.y : 0,
          }
        } catch {
          // Fallback to center
        }
      }
    }
    // Center by default
    const centered = {
      x: typeof window !== 'undefined' ? (window.innerWidth - defaultWidth) / 2 : 0,
      y: typeof window !== 'undefined' ? (window.innerHeight - defaultHeight) / 2 : 0,
    }
    return clampPosition(centered, { width: defaultWidth, height: defaultHeight })
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const updateViewport = () => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    }
    updateViewport()
    window.addEventListener('resize', updateViewport)
    return () => {
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  const availableWidth = Math.max(0, viewportSize.width - minVisible * 2)
  const availableHeight = Math.max(0, viewportSize.height - minVisible * 2)
  const effectiveMaxWidth = availableWidth
    ? Math.min(maxWidth ?? availableWidth, availableWidth)
    : maxWidth
  const effectiveMaxHeight = availableHeight
    ? Math.min(maxHeight ?? availableHeight, availableHeight)
    : maxHeight
  const effectiveMinWidth = effectiveMaxWidth ? Math.min(minWidth, effectiveMaxWidth) : minWidth
  const effectiveMinHeight = effectiveMaxHeight ? Math.min(minHeight, effectiveMaxHeight) : minHeight

  // Persist size/position changes
  useEffect(() => {
    if (persistKey) {
      localStorage.setItem(`dialog-size-${persistKey}`, JSON.stringify(size))
      localStorage.setItem(`dialog-position-${persistKey}`, JSON.stringify(position))
      hasStoredPositionRef.current = true
    }
  }, [size, position, persistKey])

  // Reset to center when dialog opens only if no stored position exists
  useEffect(() => {
    if (!open) return

    lastOpenedAtRef.current = Date.now()

    if (persistKey && hasStoredPositionRef.current) {
      // Has stored position - just clamp it to ensure it's visible
      setPosition((current) => {
        const clamped = clampPosition(current, size)
        if (clamped.x !== current.x || clamped.y !== current.y) {
          return clamped
        }
        return current
      })
      return
    }

    // No stored position - always center on open
    if (typeof window !== 'undefined') {
      const centered = clampPosition(
        {
          x: (window.innerWidth - size.width) / 2,
          y: (window.innerHeight - size.height) / 2,
        },
        size
      )
      setPosition(centered)
    }
  }, [open, persistKey, size.width, size.height])

  useEffect(() => {
    if (!open) return
    if (!availableWidth || !availableHeight) return
    const nextSize = {
      width: Math.min(size.width, availableWidth),
      height: Math.min(size.height, availableHeight),
    }
    if (nextSize.width !== size.width || nextSize.height !== size.height) {
      setSize(nextSize)
      setPosition((current) => {
        const clamped = clampPosition(current, nextSize)
        if (clamped.x === current.x && clamped.y === current.y) {
          return current
        }
        return clamped
      })
      return
    }
    setPosition((current) => {
      const clamped = clampPosition(current, size)
      if (clamped.x === current.x && clamped.y === current.y) {
        return current
      }
      return clamped
    })
  }, [open, availableWidth, availableHeight, size.width, size.height])

  return (
    <ResizableDialogContext.Provider
      value={{ onOpenChange, showCloseButton, shouldIgnoreInteraction: shouldIgnoreOutside }}
    >
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            ref={contentRef}
            tabIndex={-1}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              contentRef.current?.focus()
            }}
            onPointerDownOutside={(event) => {
              if (shouldIgnoreOutsideEvent(event)) {
                event.preventDefault()
              }
            }}
            onInteractOutside={(event) => {
              if (shouldIgnoreOutsideEvent(event)) {
                event.preventDefault()
              }
            }}
            className={cn('fixed inset-0 z-50 outline-none pointer-events-none')}
          >
          <Rnd
            size={size}
            position={position}
            default={{
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
            }}
            onDragStop={(_e, d) => {
              setPosition(clampPosition({ x: d.x, y: d.y }, size))
            }}
            onResizeStop={(_e, _direction, ref, _delta, nextPosition) => {
              const nextSize = {
                width: parseInt(ref.style.width, 10),
                height: parseInt(ref.style.height, 10),
              }
              setSize(nextSize)
              setPosition(clampPosition(nextPosition, nextSize))
            }}
              minWidth={effectiveMinWidth}
              minHeight={effectiveMinHeight}
              maxWidth={effectiveMaxWidth}
              maxHeight={effectiveMaxHeight}
              bounds="window"
              disableDragging={!draggable}
              enableResizing={resizable}
              className="z-50 pointer-events-auto"
              dragHandleClassName="dialog-drag-handle"
            >
              <div
                className={cn(
                  'relative flex flex-col w-full h-full outline-none',
                  'bg-background rounded-lg border shadow-lg',
                  'overflow-hidden'
                )}
              >
                {children}
              </div>
            </Rnd>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </ResizableDialogContext.Provider>
  )
}

/**
 * ResizableDialogContent - Drop-in replacement for DialogContent
 * Adds drag handle to header and close button
 */
export function ResizableDialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { onOpenChange, showCloseButton, shouldIgnoreInteraction } = useResizableDialogContext()

  return (
    <div
      className={cn('flex flex-col h-full overflow-hidden relative', className)}
      onPointerDownCapture={(event) => {
        if (shouldIgnoreInteraction?.()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onClickCapture={(event) => {
        if (shouldIgnoreInteraction?.()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      {...props}
    >
      {showCloseButton && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-4 top-4 z-10 h-8 w-8 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          onClick={() => onOpenChange(false)}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      )}
      {children}
    </div>
  )
}

/**
 * ResizableDialogHeader - Drop-in replacement for DialogHeader
 * Adds drag handle styling
 */
export function ResizableDialogHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'dialog-drag-handle',
        'flex flex-col space-y-1.5 p-6 cursor-move',
        'border-b',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * ResizableDialogTitle - Re-export DialogTitle
 */
export { DialogTitle as ResizableDialogTitle }

/**
 * ResizableDialogDescription - Re-export DialogDescription
 */
export { DialogDescription as ResizableDialogDescription }

/**
 * ResizableDialogFooter - Drop-in replacement for DialogFooter
 * Adds proper padding and border
 */
export function ResizableDialogFooter({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-row justify-end space-x-2 p-6 border-t',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * ResizableDialogTrigger - Re-export DialogTrigger
 */
export { DialogTrigger as ResizableDialogTrigger }
