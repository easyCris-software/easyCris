import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LmmAnovaConfigDialog, isLikelyGroupingFactor } from './LmmAnovaConfigDialog'
import { ColumnDataType, type ColumnClassification } from '@/lib/modules/core/types'
import { makeColumnClassification } from '@/test-utils/factories'

// ResizableDialog uses react-rnd (which requires DOM measurements) and has a 200ms
// interaction guard that swallows clicks in JSDOM. Replace the shell with thin wrappers
// that expose the same slots without any resize/drag/timer behaviour.
vi.mock('@/components/ui/resizable-dialog', () => ({
  ResizableDialog: ({ open, children }: any) =>
    open ? <div data-testid="mock-resizable-dialog">{children}</div> : null,
  ResizableDialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  ResizableDialogHeader: ({ children }: any) => <div>{children}</div>,
  ResizableDialogTitle: ({ children }: any) => <h2>{children}</h2>,
  ResizableDialogDescription: ({ children }: any) => <p>{children}</p>,
  ResizableDialogFooter: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

// react-resizable-panels also calls getBoundingClientRect which returns 0 in JSDOM.
// Replace with simple flex divs so the split renders without measurement errors.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children, ...props }: any) => (
    <div style={{ display: 'flex', height: '100%' }} {...props}>{children}</div>
  ),
  ResizablePanel: ({ children }: any) => (
    <div style={{ flex: 1, overflow: 'auto' }}>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resize-handle" />,
}))

function makeColumn(
  columnName: string,
  columnId: string,
  dataType: ColumnDataType,
  uniqueValues: string[] = []
): ColumnClassification {
  return makeColumnClassification({
    columnName,
    columnId,
    dataType,
    uniqueValueCount: uniqueValues.length || 10,
    uniqueValues,
    numericValues: dataType === ColumnDataType.Numeric || dataType === ColumnDataType.Ordinal ? 10 : 0,
    categoricalValues: dataType === ColumnDataType.Numeric || dataType === ColumnDataType.Ordinal ? 0 : 10,
    numericRatio: dataType === ColumnDataType.Numeric || dataType === ColumnDataType.Ordinal ? 1 : 0,
    isBinary: dataType === ColumnDataType.Binary,
  })
}

