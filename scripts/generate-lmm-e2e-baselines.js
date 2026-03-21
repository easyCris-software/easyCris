import fs from 'fs'
import path from 'path'

const projectRoot = path.resolve(process.cwd())
const validationRoot = path.join(
  projectRoot,
  '_test_validation',
  'Group1_Hypothesis_Testing',
  'linear_mixed_models',
  'results'
)
const baselinesRoot = path.join(projectRoot, 'e2e', 'fixtures', 'baselines')

const DEFAULT_OPTIONS = {
  alpha: 0.05,
  decimalPlaces: 4,
  pValueThreshold: 0.0001,
  minPValue: 1e-300,
}

const ADJUSTMENT_METHODS = [
  'tukey',
  'bonferroni',
  'holm',
  'holm-sidak',
  'sidak',
  'fdr_bh',
  'dunnett',
]

function parseValue(raw) {
  if (raw === 'TRUE') return true
  if (raw === 'FALSE') return false
  if (raw === 'NA') return null
  const numeric = Number(raw)
  if (raw !== '' && Number.isFinite(numeric)) return numeric
  return raw
}

function parseCsvLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }
    current += ch
  }

  values.push(current)
  return values.map((entry) => entry.trim())
}

function parseTableCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return []
  const header = parseCsvLine(lines[0])
  const rows = []
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line)
    const row = {}
    header.forEach((name, index) => {
      row[name] = parseValue(values[index] ?? '')
    })
    rows.push(row)
  }
  return rows
}

function parseKeyValueCsv(filePath) {
  const rows = parseTableCsv(filePath)
  const result = {}
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(row, 'metric') || !Object.prototype.hasOwnProperty.call(row, 'value')) {
      continue
    }
    result[String(row.metric)] = row.value
  }
  return result
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

function formatNumber(value, decimals = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '.'
  return Number(value).toFixed(decimals)
}

function formatStatistic(value, decimals = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '.'
  const numeric = Number(value)
  const abs = Math.abs(numeric)
  if (abs !== 0 && (abs < 0.0001 || abs >= 10000)) {
    return numeric.toExponential(decimals)
  }
  return numeric.toFixed(decimals)
}

function formatPValue(value, threshold = DEFAULT_OPTIONS.pValueThreshold, minPValue = DEFAULT_OPTIONS.minPValue) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '.'
  const numeric = Number(value)
  if (numeric <= 0 || numeric < minPValue) {
    return `< ${minPValue.toExponential(0)}`
  }
  if (numeric < threshold) {
    return numeric.toExponential(3)
  }
  return numeric.toFixed(4)
}

function formatDF(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '.'
  const numeric = Number(value)
  if (Number.isInteger(numeric)) return numeric.toString()
  return numeric.toFixed(2)
}

function significanceStars(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-'
  const numeric = Number(value)
  if (numeric <= 0.001) return '***'
  if (numeric <= 0.01) return '**'
  if (numeric <= 0.05) return '*'
  return '-'
}

function parseFactorScope(label) {
  const parts = String(label || '').split('|')
  if (parts.length < 3) {
    return { effect: '.', withinFactor: '.', withinLevel: '.' }
  }
  const effect = parts[1] || '.'
  const [withinFactor, withinLevel] = String(parts[2] || '').split('=')
  return {
    effect: effect.trim() || '.',
    withinFactor: (withinFactor || '.').trim(),
    withinLevel: (withinLevel || '.').trim(),
  }
}

function gatherIndexedRows(metrics, prefix, requiredField) {
  const indices = Object.keys(metrics)
    .map((key) => {
      const match = key.match(new RegExp(`^${prefix}(\\d+)_${requiredField}$`))
      return match ? Number(match[1]) : null
    })
    .filter((value) => value !== null)
    .sort((a, b) => a - b)
  return indices
}

