import { describe, expect, it } from 'vitest'
import {
  getSystemAnnotationTextHints,
  mergeAnnotationsByIdentity,
  normalizeSystemAnnotationIdentity,
} from '../annotationPersistence'

describe('annotationPersistence', () => {
  it('preserves system annotation identity when incoming relayout annotations are unnamed', () => {
    const current = [
      { name: '_xaxis_title_', text: 'Time', x: 0.5, y: -0.12 },
      { name: '_yaxis_title_', text: 'Survival Probability', x: -0.12, y: 0.5 },
    ]
    const incoming = [
      { text: 'Time', x: 0.24, y: -0.18 },
      { text: 'Survival Probability', x: -0.2, y: 0.44 },
    ]
    const rendered = [
      { name: '_xaxis_title_', text: 'Time' },
      { name: '_yaxis_title_', text: 'Survival Probability' },
    ]

    const merged = mergeAnnotationsByIdentity({ current, incoming, rendered })

    expect(merged.find((entry) => entry.name === '_xaxis_title_')).toMatchObject({
      name: '_xaxis_title_',
      x: 0.24,
      y: -0.18,
    })
    expect(merged.find((entry) => entry.name === '_yaxis_title_')).toMatchObject({
      name: '_yaxis_title_',
      x: -0.2,
      y: 0.44,
    })
  })

  it('keeps protected system annotations even when incoming payload is partial', () => {
    const current = [
      { name: '_legend_', text: 'Legend', x: 1.02, y: 1 },
      { name: '_title_', text: 'Cox Regression' },
      { text: 'custom', x: 0.3, y: 0.2 },
    ]
    const incoming = [{ text: 'custom', x: 0.35, y: 0.25 }]

    const merged = mergeAnnotationsByIdentity({ current, incoming })

    expect(merged.some((entry) => entry.name === '_legend_')).toBe(true)
    expect(merged.some((entry) => entry.name === '_title_')).toBe(true)
  })

  it('merges unnamed updates into protected entries when rendered mapping is unavailable', () => {
    const current = [{ name: '_xaxis_title_', text: 'Time', x: 0.5, y: -0.12 }]
    const incoming = [{ text: 'Time', x: 0.21, y: -0.19 }]

    const merged = mergeAnnotationsByIdentity({ current, incoming, rendered: [] })
    expect(merged.find((entry) => entry.name === '_xaxis_title_')).toMatchObject({
      name: '_xaxis_title_',
      x: 0.21,
      y: -0.19,
    })
  })

  it('normalizes unnamed system annotations by expected text', () => {
    const annotations = [
      { text: 'Time', x: 0.31, y: -0.14 },
      { text: 'Survival Probability', x: -0.16, y: 0.48 },
      { text: 'Cox Regression Analysis', x: 0.5, y: 1.08 },
    ]
    const hints = {
      titleText: 'Cox Regression Analysis',
      xAxisTitleText: 'Time',
      yAxisTitleText: 'Survival Probability',
    }

    const normalized = normalizeSystemAnnotationIdentity(annotations, hints)

    expect(normalized.changed).toBe(true)
    expect(normalized.annotations.find((entry) => entry.name === '_title_')).toBeDefined()
    expect(normalized.annotations.find((entry) => entry.name === '_xaxis_title_')).toBeDefined()
    expect(normalized.annotations.find((entry) => entry.name === '_yaxis_title_')).toBeDefined()
  })

  it('builds text hints from layout titles deterministically', () => {
    const hints = getSystemAnnotationTextHints(
      {
        xaxis: { title: { text: 'Time' } },
        yaxis: { title: { text: 'Hazard Rate' } },
      },
      'Nelson-Aalen'
    )

    expect(hints).toEqual({
      titleText: 'Nelson-Aalen',
      xAxisTitleText: 'Time',
      yAxisTitleText: 'Hazard Rate',
    })
  })

  it('does not re-tag non-paper custom annotations by text collision', () => {
    const annotations = [{ text: 'Time', xref: 'x', yref: 'y', x: 12, y: 0.5 }]
    const normalized = normalizeSystemAnnotationIdentity(annotations, {
      titleText: 'Any',
      xAxisTitleText: 'Time',
      yAxisTitleText: 'Response',
    })
    expect(normalized.annotations[0]).toMatchObject({ text: 'Time', xref: 'x', yref: 'y' })
    expect(normalized.annotations[0]?.name).toBeUndefined()
  })

  it('includes legend text hint when named legend annotation exists', () => {
    const hints = getSystemAnnotationTextHints(
      {
        xaxis: { title: { text: 'Time' } },
        yaxis: { title: { text: 'Response' } },
        annotations: [{ name: '_legend_', text: 'A<br>B' }],
      },
      'Plot'
    )
    expect(hints.legendText).toBe('AB')
  })

  it('handles survival and non-survival axis-title sets consistently', () => {
    const scenarios = [
      { title: 'Adjusted Survival Curves', x: 'Time', y: 'Survival Probability' },
      { title: 'Kaplan-Meier Curve', x: 'Time', y: 'Survival Probability' },
      { title: 'Nelson-Aalen Curve', x: 'Time', y: 'Cumulative Hazard' },
      { title: 'Scatter Plot', x: 'Dose', y: 'Response' },
    ]

    scenarios.forEach((scenario) => {
      const annotations = [
        { text: scenario.title, x: 0.5, y: 1.06 },
        { text: scenario.x, x: 0.5, y: -0.12 },
        { text: scenario.y, x: -0.12, y: 0.5 },
      ]
      const normalized = normalizeSystemAnnotationIdentity(annotations, {
        titleText: scenario.title,
        xAxisTitleText: scenario.x,
        yAxisTitleText: scenario.y,
      })
      expect(normalized.annotations.find((entry) => entry.name === '_title_')).toBeDefined()
      expect(normalized.annotations.find((entry) => entry.name === '_xaxis_title_')).toBeDefined()
      expect(normalized.annotations.find((entry) => entry.name === '_yaxis_title_')).toBeDefined()
    })
  })
})