describe('LmmAnovaConfigDialog', () => {
  const columns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
    makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['Control', 'Drug']),
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
    makeColumn('Day', 'day_num', ColumnDataType.Numeric),
  ]

  it('labels the dialog as Linear Mixed Model and defaults time-like numeric predictors to categorical', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: 'Linear Mixed Model' })).toBeInTheDocument()
    expect(screen.getByTestId('lmm-predictor-type-day_num')).toHaveValue('categorical')
    expect(screen.getByTestId('lmm-predictor-type-treatment')).toHaveValue('categorical')
  })

  it('defaults compound time-like predictor names to categorical', () => {
    const compoundTimeColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Day_num', 'day_num', ColumnDataType.Numeric),
      makeColumn('TimePoint', 'time_point', ColumnDataType.Numeric),
      makeColumn('Dose', 'dose', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={compoundTimeColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-predictor-type-day_num')).toHaveValue('categorical')
    expect(screen.getByTestId('lmm-predictor-type-time_point')).toHaveValue('categorical')
    expect(screen.getByTestId('lmm-predictor-type-dose')).toHaveValue('continuous')
  })

  it('shows a line-chart header icon and keeps unchecked available predictors readable', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-dialog-header-icon')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-predictor-label-day_num')).not.toHaveClass('text-zinc-400')
  })

  it('renders stable test ids and reveals slope controls only for random-slope mode', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-anova-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-dv-select')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-group-select')).toBeInTheDocument()
  expect(screen.getByTestId('lmm-interaction-depth')).toBeInTheDocument()
  expect(screen.getByTestId('lmm-df-method')).toBeInTheDocument()
  expect(screen.getByTestId('lmm-df-method')).toHaveValue('satterthwaite')
  expect(screen.getByTestId('lmm-adjustment-method')).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Kenward-Roger/i })).toBeInTheDocument()
  expect(screen.getByTestId('lmm-reml-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-random-structure-intercept')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-random-structure-slope')).toBeInTheDocument()
    expect(screen.queryByTestId('lmm-random-slope-select')).not.toBeInTheDocument()
    expect(screen.getByTestId('lmm-next-button')).toBeInTheDocument()

    await user.click(screen.getByTestId('lmm-random-structure-slope'))

    expect(screen.queryByTestId('lmm-random-slope-select')).not.toBeInTheDocument()
    expect(
      screen.getByText('Select at least one predictor and treat it as Numeric to enable a varying-change predictor.')
    ).toBeInTheDocument()
  })

  it('always exposes adjustment controls and FDR q in the main dialog', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-adjustment-method')).toHaveValue('tukey')

    await user.selectOptions(screen.getByTestId('lmm-adjustment-method'), 'fdr_bh')

    expect(screen.getByTestId('lmm-posthoc-q')).toBeInTheDocument()
    await user.clear(screen.getByTestId('lmm-posthoc-q'))
    await user.type(screen.getByTestId('lmm-posthoc-q'), '0.1')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        adjustmentMethod: 'fdr_bh',
        posthocQ: 0.1,
      }),
    })
  })

  it('explains that Kenward-Roger may use REML-based inference even when ML was requested', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-df-method'), 'kenward_roger')

    expect(
      screen.getByText(/Kenward-Roger uses REML-based inference/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/the model may be internally refit with REML for inference/i)
    ).toBeInTheDocument()
  })

  it('falls back to satterthwaite and disables Kenward-Roger when random slope is selected', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-df-method'), 'kenward_roger')
    expect(screen.getByTestId('lmm-df-method')).toHaveValue('kenward_roger')

    await user.click(screen.getByTestId('lmm-random-structure-slope'))

    expect(screen.getByTestId('lmm-df-method')).toHaveValue('satterthwaite')
    expect(screen.getByRole('option', { name: /Kenward-Roger/i })).toBeDisabled()
    expect(
      screen.getByText(/Kenward-Roger currently supports only random-intercept models/i)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Kenward-Roger uses REML-based inference/i)
    ).not.toBeInTheDocument()
  })

  it('normalizes unsupported KR to satterthwaite during confirm for random-slope mode', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.selectOptions(screen.getByTestId('lmm-dv-select'), 'value')
    await user.selectOptions(screen.getByTestId('lmm-group-select'), 'sample_id')
    await user.selectOptions(screen.getByTestId('lmm-df-method'), 'kenward_roger')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    expect(screen.getByTestId('lmm-random-slope-select')).toBeInTheDocument()
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_slope',
      }),
    })
  })

  it('returns structured config with one numeric random slope target', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.selectOptions(screen.getByTestId('lmm-dv-select'), 'value')
    await user.selectOptions(screen.getByTestId('lmm-group-select'), 'sample_id')
    await user.clear(screen.getByTestId('lmm-interaction-depth'))
    await user.type(screen.getByTestId('lmm-interaction-depth'), '3')
    await user.selectOptions(screen.getByTestId('lmm-df-method'), 'residual')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    await user.selectOptions(screen.getByTestId('lmm-random-slope-select'), 'day_num')
    // Stratified mode is on by default. Sex (Binary) is auto-selected via GROUPING_PATTERN.
    await user.click(screen.getByTestId('lmm-reml-toggle'))
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        dependentColumnId: 'value',
        subjectColumnId: 'sample_id',
        predictorColumnIds: ['treatment', 'day_num'],
        predictorTypes: {
          treatment: 'categorical',
          day_num: 'continuous',
          sex: 'categorical',
        },
        reml: true,
        stratified: true,
        stratifyBy: ['sex'],
        randomEffectsMode: 'random_slope',
        randomSlopeTarget: 'day_num',
        interactionDepth: 2,
        dfMethod: 'residual',
        adjustmentMethod: 'tukey',
        controlLevels: {},
        posthocQ: undefined,
      }),
    })
  })

  it('explains when the simple-effects follow-up will be skipped because fewer than two categorical predictors remain', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    await user.selectOptions(screen.getByTestId('lmm-random-slope-select'), 'day_num')

    expect(
      screen.getByText(/simple-effects follow-up will be skipped/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/fewer than two categorical predictors remain inside each subgroup model/i)
    ).toBeInTheDocument()
  })

  it('lets users choose simple effects inline in the main dialog and returns them in the config', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('Simple Effects')).toBeInTheDocument()
    expect(screen.getByText(/Drug A vs Control/i)).toBeInTheDocument()

    await user.click(screen.getByTestId('lmm-simple-effect-toggle-treatment-within-day_num'))
    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        simpleEffects: [{ factor: 'Treatment', within: 'Day' }],
      }),
    })
  })

  it('returns numeric-time follow-up config in onConfirm for random-slope models', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    await user.selectOptions(screen.getByTestId('lmm-random-slope-select'), 'day_num')

    expect(screen.getByTestId('lmm-enable-continuous-followup')).toBeInTheDocument()
    expect(
      screen.getByText(/random-slope numeric-time follow-up is experimental/i)
    ).toBeInTheDocument()

    await user.click(screen.getByTestId('lmm-enable-continuous-followup'))
    await user.clear(screen.getByTestId('lmm-continuous-time-values'))
    await user.type(screen.getByTestId('lmm-continuous-time-values'), '0,2,4')

    expect(screen.getByTestId('lmm-continuous-group-factor')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-continuous-time-values')).toBeInTheDocument()

    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        randomEffectsMode: 'random_slope',
        randomSlopeTarget: 'day_num',
        continuousEffectsConfig: {
          mode: 'at_values',
          groupFactorId: 'treatment',
          timeFactorId: 'day_num',
          timeValues: [0, 2, 4],
        },
      }),
    })
  })

  it('only offers categorical columns that are not selected as tested predictors as stratification factors', async () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Treatment is selected as a tested predictor by default, so it cannot be selected as a strata factor.
    expect(screen.queryByTestId('lmm-stratify-factor-treatment')).not.toBeInTheDocument()
    expect(screen.getByTestId('lmm-stratify-factor-sex')).toBeInTheDocument()
    // Numeric Day is not eligible for stratification factors.
    expect(screen.queryByTestId('lmm-stratify-factor-day_num')).not.toBeInTheDocument()
  })

  it('allows stratification for numeric-imported factors after users assign a categorical role', async () => {
    const user = userEvent.setup()
    const numericFactorColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['Control', 'Drug']),
      makeColumn('Sex Code', 'sex_code', ColumnDataType.Numeric, ['0', '1']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={numericFactorColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByTestId('lmm-stratify-factor-sex_code')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-sex_code'), 'categorical')
    await user.click(screen.getByTestId('lmm-predictor-toggle-sex_code'))

    expect(screen.getByTestId('lmm-stratify-factor-sex_code')).toBeInTheDocument()
  })

  it('uses dynamic random-effect labels and explains when no numeric slope predictor is eligible', async () => {
    const user = userEvent.setup()
    const categoricalOnlyColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Trait', 'trait', ColumnDataType.Categorical, ['A', 'B']),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={categoricalOnlyColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('(1 | Sample ID)')).toBeInTheDocument()

    await user.click(screen.getByTestId('lmm-random-structure-slope'))

    expect(screen.getByText('(1 + slope | Sample ID)')).toBeInTheDocument()
    expect(
      screen.getByText('Select at least one predictor and treat it as Numeric to enable a varying-change predictor.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('lmm-random-slope-select')).not.toBeInTheDocument()
    expect(screen.queryByText('(1 + Time | ID)')).not.toBeInTheDocument()
  })

  it('is stratified by default with one obvious grouping factor auto-selected', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Pooled mode is hidden in this release; dialog stays stratified.
    expect(screen.queryByTestId('lmm-pooled-toggle')).not.toBeInTheDocument()
    // Sex matches GROUPING_PATTERN and is auto-checked as a strata factor.
    expect(screen.getByTestId('lmm-stratify-factor-sex')).toBeChecked()
    // Stratification factors are disjoint from tested predictors.
    expect(screen.getByTestId('lmm-predictor-toggle-sex')).not.toBeChecked()
    // Treatment remains in tested predictors and is therefore absent from stratification options.
    expect(screen.queryByTestId('lmm-stratify-factor-treatment')).not.toBeInTheDocument()
  })

  it('does not auto-select a subgroup factor when no obvious grouping column exists', () => {
    const noGroupingColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['Control', 'Drug']),
      makeColumn('Condition', 'condition', ColumnDataType.Categorical, ['A', 'B']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={noGroupingColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByTestId('lmm-pooled-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lmm-stratify-factor-treatment')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lmm-stratify-factor-condition')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Select at least one stratification factor\./i)
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Choose at least one subgroup factor\./i)
    ).toBeInTheDocument()
  })

  it('prunes stale subgroup selections when subject changes make a factor ineligible', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-stratify-factor-sex')).toBeChecked()

    await user.selectOptions(screen.getByTestId('lmm-group-select'), 'sex')
    expect(screen.queryByTestId('lmm-stratify-factor-sex')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByTestId('lmm-group-select'), 'sample_id')
    expect(screen.getByTestId('lmm-stratify-factor-sex')).not.toBeChecked()
  })

  it('keeps subgroup section visible because pooled mode toggle is hidden', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByTestId('lmm-pooled-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('lmm-stratify-factor-sex')).toBeInTheDocument()
  })

  it('live strata preview renders possible subgroup combinations from selected factor levels', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Sex is auto-selected and has uniqueValues ['M', 'F'] — 2 possible combinations shown.
    expect(screen.getByTestId('lmm-strata-preview')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-stratum-row-0')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-stratum-row-1')).toBeInTheDocument()
    expect(screen.queryByTestId('lmm-stratum-row-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('lmm-strata-count')).toHaveTextContent('2')
    expect(screen.getByTestId('lmm-strata-count')).toHaveTextContent('possible combinations')

    // Move Treatment from tested predictors to stratification, then expect 2 × 2 = 4 combinations.
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    expect(screen.getByTestId('lmm-stratify-factor-treatment')).toBeInTheDocument()
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    expect(screen.getByTestId('lmm-strata-count')).toHaveTextContent('4')
    expect(screen.getByTestId('lmm-stratum-row-3')).toBeInTheDocument()
  })

  it('caps displayed subgroup preview rows while still showing exact combination count', async () => {
    const user = userEvent.setup()
    const denseColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Group', 'group', ColumnDataType.Categorical, ['G1', 'G2', 'G3', 'G4', 'G5']),
      makeColumn('Factor A', 'factor_a', ColumnDataType.Categorical, ['A1', 'A2', 'A3', 'A4', 'A5']),
      makeColumn('Factor B', 'factor_b', ColumnDataType.Categorical, ['B1', 'B2', 'B3', 'B4', 'B5']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={denseColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-factor_a'))
    await user.click(screen.getByTestId('lmm-predictor-toggle-factor_b'))
    await user.click(screen.getByTestId('lmm-stratify-factor-factor_a'))
    await user.click(screen.getByTestId('lmm-stratify-factor-factor_b'))

    const countText = screen.getByTestId('lmm-strata-count').textContent ?? '0'
    const countMatch = countText.match(/\d+/)
    const totalCount = Number(countMatch?.[0] ?? '0')
    expect(totalCount).toBeGreaterThan(20)
    expect(screen.getByTestId('lmm-stratum-row-19')).toBeInTheDocument()
    expect(screen.queryByTestId('lmm-stratum-row-20')).not.toBeInTheDocument()
    expect(screen.getByText(/\+\d+ more/)).toBeInTheDocument()
  })

  it('clamps interaction depth to the predictors that remain inside the model', () => {
    const mostlyStratifiedColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={mostlyStratifiedColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-interaction-depth')).toHaveValue(1)
    expect(screen.getByTestId('lmm-interaction-depth')).toHaveAttribute('max', '1')
  })

  it('submits the effective clamped interaction depth even if the raw input is higher', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.clear(screen.getByTestId('lmm-interaction-depth'))
    await user.type(screen.getByTestId('lmm-interaction-depth'), '3')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        interactionDepth: 2,
      }),
    })
  })

  it('formula preview shows explicit interaction terms for the effective within-subgroup model', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-formula-preview')).toHaveTextContent(
      'Value ~ (Treatment * Day) + (1 | Sample ID)'
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    expect(screen.getByTestId('lmm-formula-preview')).toHaveTextContent(
      'Value ~ Day + (1 | Sample ID)'
    )
  })

  it('shows all subgrouped-away predictors in the what-will-be-tested panel', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-subgrouped-away-preview')).toHaveTextContent('Sex')
    expect(screen.getByText(/removed from each subgroup model/i)).toBeInTheDocument()
  })

  it('warns when a manually selected comparison-like subgroup factor uses a broader comparison-axis name', async () => {
    const user = userEvent.setup()
    const groupColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Group', 'group', ColumnDataType.Categorical, ['VEH', 'THC']),
      makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={groupColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-group'))
    await user.click(screen.getByTestId('lmm-stratify-factor-group'))

    expect(screen.getByTestId('lmm-comparison-warning')).toHaveTextContent(
      'Group comparisons will not be available inside each subgroup model.'
    )
  })

  it('shows the omnibus terms that will be tested inside each subgroup model', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-interaction-depth')).toHaveValue(2)
    expect(screen.getByTestId('lmm-omnibus-terms-preview')).toHaveTextContent('Treatment')
    expect(screen.getByTestId('lmm-omnibus-terms-preview')).toHaveTextContent('Day')
    expect(screen.getByTestId('lmm-omnibus-terms-preview')).toHaveTextContent('Treatment x Day')

    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    expect(screen.getByTestId('lmm-omnibus-terms-preview')).toHaveTextContent('Day')
    expect(screen.getByTestId('lmm-omnibus-terms-preview')).not.toHaveTextContent('Treatment x Day')
  })

  it('handles empty columns safely and keeps continue disabled', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-anova-dialog')).toBeInTheDocument()
    expect(screen.getByText(/Choose an outcome variable\./i)).toBeInTheDocument()
    expect(screen.getByTestId('lmm-next-button')).toBeDisabled()
  })

  it('rejects numeric-time input when any token is invalid', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    await user.selectOptions(screen.getByTestId('lmm-random-slope-select'), 'day_num')
    await user.click(screen.getByTestId('lmm-enable-continuous-followup'))
    await user.clear(screen.getByTestId('lmm-continuous-time-values'))
    await user.type(screen.getByTestId('lmm-continuous-time-values'), '0,2x,4')

    expect(screen.getByTestId('lmm-continuous-time-invalid')).toHaveTextContent(
      /Invalid numeric value\(s\): 2x/i
    )
    expect(screen.getByTestId('lmm-next-button')).toBeDisabled()

    await user.click(screen.getByTestId('lmm-next-button'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('deduplicates numeric-time values before submit while preserving order', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-day_num'), 'continuous')
    await user.click(screen.getByTestId('lmm-random-structure-slope'))
    await user.selectOptions(screen.getByTestId('lmm-random-slope-select'), 'day_num')
    await user.click(screen.getByTestId('lmm-enable-continuous-followup'))
    await user.clear(screen.getByTestId('lmm-continuous-time-values'))
    await user.type(screen.getByTestId('lmm-continuous-time-values'), '0,2,2.0,4,2')
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        continuousEffectsConfig: expect.objectContaining({
          timeValues: [0, 2, 4],
        }),
      }),
    })
  })

  it('warns when a selected subgroup factor has fewer than 2 levels', () => {
    const lowVarianceColumns = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
      makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['Control', 'Drug']),
      makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M']),
      makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={lowVarianceColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-trivial-strata-warning')).toHaveTextContent('Sex')
    expect(screen.getByText(/has only one profiled level/i)).toBeInTheDocument()
  })

  it('removes a strata factor when it is selected as a tested predictor', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    expect(screen.getByTestId('lmm-stratify-factor-treatment')).toBeInTheDocument()
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))
    expect(screen.getByTestId('lmm-predictor-toggle-treatment')).not.toBeChecked()
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))

    expect(screen.getByTestId('lmm-predictor-toggle-treatment')).toBeChecked()
    expect(screen.queryByTestId('lmm-stratify-factor-treatment')).not.toBeInTheDocument()
  })

  it('keeps stratification factors categorical and prevents role flips to continuous while stratified', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    expect(screen.getByTestId('lmm-stratify-factor-treatment')).toBeChecked()
    expect(screen.getByTestId('lmm-predictor-type-treatment')).toHaveValue('categorical')

    await user.selectOptions(screen.getByTestId('lmm-predictor-type-treatment'), 'continuous')

    expect(screen.getByTestId('lmm-stratify-factor-treatment')).toBeChecked()
    expect(screen.getByTestId('lmm-predictor-type-treatment')).toHaveValue('categorical')
  })

  it('keeps predictor and stratification selections disjoint in confirm payload', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))
    await user.click(screen.getByTestId('lmm-next-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      cancelled: false,
      config: expect.objectContaining({
        predictorColumnIds: expect.not.arrayContaining(['treatment']),
        stratifyBy: expect.arrayContaining(['sex', 'treatment']),
      }),
    })
  })

  it('provides explicit accessible labels for predictor role selects', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Role for Treatment')).toBeInTheDocument()
    expect(screen.getByLabelText('Role for Day')).toBeInTheDocument()
  })

  it('self-heal: trajectory section hides when predictor moves to stratification leaving fewer than 2 candidates (Reviewer A regression)', async () => {
    // Start: Treatment + Day are both categorical predictors → trajectory roles auto-assigned.
    // Action: move Treatment to stratification → it leaves withinModelCategoricalPredictors.
    // Expect: trajectoryRoleEligible becomes false → section hidden (no stale selects remain).
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Trajectory section visible with ≥2 categorical predictors
    expect(screen.getByTestId('lmm-trajectory-treatment-factor')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-trajectory-time-factor')).toBeInTheDocument()

    // Move Treatment out of tested predictors → stratification; only Day remains as categorical predictor
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    // With <2 candidates, trajectoryRoleEligible=false → section hidden entirely
    expect(screen.queryByTestId('lmm-trajectory-treatment-factor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lmm-trajectory-time-factor')).not.toBeInTheDocument()
  })

  it('self-heal 2→1→2: no stale-invalid IDs when Treatment is moved to strata then back to model', async () => {
    // Transition: 2 candidates → 1 (section hides) → 2 again (section reappears).
    // Assert: any non-empty TR select value refers to an existing candidate option (no stale pointers).
    // Selects may be empty if the user never chose roles — that is also valid.
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={columns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('lmm-trajectory-treatment-factor')).toBeInTheDocument()

    // User sets treatment='treatment', time='day_num' explicitly
    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')

    // Move Treatment to strata → only Day remains → section hides (< 2 candidates)
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))
    expect(screen.queryByTestId('lmm-trajectory-treatment-factor')).not.toBeInTheDocument()

    // Re-add Treatment to tested predictors → section reappears
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    expect(screen.getByTestId('lmm-trajectory-treatment-factor')).toBeInTheDocument()

    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement
    const treatOptions = Array.from(treatSelect.options).map(o => o.value).filter(v => v !== '')
    const timeOptions = Array.from(timeSelect.options).map(o => o.value).filter(v => v !== '')

    // Any non-empty value must be a valid eligible candidate (no stale pointers)
    if (treatSelect.value !== '') expect(treatOptions).toContain(treatSelect.value)
    if (timeSelect.value !== '') expect(timeOptions).toContain(timeSelect.value)
    // If both non-empty, they must differ
    if (treatSelect.value !== '' && timeSelect.value !== '') {
      expect(treatSelect.value).not.toBe(timeSelect.value)
    }
  })
})