function buildInferentialReportBaseline(metrics) {
  const rows = []
  const feIndices = gatherIndexedRows(metrics, 'fe', 'source')
  for (const index of feIndices) {
    const source = metrics[`fe${index}_source`]
    const isFiniteDf = metrics[`fe${index}_f_value`] !== null && metrics[`fe${index}_f_value`] !== undefined
    rows.push({
      section: String(source || '').includes(' x ') ? 'Interaction' : 'Main Effect',
      effect: source ?? '.',
      withinFactor: '.',
      withinLevel: '.',
      comparison: '.',
      estimate: null,
      stdError: null,
      statistic: formatStatistic(
        isFiniteDf ? metrics[`fe${index}_f_value`] : metrics[`fe${index}_chi_square`] ?? metrics[`fe${index}_statistic`],
        DEFAULT_OPTIONS.decimalPlaces
      ),
      numDf: isFiniteDf ? formatDF(metrics[`fe${index}_num_df`]) : formatDF(metrics[`fe${index}_df`]),
      denDf: isFiniteDf ? formatDF(metrics[`fe${index}_den_df`]) : null,
      rawP: formatPValue(metrics[`fe${index}_p`]),
      adjustedP: '.',
      sig: significanceStars(metrics[`fe${index}_p`]),
    })
  }

  const seIndices = gatherIndexedRows(metrics, 'se', 'label')
  for (const index of seIndices) {
    const scope = parseFactorScope(metrics[`se${index}_label`])
    rows.push({
      section: 'Simple Effect',
      effect: scope.effect,
      withinFactor: scope.withinFactor,
      withinLevel: scope.withinLevel,
      comparison: String(metrics[`se${index}_label`] || '')
        .split('|')[0]
        .replace(/\s+-\s+/g, ' vs ')
        .trim() || '.',
      estimate: formatNumber(metrics[`se${index}_estimate`], DEFAULT_OPTIONS.decimalPlaces),
      stdError: formatNumber(metrics[`se${index}_se`], DEFAULT_OPTIONS.decimalPlaces),
      statistic: formatStatistic(metrics[`se${index}_t_ratio`] ?? metrics[`se${index}_t`], DEFAULT_OPTIONS.decimalPlaces),
      numDf: '.',
      denDf: formatDF(metrics[`se${index}_df`]),
      rawP: formatPValue(metrics[`se${index}_p_raw`] ?? metrics[`se${index}_p`]),
      adjustedP: formatPValue(metrics[`se${index}_p_adjusted`] ?? metrics[`se${index}_p`]),
      sig: significanceStars(metrics[`se${index}_p_adjusted`] ?? metrics[`se${index}_p_raw`] ?? metrics[`se${index}_p`]),
    })
  }

  return rows
}

