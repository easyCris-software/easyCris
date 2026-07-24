/**
 * useKeyboardShortcuts Hook - Global keyboard shortcut handlers
 *
 * Features:
 * - Ctrl+C: Copy selected cells
 * - Ctrl+V: Paste from clipboard
 * - Ctrl+X: Cut selected cells
 * - Ctrl+T: Transpose paste
 * - Ctrl+Z: Undo (future - Phase 4)
 * - Ctrl+Shift+Z / Ctrl+Y: Redo (future - Phase 4)
 *
 * Based on Avalonia's KeyboardManager pattern
 */

import { useEffect, useRef, type RefObject } from 'react'

/**
 * Keyboard shortcut handler interface
 */
export interface KeyboardShortcutHandlers {
  /**
   * Return `false` to indicate the shortcut should NOT be handled (and default
   * browser behavior should be preserved).
   */
  onCopy?: () => boolean | undefined | Promise<boolean | undefined>
  onPaste?: () => boolean | undefined | Promise<boolean | undefined>
  onPasteValues?: () => boolean | undefined | Promise<boolean | undefined>
  onCut?: () => boolean | undefined | Promise<boolean | undefined>
  onTranspose?: () => boolean | undefined | Promise<boolean | undefined>
  onUndo?: () => boolean | undefined | Promise<boolean | undefined>
  onRedo?: () => boolean | undefined | Promise<boolean | undefined>
  onSelectAll?: () => boolean | undefined | Promise<boolean | undefined>
  onDelete?: () => boolean | undefined | Promise<boolean | undefined>
  onFind?: () => boolean | undefined | Promise<boolean | undefined>
  onFindReplace?: () => boolean | undefined | Promise<boolean | undefined>
  onFindNext?: () => boolean | undefined | Promise<boolean | undefined>
  onFindPrevious?: () => boolean | undefined | Promise<boolean | undefined>
  onHighlight?: () => boolean | undefined | Promise<boolean | undefined>
  onRecalculate?: () => boolean | undefined | Promise<boolean | undefined>
}

export interface UseKeyboardShortcutsOptions {
  /**
   * When true (default), listens during capture phase so shortcuts still work even
   * if a focused widget stops propagation (e.g. Glide Data Grid canvas handlers).
   */
  capture?: boolean
  /**
   * Optional container ref. When provided, Delete/Backspace shortcuts only fire
   * if focus is within this container (prevents conflicts with other panels like plots).
   */
  containerRef?: RefObject<HTMLElement | null>
}

interface RunHandlerOptions {
  promiseMeansNotHandled?: boolean
}

/**
 * useKeyboardShortcuts Hook
 *
 * Registers global keyboard event listeners for spreadsheet shortcuts
 */