describe('LmmAnovaConfigDialog — trajectory section UX hint when gate is not yet met', () => {
  // When user has a stratification factor but fewer than 2 categorical model predictors,
  // the TR section is hidden. A hint must explain what is needed.
  const hintColumns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
    makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['Control', 'Drug']),
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
    makeColumn('Day', 'day_num', ColumnDataType.Numeric),
  ]

  it('shows a hint explaining TR section requirements when stratified but only 1 categorical model predictor', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={hintColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Move Treatment to strata → only Day (categorical) remains as model predictor → < 2 categorical
    await user.click(screen.getByTestId('lmm-predictor-toggle-treatment'))
    await user.click(screen.getByTestId('lmm-stratify-factor-treatment'))

    // TR section must be hidden (only 1 categorical model predictor now)
    expect(screen.queryByTestId('lmm-trajectory-treatment-factor')).not.toBeInTheDocument()

    // A hint must be visible explaining the requirement
    expect(screen.getByTestId('lmm-trajectory-gate-hint')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-trajectory-gate-hint').textContent).toMatch(/2 categorical/i)
  })

  it('hides the hint when TR section is eligible (≥2 categorical predictors + strata)', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={hintColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // With defaults: Treatment + Day both categorical, Sex auto-stratified → TR section visible
    expect(screen.getByTestId('lmm-trajectory-treatment-factor')).toBeInTheDocument()
    // No hint when section is visible
    expect(screen.queryByTestId('lmm-trajectory-gate-hint')).not.toBeInTheDocument()
  })
})

