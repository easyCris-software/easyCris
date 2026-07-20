/**
 * Chi-square distribution utilities (pdf, cdf, inverse cdf).
 *
 * Uses Lanczos approximation for log-gamma and a regularized
 * incomplete gamma implementation (series + continued fraction).
 */

const LANCZOS_COEFFS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
]

const LANCZOS_G = 7
const EPS = 1e-10
const FPMIN = 1e-30
const MAX_ITERS = 100

function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  }

  let x = LANCZOS_COEFFS[0] ?? 0
  let t = z - 1
  for (let i = 1; i < LANCZOS_COEFFS.length; i += 1) {
    x += (LANCZOS_COEFFS[i] ?? 0) / (t + i)
  }

  const tmp = t + LANCZOS_G + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (t + 0.5) * Math.log(tmp) - tmp + Math.log(x)
}

function regularizedGammaP(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0) return NaN
  if (x <= 0) return 0

  if (x < a + 1) {
    let sum = 1 / a
    let del = sum
    let ap = a
    for (let n = 1; n <= MAX_ITERS; n += 1) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * EPS) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
  }

  let b = x + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d

  for (let i = 1; i <= MAX_ITERS; i += 1) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }

  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

export function chiSquarePdf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return NaN
  if (x <= 0) return 0
  const k = df / 2
  const logPdf = (k - 1) * Math.log(x) - x / 2 - k * Math.log(2) - logGamma(k)
  return Math.exp(logPdf)
}

export function chiSquareCdf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return NaN
  if (x <= 0) return 0
  return regularizedGammaP(df / 2, x / 2)
}

export function chiSquareInv(prob: number, df: number): number {
  if (!Number.isFinite(prob) || !Number.isFinite(df) || df <= 0) return NaN
  if (prob <= 0) return 0
  if (prob >= 1) return Infinity

  let lower = 0
  let upper = Math.max(1, df)
  while (chiSquareCdf(upper, df) < prob && upper < 1e6) {
    upper *= 2
  }

  for (let i = 0; i < 60; i += 1) {
    const mid = (lower + upper) / 2
    const cdf = chiSquareCdf(mid, df)
    if (cdf < prob) {
      lower = mid
    } else {
      upper = mid
    }
  }

  return (lower + upper) / 2
}
