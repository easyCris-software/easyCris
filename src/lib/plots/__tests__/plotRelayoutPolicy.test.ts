import { describe, expect, it } from 'vitest'
import {
  hasExplicitAnnotationClearIntent,
  retainAnnotationsAfterClearIntent,
  shouldApplyFullAnnotationPayload,
} from '../plotRelayoutPolicy'

describe('plotRelayoutPolicy', () => {
  it('treats keyed null annotation deletions as explicit clear intent', () => {
    expect(
      hasExplicitAnnotationClearIntent({
        'annotations[0]': null,
      })
    ).toBe(true)
  })

  it('does not treat bare annotations array payload as explicit clear intent', () => {
    expect(
      hasExplicitAnnotationClearIntent({
        annotations: [],
      })
    ).toBe(false)
  })

  it('applies full annotation payload for keyed edits or non-empty annotations arrays', () => {
    expect(
      shouldApplyFullAnnotationPayload({
        'annotations[2].font.size': 14,
      })
    ).toBe(true)
    expect(
      shouldApplyFullAnnotationPayload({
        annotations: [{ text: 'dragged' }],
      })
    ).toBe(true)
    expect(
      shouldApplyFullAnnotationPayload({
        annotations: [],
      })
    ).toBe(false)
  })

  it('retains system and non-custom named annotations while clearing custom ones', () => {
    const retained = retainAnnotationsAfterClearIntent([
      { name: '_xaxis_title_', text: 'Time' },
      { name: 'figure_label', text: 'A' },
      { name: 'custom_markup_abc', text: 'note' },
      { meta: { customMarkup: true }, text: 'custom' },
      { text: 'unnamed' },
    ])

    expect(retained.map((entry) => entry.name)).toEqual(['_xaxis_title_', 'figure_label'])
  })
})