describe('LmmAnovaConfigDialog — trajectory selects start empty (no auto-assignment)', () => {
  // Default state must be placeholder / empty for both TR selects.
  // Auto-assignment would pick based on heuristics that can be wrong (Day→treatment, Condition→time).
  // User must explicitly choose their own roles.
  it('shows placeholder in both TR selects on open even when ≥2 categorical predictors are available', () => {
    const twoCategories = [
      makeColumn('Value', 'value', ColumnDataType.Numeric),
      makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2']),
      makeColumn('Day', 'day', ColumnDataType.Categorical, ['0', '1', '2']),
      makeColumn('Condition', 'condition', ColumnDataType.Categorical, ['A', 'B']),
      makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
    ]

    render(
      <LmmAnovaConfigDialog
        open
        columns={twoCategories}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement
    // Both must start as placeholder — no auto-assignment
    expect(treatSelect.value).toBe('')
    expect(timeSelect.value).toBe('')
  })
})

describe('LmmAnovaConfigDialog — trajectory auto-fill on mid-session 0→2 candidate transition', () => {
  // Columns: all model predictors start as continuous → catModelPredictors=0 at init → TR IDs=''.
  // Sex is auto-stratified (Binary, isLikelyGroupingFactor). Arm+Dose are Numeric (not time-like).
  // After user changes Arm and Dose to categorical, section appears — both selects remain empty.
  // User chooses their own roles (no auto-assignment).
  const sparseColumns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
    makeColumn('Arm', 'arm', ColumnDataType.Numeric),    // not time-like → starts continuous
    makeColumn('Dose', 'dose', ColumnDataType.Numeric),  // not time-like → starts continuous
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),  // auto-stratified
  ]

  it('shows section with empty selects after 0→2 categorical transition — user chooses roles manually', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={sparseColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Section should be hidden at init (0 categorical model predictors)
    expect(screen.queryByTestId('lmm-trajectory-treatment-factor')).not.toBeInTheDocument()

    // Change Arm to categorical
    await user.selectOptions(screen.getByTestId('lmm-predictor-type-arm'), 'categorical')
    expect(screen.queryByTestId('lmm-trajectory-treatment-factor')).not.toBeInTheDocument()

    // Change Dose to categorical → section appears with both candidates available
    await user.selectOptions(screen.getByTestId('lmm-predictor-type-dose'), 'categorical')
    expect(screen.getByTestId('lmm-trajectory-treatment-factor')).toBeInTheDocument()
    expect(screen.getByTestId('lmm-trajectory-time-factor')).toBeInTheDocument()

    // Both selects must remain empty — user decides their own roles
    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement
    expect(treatSelect.value).toBe('')
    expect(timeSelect.value).toBe('')
  })
})

