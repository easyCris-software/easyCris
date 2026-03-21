import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LmmAnovaConfigDialog } from './LmmAnovaConfigDialog'
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
})