export function useKeyboardShortcuts(
  handlers: KeyboardShortcutHandlers,
  options: UseKeyboardShortcutsOptions = {}
) {
  const handlersRef = useRef(handlers)
  const lastPointerInsideRef = useRef<boolean>(false)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    const capture = options.capture ?? true

    const run = (
      handler: (() => boolean | undefined | Promise<boolean | undefined>) | undefined,
      label: string,
      runOptions: RunHandlerOptions = {}
    ): boolean => {
      if (!handler) return false
      try {
        const result = handler()
        if (result === false) return false
        if (result instanceof Promise) {
          void result.catch((err) => {
            if (import.meta.env.DEV) {
              console.error(`[useKeyboardShortcuts] ${label} failed:`, err)
            }
          })
          if (runOptions.promiseMeansNotHandled) {
            return false
          }
        }
        return true
      } catch (err) {
        if (import.meta.env.DEV) {
          console.error(`[useKeyboardShortcuts] ${label} threw:`, err)
        }
        return true
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return

      const h = handlersRef.current

      const activeElement = document.activeElement as HTMLElement | null
      const isEditableFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.isContentEditable === true

      if (isEditableFocused) return

      const container = options.containerRef?.current
      const isWithinScopedContainer = !container ||
        Boolean(activeElement && container.contains(activeElement)) ||
        lastPointerInsideRef.current

      if (e.key === 'F9' && h.onRecalculate) {
        if (!isWithinScopedContainer) return
        const handled = run(h.onRecalculate, 'onRecalculate')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      const isCtrlOrCmd = e.ctrlKey || e.metaKey
      const keyLower = typeof e.key === 'string' ? e.key.toLowerCase() : ''

      if (e.repeat && isCtrlOrCmd && keyLower === 'x') {
        return
      }

      const isDeleteKey =
        e.key === 'Delete' ||
        e.key === 'Del' ||
        e.code === 'Delete'

      const isBackspaceKey =
        e.key === 'Backspace' ||
        e.code === 'Backspace'

      // Delete/Backspace (no Ctrl): clear selection
      // Only handle if focus is within the container (when containerRef is provided)
      if (!isCtrlOrCmd && (isDeleteKey || isBackspaceKey)) {
        if (container) {
          const activeInside = Boolean(activeElement && container.contains(activeElement))
          if (!activeInside && !lastPointerInsideRef.current) {
            // Focus is outside the grid container (e.g., in plots panel) - don't handle
            return
          }
        }
        const handled = run(h.onDelete, 'onDelete')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // F3 / Shift+F3 - Find Next / Find Previous (no Ctrl required)
      if (e.key === 'F3') {
        if (e.shiftKey && h.onFindPrevious) {
          const handled = run(h.onFindPrevious, 'onFindPrevious')
          if (!handled) return
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (!e.shiftKey && h.onFindNext) {
          const handled = run(h.onFindNext, 'onFindNext')
          if (!handled) return
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }

      if (!isCtrlOrCmd) return

      if (keyLower === 'c' && h.onCopy) {
        const handled = run(h.onCopy, 'onCopy')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'v' && e.shiftKey && h.onPasteValues) {
        const handled = run(h.onPasteValues, 'onPasteValues')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'v' && h.onPaste) {
        const handled = run(h.onPaste, 'onPaste')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'x' && h.onCut) {
        const handled = run(h.onCut, 'onCut')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 't' && h.onTranspose) {
        const handled = run(h.onTranspose, 'onTranspose')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      const isKeyZ = keyLower === 'z' || e.code === 'KeyZ'
      const isKeyY = keyLower === 'y' || e.code === 'KeyY'

      if (isKeyZ && e.shiftKey && h.onRedo) {
        const handled = run(h.onRedo, 'onRedo')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (isKeyZ && h.onUndo) {
        const handled = run(h.onUndo, 'onUndo')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (isKeyY && h.onRedo) {
        const handled = run(h.onRedo, 'onRedo')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'a' && h.onSelectAll) {
        const handled = run(h.onSelectAll, 'onSelectAll', { promiseMeansNotHandled: true })
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'f' && h.onFind) {
        const handled = run(h.onFind, 'onFind')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'h' && e.shiftKey && h.onHighlight) {
        // Ctrl+Shift+H - Highlight cells
        const handled = run(h.onHighlight, 'onHighlight')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (keyLower === 'h' && !e.shiftKey && h.onFindReplace) {
        // Ctrl+H - Find & Replace
        const handled = run(h.onFindReplace, 'onFindReplace')
        if (!handled) return
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture })

    // Cleanup on unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture })
    }
  }, [options.capture, options.containerRef])

  useEffect(() => {
    const container = options.containerRef?.current
    if (!container) return

    lastPointerInsideRef.current = Boolean(
      document.activeElement && container.contains(document.activeElement as Node)
    )

    const handlePointerDown = (e: Event) => {
      const target = e.target as Node | null
      lastPointerInsideRef.current = Boolean(target && container.contains(target))
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('mousedown', handlePointerDown, true)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('mousedown', handlePointerDown, true)
    }
  }, [options.containerRef])
}

export default useKeyboardShortcuts