describe('LmmAnovaConfigDialog — auto-fill does not re-fill user-cleared selects on subsequent re-renders', () => {
  // Regression for Reviewer B Issue 3:
  // If user clears both TR selects and then anything triggers a new trajectoryRoleCandidates
  // array reference (same count ≥2), the auto-fill must NOT re-fill against the user's intent.
  // Three categorical predictors: Day (time-like), Condition, Arm.
  // After auto-fill, user clears both selects.
  // Changing Arm predictor type to continuous and back triggers new candidates references.
  // Selects must stay empty.
  const threeColumns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2', 'S3']),
    makeColumn('Day', 'day', ColumnDataType.Categorical, ['0', '1', '2']),
    makeColumn('Condition', 'condition', ColumnDataType.Categorical, ['A', 'B']),
    makeColumn('Arm', 'arm', ColumnDataType.Categorical, ['VEH', 'THC']),
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
  ]

  it('does not re-fill selects when user has cleared them and candidates get a new array reference', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={threeColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // TR section should be visible with 3 categorical model predictors
    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement
    expect(treatSelect).toBeInTheDocument()
    expect(timeSelect).toBeInTheDocument()

    // User manually clears treatment factor
    await user.selectOptions(treatSelect, '')
    // User manually clears time factor
    await user.selectOptions(timeSelect, '')
    expect(treatSelect.value).toBe('')
    expect(timeSelect.value).toBe('')

    // Trigger a new array reference for trajectoryRoleCandidates (same count ≥2)
    // by changing Arm predictor type to continuous and back to categorical.
    // This causes withinModelCategoricalPredictors to recompute (new ref with 2 elements → back to 3).
    await user.selectOptions(screen.getByTestId('lmm-predictor-type-arm'), 'continuous')
    await user.selectOptions(screen.getByTestId('lmm-predictor-type-arm'), 'categorical')

    // Selects must remain empty — the auto-fill must NOT re-fire for count ≥2 re-renders
    expect(treatSelect.value).toBe('')
    expect(timeSelect.value).toBe('')
  })
})

