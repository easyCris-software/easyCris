/**
 * Factorial ANOVA ECP-Style Table Builder
 *
 * 🔒 LOCKED - FULLY VALIDATED UI COMPONENT 🔒
 *
 * This file is LOCKED and should NOT be modified without user permission.
 *
 * Status: Fully validated against baseline
 * - Two-Way ANOVA: 64/64 metrics validated (44 main effects + 20 simple effects)
 * - Multifactorial ANOVA: 56/56 metrics validated (44 main effects + 12 simple effects)
 * - P-value formatting: Scientific notation (e.g., 1.053e-07)
 * - Standard Error: Pooled error from overall ANOVA
 * - Simple effects: Use pooled MSE (not separate error terms)
 * - Excel export validated and working
 *
 * Handles Two-Way ANOVA and Multi-Factorial ANOVA outputs from the Python backend.
 * Supports unlimited main effects/interactions and displays effect size + cell means.
 *
 * DO NOT MODIFY without re-validation against baseline.
 */

import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  ECPCell,
  ECPColumn,
  TableBuilderOptions,
} from '../../types/ecpStyleTables'
import { formatNumber, formatPValue, formatDF, formatEffectSize, formatStatistic } from './index'
import { Logger } from '@/utils/logger'

const ecpLogger = new Logger('ECP-Builder')

interface EffectRow {
  label: string
  df?: number
  ss?: number
  ms?: number
  stat?: number
  p?: number
}

interface EffectSizeRow {
  label: string
  eta?: number
  omega?: number
  interpretation?: string
}

// Legacy interface - kept for reference
// interface SimpleEffectGroup {
//   scopeLabel: string
//   method: string
//   rows: Array<Record<string, unknown>>
// }

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return isNaN(value) ? undefined : value
  }

  if (typeof value === 'string') {
    const cleaned = value.trim()
    if (!cleaned || cleaned === '.') {
      return undefined
    }
    const parsed = parseFloat(cleaned)
    return isNaN(parsed) ? undefined : parsed
  }

  return undefined
}

const parseInteger = (value: unknown): number | undefined => {
  const num = parseNumber(value)
  return num === undefined ? undefined : Math.round(num)
}

const formatDFValue = (df?: number): string => {
  if (df === undefined) {
    return '.'
  }
  return formatDF(df)
}

const formatMaybeNumber = (value: number | undefined, decimals: number): string => {
  if (value === undefined) {
    return '.'
  }
  return formatNumber(value, decimals)
}

const formatMaybeStatistic = (value: number | undefined, decimals: number): string => {
  if (value === undefined) {
    return '.'
  }
  return formatStatistic(value, decimals)
}

const formatMaybePValue = (
  value: number | undefined,
  options: Required<TableBuilderOptions>
): { text: string; isSignificant: boolean } => {
  if (value === undefined) {
    return { text: '.', isSignificant: false }
  }
  return {
    text: formatPValue(value, options.pValueThreshold, options.minPValue),
    isSignificant: value < options.alpha,
  }
}

const normalizeFactorLabel = (label: string | undefined, fallback: string): string => {
  return (label ?? fallback).trim()
}

const replaceInteractionSeparator = (label: string): string =>
  label.replace(/\s+[x×*]\s+/gi, ' by ')

const formatInteractionLabel = (left: string, right: string): string =>
  replaceInteractionSeparator(`${left} by ${right}`)

const SIMPLE_EFFECTS_SE_FOOTNOTE =
  'Std Error values are model-based. In balanced designs, repeated SE values are expected; in unbalanced designs, SE values may differ across comparisons.'

const collectSimpleEffectsFootnotes = (result: Record<string, unknown>): string[] => {
  const footnotes: string[] = []
  const warning =
    typeof result.simple_effects_warning === 'string' ? result.simple_effects_warning.trim() : ''

  if (warning) {
    footnotes.push(warning)
  }

  footnotes.push(SIMPLE_EFFECTS_SE_FOOTNOTE)

  return footnotes
}

/**
 * Build ECP-Style tables for factorial ANOVA results
 */
export function buildFactorialAnovaTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  requestedTestType?: string
): ECPTableCollection {
  const tables: ECPTable[] = []

  tables.push(buildFactorialSummaryTable(result, options, requestedTestType))

  const effectSizes = buildFactorialEffectSizesTable(result, options)
  if (effectSizes) {
    tables.push(effectSizes)
  }

  const cellMeans = buildFactorialCellMeansTable(result, options)
  if (cellMeans) {
    tables.push(cellMeans)
  }

  const simpleEffectTables = buildFactorialSimpleEffectsTables(result, options)
  ecpLogger.debug('Simple effect tables generated', { count: simpleEffectTables.length })
  if (simpleEffectTables.length) {
    tables.push(...simpleEffectTables)
  }

  const assumptions = buildFactorialAssumptionsTable(result, options)
  if (assumptions) {
    tables.push(assumptions)
  }

  const sampleSize =
    parseInteger(result.total_n) ??
    parseInteger(result.rows_used) ??
    parseInteger(result.n_total) ??
    0

  const reportedType = typeof result.test_type === 'string' ? (result.test_type as string) : ''
  const testTypeLabel = requestedTestType ?? (reportedType === 'two_way' ? 'two_way_anova' : 'multifactorial_anova')
  const pairwise = Array.isArray(result.pairwise_comparisons)
    ? (result.pairwise_comparisons as Array<Record<string, unknown>>)
    : []
  const methodFromPairwise =
    (pairwise[0]?.method as string | undefined) ??
    (pairwise[0]?.adjustment_method as string | undefined)
  const adjustmentMethod = (result.adjustment_method as string) ?? methodFromPairwise
  const posthocQ = typeof result.posthoc_q === 'number' ? result.posthoc_q : null
  const showQ = posthocQ !== null && adjustmentMethod ? /fdr|benjamini/i.test(adjustmentMethod) : false
  const adjustmentLabel =
    adjustmentMethod && showQ
      ? `${adjustmentMethod} (q = ${formatNumber(posthocQ, 2)})`
      : adjustmentMethod

  return {
    testType: testTypeLabel,
    testFamily: 'parametric',
    tables,
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: options.alpha,
      sampleSize,
      posthocAdjustment: pairwise.length > 0 ? adjustmentLabel : undefined,
    },
  }
}