function asNumber(value, field) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid numeric value for ${field}: ${value}`)
  }
  return num
}

function normalizeEffect(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/:/g, ' x ')
    .replace(/\s+/g, ' ')
    .trim()
}

function dayLevelSort(a, b) {
  const na = String(a)
  const nb = String(b)
  const ma = na.match(/^d(\d+)$/i)
  const mb = nb.match(/^d(\d+)$/i)
  if (ma && mb) return Number(ma[1]) - Number(mb[1])
  return na.localeCompare(nb)
}

function buildStratifiedBaseline(omnibusRows, simpleRows, preferredStrataOrder = null) {
  const effectOrder = ['day', 'treatment', 'treatment x day']
  let strata = Array.from(
    new Set(omnibusRows.map((row) => `${row.strain}|${row.sex}`))
  )
    .map((key) => {
      const [strain, sex] = key.split('|')
      return { strain, sex }
    })
  if (Array.isArray(preferredStrataOrder) && preferredStrataOrder.length > 0) {
    const byKey = new Map(strata.map((entry) => [`${entry.strain}|${entry.sex}`, entry]))
    const ordered = []
    for (const candidate of preferredStrataOrder) {
      const key = `${candidate.strain}|${candidate.sex}`
      if (byKey.has(key)) {
        ordered.push(byKey.get(key))
        byKey.delete(key)
      }
    }
    ordered.push(...Array.from(byKey.values()))
    strata = ordered
  }

  if (strata.length === 0) {
    throw new Error('No stratified rows found for baseline generation')
  }

  const baseline = {}

  strata.forEach((stratum, stratumOffset) => {
    const stratumIndex = stratumOffset + 1
    const stratumOmnibus = omnibusRows.filter(
      (row) => String(row.strain) === stratum.strain && String(row.sex) === stratum.sex
    )

    effectOrder.forEach((effect, effectOffset) => {
      const effectIndex = effectOffset + 1
      const row = stratumOmnibus.find((candidate) => normalizeEffect(candidate.source) === effect)
      if (!row) {
        throw new Error(`Missing omnibus row for stratum ${stratum.strain}|${stratum.sex}, effect ${effect}`)
      }

      baseline[`st${stratumIndex}_fe${effectIndex}_source`] = effect
      baseline[`st${stratumIndex}_fe${effectIndex}_stratum_strain`] = String(stratum.strain)
      baseline[`st${stratumIndex}_fe${effectIndex}_stratum_sex`] = String(stratum.sex)
      baseline[`st${stratumIndex}_fe${effectIndex}_f_value`] = asNumber(row.f_value, 'f_value')
      baseline[`st${stratumIndex}_fe${effectIndex}_num_df`] = asNumber(row.num_df, 'num_df')
      baseline[`st${stratumIndex}_fe${effectIndex}_den_df`] = asNumber(row.den_df, 'den_df')
      baseline[`st${stratumIndex}_fe${effectIndex}_p`] = asNumber(row.p_value, 'p_value')
    })

    const stratumSimple = simpleRows.filter(
      (row) => String(row.strain) === stratum.strain && String(row.sex) === stratum.sex
    )

    const dayLevels = Array.from(
      new Set(
        stratumSimple
          .filter((row) => normalizeEffect(row.effect) === 'treatment' && normalizeEffect(row.within_factor) === 'day')
          .map((row) => String(row.within_level))
      )
    ).sort(dayLevelSort)

    const treatmentLevels = Array.from(
      new Set(
        stratumSimple
          .filter((row) => normalizeEffect(row.effect) === 'day' && normalizeEffect(row.within_factor) === 'treatment')
          .map((row) => String(row.within_level))
      )
    ).sort((a, b) => a.localeCompare(b))

    const dayRank = Object.fromEntries(dayLevels.map((level, idx) => [level, idx]))
    const orderedSimple = []

    for (const dayLevel of dayLevels) {
      const row = stratumSimple.find(
        (candidate) =>
          normalizeEffect(candidate.effect) === 'treatment' &&
          normalizeEffect(candidate.within_factor) === 'day' &&
          String(candidate.within_level) === dayLevel
      )
      if (!row) {
        throw new Error(`Missing treatment-within-day row for ${stratum.strain}|${stratum.sex}|${dayLevel}`)
      }
      orderedSimple.push(row)
    }

    for (const treatmentLevel of treatmentLevels) {
      const rows = stratumSimple
        .filter(
          (candidate) =>
            normalizeEffect(candidate.effect) === 'day' &&
            normalizeEffect(candidate.within_factor) === 'treatment' &&
            String(candidate.within_level) === treatmentLevel
        )
        .sort((left, right) => {
          const [la, lb] = String(left.comparison).split(' - ')
          const [ra, rb] = String(right.comparison).split(' - ')
          const leftA = dayRank[String(la)] ?? 999
          const rightA = dayRank[String(ra)] ?? 999
          if (leftA !== rightA) return leftA - rightA
          const leftB = dayRank[String(lb)] ?? 999
          const rightB = dayRank[String(rb)] ?? 999
          return leftB - rightB
        })

      orderedSimple.push(...rows)
    }

    if (orderedSimple.length === 0) {
      throw new Error(`Missing simple-effect rows for stratum ${stratum.strain}|${stratum.sex}`)
    }

    orderedSimple.forEach((row, simpleOffset) => {
      const effectIndex = simpleOffset + 1
      baseline[`st${stratumIndex}_se${effectIndex}_label`] = String(row.comparison)
      baseline[`st${stratumIndex}_se${effectIndex}_stratum_strain`] = String(stratum.strain)
      baseline[`st${stratumIndex}_se${effectIndex}_stratum_sex`] = String(stratum.sex)
      baseline[`st${stratumIndex}_se${effectIndex}_estimate`] = asNumber(row.estimate, 'estimate')
      baseline[`st${stratumIndex}_se${effectIndex}_se`] = asNumber(row.se, 'se')
      baseline[`st${stratumIndex}_se${effectIndex}_df`] = asNumber(row.df, 'df')
      baseline[`st${stratumIndex}_se${effectIndex}_t_ratio`] = asNumber(row.t_ratio, 't_ratio')
      baseline[`st${stratumIndex}_se${effectIndex}_p_raw`] = asNumber(row.p_raw, 'p_raw')
      baseline[`st${stratumIndex}_se${effectIndex}_p`] = asNumber(row.p_adjusted, 'p_adjusted')
    })
  })

  return baseline
}

function generateBaselineSet(inputCsv, outputJson, outputReportJson) {
  const metrics = parseKeyValueCsv(inputCsv)
  writeJson(outputJson, metrics)
  writeJson(outputReportJson, buildInferentialReportBaseline(metrics))
  console.log(`Generated ${path.relative(projectRoot, outputJson)} and ${path.relative(projectRoot, outputReportJson)}`)
}

function generateBaselineSetIfExists(inputCsv, outputJson, outputReportJson) {
  if (!fs.existsSync(inputCsv)) {
    console.warn(`Skipping missing source: ${path.relative(projectRoot, inputCsv)}`)
    return
  }
  generateBaselineSet(inputCsv, outputJson, outputReportJson)
}

function getDatasetStrataOrder(datasetCsv, stratifyColumns) {
  if (!datasetCsv || !fs.existsSync(datasetCsv)) return null
  const rows = parseTableCsv(datasetCsv)
  const [colA, colB] = stratifyColumns
  if (!colA || !colB) return null
  const seen = new Set()
  const ordered = []
  for (const row of rows) {
    const a = String(row[colA] ?? '')
    const b = String(row[colB] ?? '')
    const key = `${a}|${b}`
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push({ strain: a, sex: b })
  }
  return ordered
}

function generateStratifiedBaselineSet(omnibusCsv, simpleCsv, outputJson, options = {}) {
  if (!fs.existsSync(omnibusCsv) || !fs.existsSync(simpleCsv)) {
    throw new Error(
      `Missing stratified source CSV(s): ${path.relative(projectRoot, omnibusCsv)}, ${path.relative(projectRoot, simpleCsv)}`
    )
  }

  const omnibusRows = parseTableCsv(omnibusCsv)
  const simpleRows = parseTableCsv(simpleCsv)
  const preferredStrataOrder = getDatasetStrataOrder(options.datasetCsv, options.stratifyColumns || ['strain', 'sex'])
  const baseline = buildStratifiedBaseline(omnibusRows, simpleRows, preferredStrataOrder)
  writeJson(outputJson, baseline)
  console.log(`Generated ${path.relative(projectRoot, outputJson)} (${Object.keys(baseline).length} metrics)`)
}

function main() {
  const datasetCsv = path.join(
    projectRoot,
    '_test_validation',
    'Group1_Hypothesis_Testing',
    'linear_mixed_models',
    'data',
    'dataset_01.csv'
  )

  for (const method of ADJUSTMENT_METHODS) {
    const suffix = method.replace(/[^a-z0-9_]+/gi, '_').toLowerCase()
    generateStratifiedBaselineSet(
      path.join(validationRoot, `r_stratified_omnibus_dataset_01_${suffix}.csv`),
      path.join(validationRoot, `r_stratified_simple_contrasts_dataset_01_${suffix}.csv`),
      path.join(baselinesRoot, `lmm_anova_${suffix}_r_baseline.json`),
      {
        datasetCsv,
        stratifyColumns: ['strain', 'sex'],
      }
    )
  }
}

main()