describe('LmmAnovaConfigDialog — trajectory dropdowns never produce single-option dead-end', () => {
  // Root cause of the screenshot bug: cross-filtered selects let state get "stuck" where
  // one dropdown shows only 1 option and the other appears blank, blocking the user.
  // Fix: show ALL candidates in both selects (use disabled, not filter-out).
  // Regression tests:
  //   1. Both selects always expose all candidates as choosable options.
  //   2. After any candidate-set change the normalizer auto-repairs a same-ID conflict.

  const twoColumns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2']),
    makeColumn('Day', 'day', ColumnDataType.Categorical, ['0', '1', '2']),       // time-like
    makeColumn('Condition', 'condition', ColumnDataType.Categorical, ['A', 'B']), // treatment
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),                  // auto-strat
  ]

  it('treatment select shows all candidates including the currently-selected time factor', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const treatOptionValues = Array.from(treatSelect.options).map(o => o.value).filter(v => v !== '')

    // Both Day AND Condition must appear in the treatment dropdown regardless of what is
    // currently selected in the time dropdown.
    expect(treatOptionValues).toContain('day')
    expect(treatOptionValues).toContain('condition')
  })

  it('time select shows all candidates including the currently-selected treatment factor', () => {
    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement
    const timeOptionValues = Array.from(timeSelect.options).map(o => o.value).filter(v => v !== '')

    // Both Day AND Condition must appear in the time dropdown regardless of what is
    // currently selected in the treatment dropdown.
    expect(timeOptionValues).toContain('day')
    expect(timeOptionValues).toContain('condition')
  })

  it('normalizer immediately auto-repairs when user picks same predictor for both roles', async () => {
    // If the user manually picks the same predictor for both treatment and time, the
    // normalizer must immediately reassign the other role to a different candidate.
    // This prevents the "same-ID stuck state" that blocks Continue.
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const treatSelect = screen.getByTestId('lmm-trajectory-treatment-factor') as HTMLSelectElement
    const timeSelect = screen.getByTestId('lmm-trajectory-time-factor') as HTMLSelectElement

    // Selects start empty — user explicitly sets treatment='condition', time='day'
    await user.selectOptions(treatSelect, 'condition')
    await user.selectOptions(timeSelect, 'day')
    expect(treatSelect.value).toBe('condition')
    expect(timeSelect.value).toBe('day')

    // User changes treatment to 'day' — now both would be 'day' (conflict)
    await user.selectOptions(treatSelect, 'day')

    // Normalizer must immediately repair: roles must be distinct non-empty values
    expect(treatSelect.value).not.toBe(timeSelect.value)
    expect(treatSelect.value).not.toBe('')
    expect(timeSelect.value).not.toBe('')
  })
})