function collectTwoWayEffects(result: Record<string, unknown>): EffectRow[] {
  const effects: EffectRow[] = []
  const factor1Label = normalizeFactorLabel(result.factor1_label as string | undefined, 'Group 1')
  const factor2Label = normalizeFactorLabel(result.factor2_label as string | undefined, 'Group 2')
  const interactionLabel = formatInteractionLabel(factor1Label, factor2Label)

  effects.push({
    label: factor1Label,
    df: parseInteger(result.factor1_df),
    ss: parseNumber(result.factor1_ss ?? result.ss_factor1),
    ms: parseNumber(result.factor1_ms ?? result.ms_factor1),
    stat: parseNumber(result.factor1_f),
    p: parseNumber(result.factor1_p),
  })

  effects.push({
    label: factor2Label,
    df: parseInteger(result.factor2_df),
    ss: parseNumber(result.factor2_ss ?? result.ss_factor2),
    ms: parseNumber(result.factor2_ms ?? result.ms_factor2),
    stat: parseNumber(result.factor2_f),
    p: parseNumber(result.factor2_p),
  })

  effects.push({
    label: interactionLabel,
    df: parseInteger(result.interaction_df),
    ss: parseNumber(result.interaction_ss ?? result.ss_interaction),
    ms: parseNumber(result.interaction_ms ?? result.ms_interaction),
    stat: parseNumber(result.interaction_f),
    p: parseNumber(result.interaction_p),
  })

  return effects
}

function collectMultifactorEffects(result: Record<string, unknown>): EffectRow[] {
  const effects: EffectRow[] = []
  const mainEffects = result.main_effects as Array<Record<string, unknown>> | undefined
  const interactions = result.interactions as Array<Record<string, unknown>> | undefined

  if (Array.isArray(mainEffects) && mainEffects.length > 0) {
    for (const effect of mainEffects) {
      const label = normalizeFactorLabel(effect.source as string | undefined, 'Group')
      effects.push({
        label,
        df: parseInteger(effect.df),
        ss: parseNumber(effect.SS),
        ms: parseNumber(effect.MS),
        stat: parseNumber(effect.F),
        p: parseNumber(effect.p_value),
      })
    }
  }

  if (Array.isArray(interactions) && interactions.length > 0) {
    for (const interaction of interactions) {
      effects.push({
        label: replaceInteractionSeparator(
          ((interaction.source as string) ?? (interaction.term as string) ?? 'Interaction').replace(/:/g, ' by ')
        ),
        df: parseInteger(interaction.df),
        ss: parseNumber(interaction.SS),
        ms: parseNumber(interaction.MS),
        stat: parseNumber(interaction.F),
        p: parseNumber(interaction.p_value),
      })
    }
  }

  // Fallback: collect from flat Python output fields (legacy naming)
  if (!effects.length) {
    // Get factor names or default to factor1, factor2, factor3
    // Note: Python outputs factor_names as semicolon-separated string, not array
    const factorNamesRaw = result.factor_names
    const factorNames = typeof factorNamesRaw === 'string'
      ? factorNamesRaw.split(';').map(s => s.trim()).filter(Boolean)
      : Array.isArray(factorNamesRaw)
        ? (factorNamesRaw as string[])
        : ['factor1', 'factor2', 'factor3']

    // Collect main effects (factor1, factor2, factor3)
    for (const name of factorNames) {
      const label = normalizeFactorLabel(name, name)
      // Try both _f (legacy) and _F (Python-style)
      const stat = parseNumber((result as Record<string, unknown>)[`${name}_f`]) ??
                   parseNumber((result as Record<string, unknown>)[`${name}_F`])
      const pVal = parseNumber((result as Record<string, unknown>)[`${name}_p`])
      const ss = parseNumber((result as Record<string, unknown>)[`${name}_ss`])
      const df = parseInteger((result as Record<string, unknown>)[`${name}_df`]) ??
                 parseInteger((result as Record<string, unknown>)[`${name}_df1`])

      if (stat === undefined && pVal === undefined) {
        continue
      }

      effects.push({
        label,
        df,
        ss,
        stat,
        p: pVal,
      })
    }

    // Collect 2-way interaction: factor1 x factor2 (stored as interaction_*)
    const int12Stat = parseNumber(result.interaction_f) ?? parseNumber(result.interaction_F)
    if (int12Stat !== undefined) {
      effects.push({
        label: 'factor1 by factor2',
        df: parseInteger(result.interaction_df),
        ss: parseNumber(result.interaction_ss),
        stat: int12Stat,
        p: parseNumber(result.interaction_p),
      })
    }

    // Collect 2-way interaction: factor1 x factor3
    const int13Stat = parseNumber(result.factor1_factor3_f) ?? parseNumber(result.factor1_factor3_F)
    if (int13Stat !== undefined) {
      effects.push({
        label: 'factor1 by factor3',
        df: parseInteger(result.factor1_factor3_df),
        ss: parseNumber(result.factor1_factor3_ss),
        stat: int13Stat,
        p: parseNumber(result.factor1_factor3_p),
      })
    }

    // Collect 2-way interaction: factor2 x factor3
    const int23Stat = parseNumber(result.factor2_factor3_f) ?? parseNumber(result.factor2_factor3_F)
    if (int23Stat !== undefined) {
      effects.push({
        label: 'factor2 by factor3',
        df: parseInteger(result.factor2_factor3_df),
        ss: parseNumber(result.factor2_factor3_ss),
        stat: int23Stat,
        p: parseNumber(result.factor2_factor3_p),
      })
    }

    // Collect 3-way interaction: factor1 x factor2 x factor3 (stored as factor4_*)
    const int123Stat = parseNumber(result.factor4_f) ?? parseNumber(result.factor4_F)
    if (int123Stat !== undefined) {
      effects.push({
        label: 'factor1 by factor2 by factor3',
        df: parseInteger(result.factor4_df),
        ss: parseNumber(result.factor4_ss),
        stat: int123Stat,
        p: parseNumber(result.factor4_p),
      })
    }

    // Also try _x_ style keys (legacy Python format)
    const flattenedKeys = Object.keys(result).filter(key => key.endsWith('_F') && key.includes('_x_'))
    for (const key of flattenedKeys) {
      const base = key.slice(0, -2)
      const stat = parseNumber((result as Record<string, unknown>)[key])
      const pVal = parseNumber((result as Record<string, unknown>)[`${base}_p`])
      if (stat === undefined && pVal === undefined) {
        continue
      }

      // Check if we already have this effect (avoid duplicates)
      const label = replaceInteractionSeparator(base.replace(/_x_/g, ' by '))
      if (!effects.some(e => e.label === label)) {
        effects.push({
          label,
          df: parseInteger((result as Record<string, unknown>)[`${base}_df1`]),
          stat,
          p: pVal,
        })
      }
    }
  }

  return effects
}

function buildFactorialSummaryTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>,
  requestedType?: string
): ECPTable {
  const d = options.decimalPlaces
  const rows: ECPRow[] = []

  const reportedType = typeof result.test_type === 'string' ? (result.test_type as string) : undefined
  const twoWay =
    requestedType === 'two_way_anova' ||
    reportedType === 'two_way' ||
    ('factor1_label' in result && 'factor2_label' in result)
  const effects = twoWay ? collectTwoWayEffects(result) : collectMultifactorEffects(result)

  rows.push({
    cells: [
      { value: 'Source', isHeader: true, align: 'left' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 'Sum of Squares', isHeader: true, align: 'right' },
      { value: 'Mean Square', isHeader: true, align: 'right' },
      { value: twoWay ? 'F Value' : 'Statistic', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
    ],
    isHeader: true,
  })

  rows.push({ cells: [], isSeparator: true })

  for (let i = 0; i < effects.length; i++) {
    const effect = effects[i];
    if (!effect) continue;
    const pDisplay = formatMaybePValue(effect.p, options)
    // Generate data-stat name based on effect label for multifactorial ANOVA
    // Main effects: factor1, factor2, factor3
    // Two-way interactions: interaction (factor1xfactor2), factor1_factor3, factor2_factor3
    // Three-way interaction: factor4
    let effectName: string;
    const label = effect.label.toLowerCase();
    if (label === 'factor1' || (i === 0 && !label.includes('by'))) {
      effectName = 'factor1';
    } else if (label === 'factor2' || (i === 1 && !label.includes('by'))) {
      effectName = 'factor2';
    } else if (label === 'factor3' || (i === 2 && !label.includes('by'))) {
      effectName = 'factor3';
    } else if (label.includes('factor1') && label.includes('factor2') && label.includes('factor3')) {
      // Three-way interaction
      effectName = 'factor4';
    } else if (label.includes('factor1') && label.includes('factor3')) {
      effectName = 'factor1_factor3';
    } else if (label.includes('factor2') && label.includes('factor3')) {
      effectName = 'factor2_factor3';
    } else if (label.includes('factor1') && label.includes('factor2')) {
      // factor1 x factor2 is stored as 'interaction' in baseline
      effectName = 'interaction';
    } else if (label.includes('by') || label.includes('interaction')) {
      // Generic interaction fallback
      effectName = 'interaction';
    } else {
      effectName = `factor${i + 1}`;
    }
    rows.push({
      cells: [
        { value: effect.label, align: 'left' },
        { value: formatDFValue(effect.df), align: 'right', attrs: { 'data-stat': `${effectName}_df` } },
        { value: formatMaybeNumber(effect.ss, d), align: 'right', attrs: { 'data-stat': `${effectName}_ss` } },
        { value: formatMaybeNumber(effect.ms, d), align: 'right', attrs: { 'data-stat': `${effectName}_ms` } },
        { value: formatMaybeNumber(effect.stat, d), align: 'right', attrs: { 'data-stat': `${effectName}_f` } },
        { value: pDisplay.text, align: 'right', isSignificant: pDisplay.isSignificant, attrs: { 'data-stat': `${effectName}_p` } },
      ],
    })
  }

  rows.push({ cells: [], isSeparator: true })

  const residualDF = parseInteger(result.residual_df)
  const residualSS = parseNumber(result.residual_ss ?? result.ss_residual ?? (result.residual as Record<string, unknown> | undefined)?.SS)
  const residualMS = parseNumber(result.residual_ms ?? result.ms_residual ?? (result.residual as Record<string, unknown> | undefined)?.MS)

  rows.push({
    cells: [
      { value: 'Residual', align: 'left' },
      { value: formatDFValue(residualDF), align: 'right', attrs: { 'data-stat': 'residual_df' } },
      { value: formatMaybeNumber(residualSS, d), align: 'right', attrs: { 'data-stat': 'residual_ss' } },
      { value: formatMaybeNumber(residualMS, d), align: 'right', attrs: { 'data-stat': 'residual_ms' } },
      { value: '', align: 'right' },
      { value: '', align: 'right' },
    ],
  })

  // Total row
  const totalSS = parseNumber(result.total_ss ?? result.ss_total)
  const totalDF = parseInteger(result.total_df)
  const totalN = parseInteger(result.total_n ?? result.n_total ?? result.rows_used)

  if (totalSS !== undefined || totalDF !== undefined) {
    rows.push({
      cells: [
        { value: 'Corrected Total', align: 'left' },
        { value: formatDFValue(totalDF), align: 'right', attrs: { 'data-stat': 'total_df' } },
        { value: formatMaybeNumber(totalSS, d), align: 'right', attrs: { 'data-stat': 'total_ss' } },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
      ],
    })
  }

  // Sample size information row
  if (totalN !== undefined) {
    rows.push({
      cells: [
        { value: 'Total N', align: 'left' },
        { value: '', align: 'right' },
        { value: String(totalN), align: 'right', attrs: { 'data-stat': 'total_n' } },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
        { value: '', align: 'right' },
      ],
    })
  }

  const variableName =
    (result.dependent_name as string) ??
    (result.value_column as string) ??
    options.variableName

  return {
    title: 'Analysis of Variance',
    procedure: 'ANOVA Analysis',
    dependentVar: variableName,
    columns: [
      { key: 'source', header: 'Source', align: 'left', width: 18 },
      { key: 'df', header: 'DF', align: 'right', width: 6 },
      { key: 'ss', header: 'Sum of Squares', align: 'right', width: 16, format: 'decimal' },
      { key: 'ms', header: 'Mean Square', align: 'right', width: 14, format: 'decimal' },
      { key: 'stat', header: twoWay ? 'F Value' : 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
    ],
    rows,
    testName: 'factorial_anova_summary',
  }
}

function buildFactorialEffectSizesTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const rows: ECPRow[] = []
  const effectRows: EffectSizeRow[] = []
  const twoWay = result.factor1_label !== undefined && result.factor2_label !== undefined

  if (twoWay) {
    const factor1Label = normalizeFactorLabel(result.factor1_label as string | undefined, 'Group 1')
    const factor2Label = normalizeFactorLabel(result.factor2_label as string | undefined, 'Group 2')
    effectRows.push({
      label: factor1Label,
      eta: parseNumber(result.factor1_partial_eta_squared ?? result.factor1_eta_squared),
      omega: parseNumber(result.factor1_omega_squared ?? result.factor1_omega_sq),
      interpretation: (result.factor1_effect_interpretation as string) ?? (result.factor1_omega_interpretation as string),
    })
    effectRows.push({
      label: factor2Label,
      eta: parseNumber(result.factor2_partial_eta_squared ?? result.factor2_eta_squared),
      omega: parseNumber(result.factor2_omega_squared ?? result.factor2_omega_sq),
      interpretation: (result.factor2_effect_interpretation as string) ?? (result.factor2_omega_interpretation as string),
    })
    effectRows.push({
      label: formatInteractionLabel(factor1Label, factor2Label),
      eta: parseNumber(result.interaction_partial_eta_squared ?? result.interaction_eta_squared),
      omega: parseNumber(result.interaction_omega_sq ?? result.interaction_omega_squared),
      interpretation:
        (result.interaction_effect_interpretation as string) ?? (result.interaction_omega_interpretation as string),
    })
  } else if (Array.isArray(result.main_effects)) {
    const mainEffects = result.main_effects as Array<Record<string, unknown>>
    for (const effect of mainEffects) {
      effectRows.push({
        label: normalizeFactorLabel(effect.source as string | undefined, 'Group'),
        eta: parseNumber(effect.eta_squared),
        omega: parseNumber(effect.omega_squared),
        interpretation: effect.significant ? 'Significant' : undefined,
      })
    }
    const interactions = result.interactions as Array<Record<string, unknown>> | undefined
    if (Array.isArray(interactions)) {
      for (const interaction of interactions) {
        effectRows.push({
          label: replaceInteractionSeparator(((interaction.source as string) ?? '').replace(/:/g, ' by ')) || 'Interaction',
          eta: parseNumber(interaction.eta_squared),
          omega: parseNumber(interaction.omega_squared),
          interpretation: interaction.significant ? 'Significant' : undefined,
        })
      }
    }
  } else {
    // Fallback: collect from flat Python output fields
    // Note: Python outputs factor_names as semicolon-separated string, not array
    const factorNamesRaw = result.factor_names
    const factorNames = typeof factorNamesRaw === 'string'
      ? factorNamesRaw.split(';').map(s => s.trim()).filter(Boolean)
      : Array.isArray(factorNamesRaw)
        ? (factorNamesRaw as string[])
        : ['factor1', 'factor2', 'factor3']
    for (const factor of factorNames) {
      // Try both _eta (legacy) and _pes (Python-style)
      const eta = parseNumber((result as Record<string, unknown>)[`${factor}_eta`]) ??
                  parseNumber((result as Record<string, unknown>)[`${factor}_pes`])
      const omega =
        parseNumber((result as Record<string, unknown>)[`${factor}_omega_sq`]) ??
        parseNumber((result as Record<string, unknown>)[`${factor}_omega`])
      if (eta === undefined && omega === undefined) {
        continue
      }
      effectRows.push({
        label: normalizeFactorLabel(factor, factor),
        eta,
        omega,
      })
    }

    // Collect 2-way interaction: factor1 x factor2 (stored as interaction_eta)
    const int12Eta = parseNumber(result.interaction_eta) ?? parseNumber(result.interaction_pes)
    if (int12Eta !== undefined) {
      effectRows.push({
        label: 'factor1 by factor2',
        eta: int12Eta,
        omega: parseNumber(result.interaction_omega_sq),
      })
    }

    // Collect 2-way interaction: factor1 x factor3
    const int13Eta = parseNumber(result.factor1_factor3_eta) ?? parseNumber(result.factor1_factor3_pes)
    if (int13Eta !== undefined) {
      effectRows.push({
        label: 'factor1 by factor3',
        eta: int13Eta,
        omega: parseNumber(result.factor1_factor3_omega_sq),
      })
    }

    // Collect 2-way interaction: factor2 x factor3
    const int23Eta = parseNumber(result.factor2_factor3_eta) ?? parseNumber(result.factor2_factor3_pes)
    if (int23Eta !== undefined) {
      effectRows.push({
        label: 'factor2 by factor3',
        eta: int23Eta,
        omega: parseNumber(result.factor2_factor3_omega_sq),
      })
    }

    // Collect 3-way interaction: factor1 x factor2 x factor3 (stored as factor4_eta)
    const int123Eta = parseNumber(result.factor4_eta) ?? parseNumber(result.factor4_pes)
    if (int123Eta !== undefined) {
      effectRows.push({
        label: 'factor1 by factor2 by factor3',
        eta: int123Eta,
        omega: parseNumber(result.factor4_omega_sq),
      })
    }

    const flattenedInteractions = Object.keys(result).filter(key => key.endsWith('_pes') && key.includes('_x_'))
    for (const key of flattenedInteractions) {
      const base = key.slice(0, -4)
      effectRows.push({
        label: replaceInteractionSeparator(base.replace(/_x_/g, ' by ')),
        eta: parseNumber((result as Record<string, unknown>)[key]),
        omega:
          parseNumber((result as Record<string, unknown>)[`${base}_omega_sq`]) ??
          parseNumber((result as Record<string, unknown>)[`${base}_omega`]),
      })
    }
  }

  if (!effectRows.length) {
    return null
  }

  rows.push({
    cells: [
      { value: 'Effect', isHeader: true, align: 'left' },
      { value: 'Partial Eta Sq', isHeader: true, align: 'right' },
      { value: 'Omega Sq', isHeader: true, align: 'right' },
      { value: 'Interpretation', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  })

  rows.push({ cells: [], isSeparator: true })

  for (let i = 0; i < effectRows.length; i++) {
    const effect = effectRows[i];
    if (!effect) continue;
    // Generate data-stat name based on effect label for multifactorial ANOVA
    let effectName: string;
    const label = effect.label.toLowerCase();
    if (label === 'factor1' || (i === 0 && !label.includes('by'))) {
      effectName = 'factor1';
    } else if (label === 'factor2' || (i === 1 && !label.includes('by'))) {
      effectName = 'factor2';
    } else if (label === 'factor3' || (i === 2 && !label.includes('by'))) {
      effectName = 'factor3';
    } else if (label.includes('factor1') && label.includes('factor2') && label.includes('factor3')) {
      effectName = 'factor4';
    } else if (label.includes('factor1') && label.includes('factor3')) {
      effectName = 'factor1_factor3';
    } else if (label.includes('factor2') && label.includes('factor3')) {
      effectName = 'factor2_factor3';
    } else if (label.includes('factor1') && label.includes('factor2')) {
      effectName = 'interaction';
    } else if (label.includes('by') || label.includes('interaction')) {
      effectName = 'interaction';
    } else {
      effectName = `factor${i + 1}`;
    }
    rows.push({
      cells: [
        { value: effect.label, align: 'left' },
        { value: formatEffectSize(effect.eta, options.decimalPlaces), align: 'right', attrs: { 'data-stat': `${effectName}_eta` } },
        { value: formatEffectSize(effect.omega, options.decimalPlaces), align: 'right', attrs: { 'data-stat': `${effectName}_omega_squared` } },
        { value: effect.interpretation ?? '', align: 'left' },
      ],
    })
  }

  return {
    title: 'Effect Sizes',
    columns: [
      { key: 'effect', header: 'Effect', align: 'left', width: 18 },
      { key: 'eta', header: 'Partial Eta Sq', align: 'right', width: 14, format: 'decimal' },
      { key: 'omega', header: 'Omega Sq', align: 'right', width: 12, format: 'decimal' },
      { key: 'interpretation', header: 'Interpretation', align: 'left', width: 20 },
    ],
    rows,
    testName: 'factorial_anova_effect_sizes',
  }
}

function buildFactorialCellMeansTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const d = options.decimalPlaces

  // Check if design is unbalanced and LS means are available
  const meansType = result.means_type as string | undefined
  const counts = result.cell_counts as
    | { is_balanced?: boolean; isBalanced?: boolean }
    | undefined
  const isBalanced =
    typeof counts?.is_balanced === 'boolean'
      ? counts.is_balanced
      : typeof counts?.isBalanced === 'boolean'
        ? counts.isBalanced
        : undefined

  const emmeans = Array.isArray(result.cell_emmeans)
    ? (result.cell_emmeans as Array<Record<string, unknown>>)
    : null
  const summaries =
    (result.cell_summaries as Array<Record<string, unknown>> | undefined) ??
    (result.cell_means as Array<Record<string, unknown>> | undefined)

  const useEMMeans =
    Array.isArray(emmeans) &&
    emmeans.length > 0 &&
    (meansType === 'lsmean' || isBalanced === false || !summaries)

  // Use LS means (emmeans) for unbalanced designs, cell means for balanced
  const cellData = useEMMeans ? emmeans : summaries

  if (!Array.isArray(cellData) || cellData.length === 0) {
    return null
  }

  // Dynamic labels based on means type
  const meanLabel = useEMMeans ? 'LS Mean' : 'Mean'
  const tableTitle = useEMMeans ? 'LS Means (Estimated Marginal Means)' : 'Cell Means'
  const includeStdDev = !useEMMeans

  const rows: ECPRow[] = []

  const headerCells: ECPCell[] = [
    { value: 'Factor Combination', isHeader: true, align: 'left' },
    { value: 'N', isHeader: true, align: 'right' },
    { value: meanLabel, isHeader: true, align: 'right' },
  ]
  if (includeStdDev) {
    headerCells.push({ value: 'Std Dev', isHeader: true, align: 'right' })
  }
  headerCells.push(
    { value: 'Std Error', isHeader: true, align: 'right' },
    { value: 'CL Lower', isHeader: true, align: 'right' },
    { value: 'CL Upper', isHeader: true, align: 'right' }
  )

  rows.push({
    cells: headerCells,
    isHeader: true,
  })

  rows.push({ cells: [], isSeparator: true })

  let cellIndex = 1
  for (const cell of cellData) {
    const rawLabel =
      (cell.cell_label as string) ||
      (cell.factors
        ? Object.entries(cell.factors as Record<string, unknown>)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '')
    const label = rawLabel ? replaceInteractionSeparator(rawLabel) : ''

    const nValue = parseInteger(cell.n)

    // For LS means: use 'emmean' field; for cell means: use 'mean' field
    const meanValue = useEMMeans
      ? parseNumber(cell.emmean)
      : parseNumber(cell.mean)

    // For LS means: 'se' is provided directly; for cell means: may need to calculate
    const stdValue = parseNumber(cell.std)
    let stdError = parseNumber(cell.se ?? cell.sem ?? cell.std_error)
    if (!useEMMeans && stdError === undefined && stdValue !== undefined && nValue !== undefined && nValue > 0) {
      // Calculate SE = std / sqrt(n) for cell means if not provided
      stdError = stdValue / Math.sqrt(nValue)
    }

    const rowCells: ECPCell[] = [
      { value: label || 'Cell', align: 'left', attrs: { 'data-stat': `cell${cellIndex}_label` } },
      { value: nValue ?? '.', align: 'right', attrs: { 'data-stat': `cell${cellIndex}_n` } },
      { value: formatMaybeNumber(meanValue, d), align: 'right', attrs: { 'data-stat': `cell${cellIndex}_mean` } },
    ]
    if (includeStdDev) {
      rowCells.push({ value: formatMaybeNumber(stdValue, d), align: 'right', attrs: { 'data-stat': `cell${cellIndex}_std` } })
    }
    rowCells.push(
      { value: formatMaybeNumber(stdError, d), align: 'right', attrs: { 'data-stat': `cell${cellIndex}_se` } },
      { value: formatMaybeNumber(parseNumber(cell.ci_lower ?? cell.ci_95_lower), d), align: 'right', attrs: { 'data-stat': `cell${cellIndex}_ci_lower` } },
      { value: formatMaybeNumber(parseNumber(cell.ci_upper ?? cell.ci_95_upper), d), align: 'right', attrs: { 'data-stat': `cell${cellIndex}_ci_upper` } }
    )

    rows.push({
      cells: rowCells,
    })
    cellIndex += 1
  }

  const columns: ECPColumn[] = [
    { key: 'cell', header: 'Factor Combination', align: 'left', width: 24 },
    { key: 'n', header: 'N', align: 'right', width: 6, format: 'integer' },
    { key: 'mean', header: meanLabel, align: 'right', width: 10, format: 'decimal' },
  ]
  if (includeStdDev) {
    columns.push({
      key: 'std',
      header: 'Std Dev',
      align: 'right',
      width: 10,
      format: 'decimal',
    })
  }
  columns.push(
    { key: 'se', header: 'Std Error', align: 'right', width: 10, format: 'decimal' },
    { key: 'lower', header: 'CL Lower', align: 'right', width: 12, format: 'decimal' },
    { key: 'upper', header: 'CL Upper', align: 'right', width: 12, format: 'decimal' }
  )

  return {
    title: tableTitle,
    columns,
    rows,
    testName: 'factorial_anova_cells',
  }
}

// Legacy function - kept for reference
// const deriveScopeFromLabel = (label?: string): string | null => {
//   if (!label) return null
//   const parts = label.split(' | ')
//   if (parts.length < 2) return null
//   const scopePart = parts[parts.length - 1]?.trim()
//   if (!scopePart) return null
//   const segments = scopePart.split('|')
//   if (segments.length < 2) return scopePart
//   const factor = segments[0]?.trim()
//   const withinSegment = segments[1]?.trim()
//   if (!withinSegment) return factor || null
//   const [withinFactor, level] = withinSegment.split('=')
//   if (!factor && !withinFactor) return scopePart
//   if (withinFactor && level) {
//     return `${factor || 'Factor'} within ${withinFactor.trim()}=${level.trim()}`
//   }
//   if (withinFactor) {
//     return `${factor || 'Factor'} within ${withinFactor.trim()}`
//   }
//   return factor || scopePart
// }

function buildSimpleEffectRows(
  effects: Array<Record<string, unknown>>,
  options: Required<TableBuilderOptions>,
  startIndex: number = 1,
  prefix: string = 'se',
  factorLabels?: Record<string, string>,
  pHeader: string = 'Pr > |t|'
): ECPRow[] {
  const rows: ECPRow[] = []
  const d = options.decimalPlaces

  // Helper to replace generic factor names with actual labels
  const replaceFactorNames = (text: string): string => {
    if (!factorLabels) return text
    let result = text
    for (const [generic, actual] of Object.entries(factorLabels)) {
      result = result.replace(new RegExp(generic, 'g'), actual)
    }
    return result
  }

  rows.push({
    cells: [
      { value: 'Comparison', isHeader: true, align: 'left' },
      { value: 'Estimate', isHeader: true, align: 'right' },
      { value: 'Std Error', isHeader: true, align: 'right' },
      { value: '95% CI [lower, upper]', isHeader: true, align: 'right' },
      { value: 'DF', isHeader: true, align: 'right' },
      { value: 't Ratio', isHeader: true, align: 'right' },
      { value: pHeader, isHeader: true, align: 'right' },
    ],
    isHeader: true,
  })

  rows.push({ cells: [], isSeparator: true })

  let seIndex = startIndex
  for (const effect of effects) {
    const estimate = parseNumber(effect.mean_diff) ?? parseNumber(effect.difference) ?? parseNumber(effect.estimate)
    const se = parseNumber(effect.se) ?? parseNumber(effect.std_error) ?? parseNumber(effect.SE)
    const ciLower = parseNumber(effect.ci_lower) ?? parseNumber(effect.ci_low)
    const ciUpper = parseNumber(effect.ci_upper) ?? parseNumber(effect.ci_high)
    const df = parseInteger(effect.df) ?? parseInteger(effect.degrees_of_freedom)
    const tRatio = parseNumber(effect.t_ratio) ?? parseNumber(effect.t_stat) ?? parseNumber(effect.t) ?? parseNumber(effect.t_value)
    const pValue = parseNumber(effect.p_adj) ?? parseNumber(effect.p_adjusted) ?? parseNumber(effect.p_value) ?? parseNumber(effect.p)

    const estimateText = estimate !== undefined ? formatNumber(estimate, d) : '.'
    const seText = se !== undefined ? formatNumber(se, d) : '.'
    const ciText =
      ciLower !== undefined && ciUpper !== undefined
        ? `[${formatNumber(ciLower, d)}, ${formatNumber(ciUpper, d)}]`
        : '.'
    const dfText = df !== undefined ? String(df) : '.'
    const tText = tRatio !== undefined ? formatNumber(tRatio, d) : '.'
    const pDisplay = pValue !== undefined ? formatPValue(pValue, options.pValueThreshold, options.minPValue) : '.'

    const factorScope = effect.factor_scope as string | undefined
    const factorName = effect.factor as string | undefined

    // Build descriptive label using actual factor labels (not generic "factor1", "factor2")
    let label: string
    if (effect.label) {
      label = replaceFactorNames(effect.label as string)
    } else if (factorScope) {
      // Simple effects: show comparison with conditioning context
      // e.g., "A - B | Treatment=X" instead of "A - B | factor1|factor2=X"
      label = `${effect.group1} - ${effect.group2} | ${replaceFactorNames(factorScope)}`
    } else if (factorName) {
      // Marginal effects: show actual factor label with comparison
      // e.g., "Treatment: A - B" instead of "factor1: A - B"
      const actualLabel = factorLabels?.[factorName] ?? factorName
      label = `${actualLabel}: ${effect.group1} - ${effect.group2}`
    } else {
      label = `${effect.group1} - ${effect.group2}`
    }

    // Use indexed data-stat names (se1_, se2_, etc. or me1_, me2_, etc.)
    const statPrefix = `${prefix}${seIndex}`

    // Add df as a proper cell with data-stat attribute
    // Note: baseline uses se1_t (not se1_t_ratio)
    rows.push({
      cells: [
        { value: label || 'Comparison', align: 'left', attrs: { 'data-stat': `${statPrefix}_label` } },
        { value: estimateText, align: 'right', attrs: { 'data-stat': `${statPrefix}_estimate` } },
        { value: seText, align: 'right', attrs: { 'data-stat': `${statPrefix}_se` } },
        {
          value: ciText,
          align: 'right',
          attrs: {
            'data-ci-lower-stat': `${statPrefix}_ci_lower`,
            'data-ci-lower-value': ciLower !== undefined ? String(ciLower) : '',
            'data-ci-upper-stat': `${statPrefix}_ci_upper`,
            'data-ci-upper-value': ciUpper !== undefined ? String(ciUpper) : '',
          },
        },
        { value: dfText, align: 'right', attrs: { 'data-stat': `${statPrefix}_df` } },
        { value: tText, align: 'right', attrs: { 'data-stat': `${statPrefix}_t` } },
        { value: pDisplay, align: 'right', isSignificant: pValue !== undefined && pValue < options.alpha, attrs: { 'data-stat': `${statPrefix}_p` } },
      ],
    })
    seIndex++
  }

  return rows
}

function buildFactorialSimpleEffectsTables(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable[] {
  const tables: ECPTable[] = []
  const simpleEffectsFootnotes = collectSimpleEffectsFootnotes(result)

  // Build mapping from generic factor names to actual column labels
  // This allows us to display "Treatment: A - B" instead of "factor1: A - B"
  const factorLabels: Record<string, string> = {}
  const f1Label = normalizeFactorLabel(result.factor1_label as string | undefined, 'Group 1')
  const f2Label = normalizeFactorLabel(result.factor2_label as string | undefined, 'Group 2')
  if (f1Label) factorLabels['factor1'] = f1Label
  if (f2Label) factorLabels['factor2'] = f2Label
  // Note: Python outputs factor_names as semicolon-separated string, not array
  const factorNamesRaw = result.factor_names
  const factorNames = typeof factorNamesRaw === 'string'
    ? factorNamesRaw.split(';').map(s => s.trim()).filter(Boolean)
    : Array.isArray(factorNamesRaw)
      ? (factorNamesRaw as string[])
      : []
  for (const name of factorNames) {
    factorLabels[name] = normalizeFactorLabel(name, name)
  }

  const pairwise = Array.isArray(result.pairwise_comparisons)
    ? (result.pairwise_comparisons as Array<Record<string, unknown>>)
    : []

  const marginalEffects = pairwise.filter(effect => !!effect.factor && !effect.factor_scope)
  const simpleEffects = pairwise.filter(effect => !!effect.factor_scope)
  const methodFromPairwise =
    (simpleEffects[0]?.method as string | undefined) ??
    (marginalEffects[0]?.method as string | undefined)
  const method = (result.adjustment_method as string) ?? methodFromPairwise ?? 'Tukey HSD'
  const showQ = /fdr|benjamini/i.test(method)
  const pHeader = showQ ? 'Pr > |t| (q)' : 'Pr > |t|'

  // Build marginal effects table (main effects comparisons - me1, me2)
  if (marginalEffects.length > 0) {
    tables.push({
      title: 'Marginal Effects (Main Effect Comparisons)',
      columns: [
        { key: 'comparison', header: 'Comparison', align: 'left', width: 36 },
        { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
        { key: 'se', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
        { key: 'ci', header: '95% CI [lower, upper]', align: 'right', width: 22, format: 'text' },
        { key: 'df', header: 'DF', align: 'right', width: 6, format: 'integer' },
        { key: 't_ratio', header: 't Ratio', align: 'right', width: 12, format: 'decimal' },
        { key: 'p', header: pHeader, align: 'right', width: 12, format: 'pvalue' },
      ],
      rows: buildSimpleEffectRows(marginalEffects, options, 1, 'me', factorLabels, pHeader),
      testName: 'factorial_marginal_effects',
    })
  }

  // Build simple effects table (se1, se2, se3, se4)
  if (simpleEffects.length > 0) {
    tables.push({
      title: `Simple Effects (${method})`,
      columns: [
        { key: 'comparison', header: 'Comparison', align: 'left', width: 36 },
        { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
        { key: 'se', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
        { key: 'ci', header: '95% CI [lower, upper]', align: 'right', width: 22, format: 'text' },
        { key: 'df', header: 'DF', align: 'right', width: 6, format: 'integer' },
        { key: 't_ratio', header: 't Ratio', align: 'right', width: 12, format: 'decimal' },
        { key: 'p', header: pHeader, align: 'right', width: 12, format: 'pvalue' },
      ],
      rows: buildSimpleEffectRows(simpleEffects, options, 1, 'se', factorLabels, pHeader),
      testName: 'factorial_simple_effects',
      footnotes: simpleEffectsFootnotes.length > 0 ? simpleEffectsFootnotes : undefined,
    })
  }

  // Fallback: Build simple effects from flat Python fields (se1_*, se2_*, etc.)
  if (simpleEffects.length === 0 && marginalEffects.length === 0) {
    const simpleEffectsCount = parseInteger(result.simple_effects_count) ?? 0
    if (simpleEffectsCount > 0) {
      const flatSimpleEffects: Array<Record<string, unknown>> = []
      for (let i = 1; i <= simpleEffectsCount; i++) {
        const prefix = `se${i}`
        const label = result[`${prefix}_label`] as string | undefined
        const estimate = parseNumber(result[`${prefix}_estimate`])
        const se = parseNumber(result[`${prefix}_se`])
        const ciLower = parseNumber(result[`${prefix}_ci_lower`])
        const ciUpper = parseNumber(result[`${prefix}_ci_upper`])
        const df = parseInteger(result[`${prefix}_df`])
        const t = parseNumber(result[`${prefix}_t`])
        const p = parseNumber(result[`${prefix}_p`])

        if (estimate !== undefined || p !== undefined) {
          flatSimpleEffects.push({
            label,
            estimate,
            mean_diff: estimate,
            se,
            SE: se,
            ci_lower: ciLower,
            ci_upper: ciUpper,
            df,
            t_ratio: t,
            t: t,
            p_value: p,
            p_adj: p,
          })
        }
      }

      if (flatSimpleEffects.length > 0) {
        tables.push({
          title: `Simple Effects (${method})`,
          columns: [
            { key: 'comparison', header: 'Comparison', align: 'left', width: 36 },
            { key: 'estimate', header: 'Estimate', align: 'right', width: 12, format: 'decimal' },
            { key: 'se', header: 'Std Error', align: 'right', width: 12, format: 'decimal' },
            { key: 'ci', header: '95% CI [lower, upper]', align: 'right', width: 22, format: 'text' },
            { key: 'df', header: 'DF', align: 'right', width: 6, format: 'integer' },
            { key: 't_ratio', header: 't Ratio', align: 'right', width: 12, format: 'decimal' },
            { key: 'p', header: pHeader, align: 'right', width: 12, format: 'pvalue' },
          ],
          rows: buildSimpleEffectRows(flatSimpleEffects, options, 1, 'se', factorLabels, pHeader),
          testName: 'factorial_simple_effects',
          footnotes: simpleEffectsFootnotes.length > 0 ? simpleEffectsFootnotes : undefined,
        })
      }
    }
  }

  return tables
}

function buildFactorialAssumptionsTable(
  result: Record<string, unknown>,
  options: Required<TableBuilderOptions>
): ECPTable | null {
  const rows: ECPRow[] = []
  const d = options.decimalPlaces

  const homogeneity =
    (result.assumptions as Record<string, any> | undefined)?.homogeneity_of_variance ??
    result.levene_test
  const normality = (result.assumptions as Record<string, any> | undefined)?.normality

  if (!homogeneity && !normality) {
    return null
  }

  rows.push({
    cells: [
      { value: 'Test', isHeader: true, align: 'left' },
      { value: 'Statistic', isHeader: true, align: 'right' },
      { value: 'Pr > F', isHeader: true, align: 'right' },
      { value: 'Result', isHeader: true, align: 'left' },
    ],
    isHeader: true,
  })

  rows.push({ cells: [], isSeparator: true })

  if (homogeneity) {
    const stat = parseNumber(homogeneity.levene_statistic ?? homogeneity.statistic)
    const pVal = parseNumber(homogeneity.levene_p_value ?? homogeneity.p_value)
    const display = formatMaybePValue(pVal, options)
    const interpretation =
      typeof homogeneity.equal_variances === 'boolean'
        ? homogeneity.equal_variances
          ? 'Equal variances'
          : 'Unequal variances'
        : homogeneity.homogeneous === undefined
        ? ''
        : homogeneity.homogeneous
        ? 'Equal variances'
        : 'Unequal variances'

    rows.push({
      cells: [
        { value: homogeneity.test ?? "Levene's Test", align: 'left' },
        { value: formatMaybeStatistic(stat, d), align: 'right' },
        { value: display.text, align: 'right', isSignificant: display.isSignificant },
        { value: interpretation ?? '', align: 'left' },
      ],
    })
  }

  if (normality) {
    const stat = parseNumber(normality.shapiro_statistic ?? normality.statistic)
    const pVal = parseNumber(normality.shapiro_p_value ?? normality.p_value)
    const display = formatMaybePValue(pVal, options)
    const status =
      typeof normality.residuals_normal === 'boolean'
        ? normality.residuals_normal
          ? 'Residuals normal'
          : 'Residuals non-normal'
        : ''

    rows.push({
      cells: [
        { value: normality.test ?? 'Normality Check', align: 'left' },
        { value: formatMaybeStatistic(stat, d), align: 'right' },
        { value: display.text, align: 'right', isSignificant: display.isSignificant },
        { value: status, align: 'left' },
      ],
    })
  }

  return {
    title: 'Assumption Checks',
    columns: [
      { key: 'test', header: 'Test', align: 'left', width: 20 },
      { key: 'stat', header: 'Statistic', align: 'right', width: 12, format: 'decimal' },
      { key: 'p', header: 'Pr > F', align: 'right', width: 12, format: 'pvalue' },
      { key: 'result', header: 'Result', align: 'left', width: 20 },
    ],
    rows,
    testName: 'factorial_anova_assumptions',
  }
}
