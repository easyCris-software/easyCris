import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { RNAseqTabBar } from '../RNAseqTabBar'

describe('RNAseqTabBar lock behavior', () => {
  it('disables tab interactions while lock is active', () => {
    const onTabChange = vi.fn()

    render(
      <RNAseqTabBar
        activeTab="counts"
        onTabChange={onTabChange}
        hasCountsData
        hasMetadataData
        hasResults
        isLocked
      />
    )

    const metadataTab = screen.getByRole('button', { name: /metadata/i })
    expect(metadataTab).toBeDisabled()
    fireEvent.click(metadataTab)
    expect(onTabChange).not.toHaveBeenCalled()
  })
})