describe('LmmAnovaConfigDialog — one-filled/one-empty trajectory roles blocks Continue', () => {
  // Regression: with no auto-fill, a user can set treatment but leave time empty (or vice versa).
  // Continue must stay blocked (validationMessage present) until both are filled.
  const twoColumns = [
    makeColumn('Value', 'value', ColumnDataType.Numeric),
    makeColumn('Sample ID', 'sample_id', ColumnDataType.Categorical, ['S1', 'S2']),
    makeColumn('Treatment', 'treatment', ColumnDataType.Categorical, ['A', 'B']),
    makeColumn('Day', 'day_num', ColumnDataType.Numeric),
    makeColumn('Sex', 'sex', ColumnDataType.Binary, ['M', 'F']),
  ]

  it('Continue is disabled when treatment factor set but time factor empty', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    // time factor left empty

    expect(screen.getByTestId('lmm-next-button')).toBeDisabled()
  })

  it('Continue is disabled when time factor set but treatment factor empty', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')
    // treatment factor left empty

    expect(screen.getByTestId('lmm-next-button')).toBeDisabled()
  })

  it('Continue is enabled once both trajectory factors are set', async () => {
    const user = userEvent.setup()

    render(
      <LmmAnovaConfigDialog
        open
        columns={twoColumns}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await user.selectOptions(screen.getByTestId('lmm-trajectory-treatment-factor'), 'treatment')
    await user.selectOptions(screen.getByTestId('lmm-trajectory-time-factor'), 'day_num')

    expect(screen.getByTestId('lmm-next-button')).not.toBeDisabled()
  })
})

describe('isLikelyGroupingFactor', () => {
  it('returns false for arm — arm is a comparison axis not a grouping dimension', () => {
    expect(isLikelyGroupingFactor('arm')).toBe(false)
  })

  it('returns false for treatment arm', () => {
    expect(isLikelyGroupingFactor('treatment arm')).toBe(false)
  })

  it('returns false for study_arm', () => {
    expect(isLikelyGroupingFactor('study_arm')).toBe(false)
  })

  it('returns true for sex — a biological grouping dimension', () => {
    expect(isLikelyGroupingFactor('sex')).toBe(true)
  })

  it('returns true for cohort — a subgroup dimension', () => {
    expect(isLikelyGroupingFactor('cohort')).toBe(true)
  })

  it('returns false for treatment — explicit comparison axis', () => {
    expect(isLikelyGroupingFactor('treatment')).toBe(false)
  })

  it('returns false for drug — explicit comparison axis', () => {
    expect(isLikelyGroupingFactor('drug')).toBe(false)
  })
})
