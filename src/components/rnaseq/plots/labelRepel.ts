export interface RepelLabelInput {
  anchorX: number
  anchorY: number
  labelX: number
  labelY: number
  text: string
}

export interface RepelLabelOutput extends RepelLabelInput {
  /** Distance label was displaced from anchor */
  displacement: number
  /** Whether to draw a leader line (displacement > minSegmentLength) */
  needsLeaderLine: boolean
  /** Number of overlaps with other labels (for culling) */
  overlapCount: number
}

export interface RepelLabelOptions {
  xRange: [number, number]
  yRange: [number, number]
  maxIterations?: number
  padding?: number
  pull?: number
  step?: number
  maxOffset?: number | ((label: RepelLabelInput) => number)
  /** Minimum displacement before drawing leader line */
  minSegmentLength?: number
  /** Maximum overlaps before excluding label */
  maxOverlaps?: number
  /** Multiplier for repulsion force between overlapping labels (default 1.0) */
  repelForce?: number
}

interface LabelBox<T extends RepelLabelInput> extends RepelLabelInput {
  width: number
  height: number
  extra: Omit<T, keyof RepelLabelInput>
  overlapCount: number
}

/**
 * Repel labels to avoid overlaps while staying close to anchor points.
 * Preserves any extra properties on the input labels.
 * Returns enhanced output with displacement info for leader lines.
 */
export function repelLabels<T extends RepelLabelInput>(
  labels: T[],
  options: RepelLabelOptions
): (T & RepelLabelOutput)[] {
  const rangeX = options.xRange[1] - options.xRange[0]
  const rangeY = options.yRange[1] - options.yRange[0]
  const safeRangeX = Math.max(1e-6, Math.abs(rangeX))
  const safeRangeY = Math.max(1e-6, Math.abs(rangeY))

  const charWidth = safeRangeX / 90
  const lineHeight = safeRangeY / 40
  const padding = options.padding ?? Math.min(safeRangeX, safeRangeY) * 0.01
  const pull = options.pull ?? 0.03
  let step = options.step ?? 0.25
  const maxIterations = options.maxIterations ?? 80
  const minSegmentLength = options.minSegmentLength ?? Math.min(safeRangeX, safeRangeY) * 0.02
  const repelForce = options.repelForce ?? 1.0

  // Extract extra properties and store them separately
  const boxes: LabelBox<T>[] = labels.map((label) => {
    const { anchorX, anchorY, labelX, labelY, text, ...extra } = label
    return {
      anchorX,
      anchorY,
      labelX,
      labelY,
      text,
      width: Math.max(1, text.length) * charWidth,
      height: lineHeight,
      extra: extra as Omit<T, keyof RepelLabelInput>,
      overlapCount: 0,
    }
  })

  const minX = options.xRange[0] + padding
  const maxX = options.xRange[1] - padding
  const minY = options.yRange[0] + padding
  const maxY = options.yRange[1] - padding

  for (let iter = 0; iter < maxIterations; iter++) {
    // Reset overlap counts each iteration
    for (const box of boxes) {
      if (box) box.overlapCount = 0
    }

    let totalOverlaps = 0

    for (let i = 0; i < boxes.length; i++) {
      const current = boxes[i]
      if (!current) continue

      let fx = 0
      let fy = 0

      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue
        const other = boxes[j]
        if (!other) continue

        const dx = current.labelX - other.labelX
        const dy = current.labelY - other.labelY
        const overlapX =
          (current.width + other.width) / 2 + padding - Math.abs(dx)
        const overlapY =
          (current.height + other.height) / 2 + padding - Math.abs(dy)

        if (overlapX > 0 && overlapY > 0) {
          current.overlapCount++
          totalOverlaps++
          const signX = dx === 0 ? (i % 2 === 0 ? 1 : -1) : Math.sign(dx)
          const signY = dy === 0 ? (i % 2 === 0 ? -1 : 1) : Math.sign(dy)
          fx += signX * overlapX * repelForce
          fy += signY * overlapY * repelForce
        }
      }

      const dxAnchor = current.anchorX - current.labelX
      const dyAnchor = current.anchorY - current.labelY
      fx += dxAnchor * pull
      fy += dyAnchor * pull

      current.labelX += fx * step
      current.labelY += fy * step

      // Keep the full label box inside the axis range
      const halfWidth = current.width / 2
      const halfHeight = current.height / 2
      const boundMinX = minX + halfWidth
      const boundMaxX = maxX - halfWidth
      const boundMinY = minY + halfHeight
      const boundMaxY = maxY - halfHeight

      current.labelX =
        boundMinX > boundMaxX
          ? (minX + maxX) / 2
          : clamp(current.labelX, boundMinX, boundMaxX)
      current.labelY =
        boundMinY > boundMaxY
          ? (minY + maxY) / 2
          : clamp(current.labelY, boundMinY, boundMaxY)

      const maxOffset =
        typeof options.maxOffset === 'function'
          ? options.maxOffset({
              anchorX: current.anchorX,
              anchorY: current.anchorY,
              labelX: current.labelX,
              labelY: current.labelY,
              text: current.text,
            })
          : options.maxOffset

      if (maxOffset && maxOffset > 0) {
        const offsetX = current.labelX - current.anchorX
        const offsetY = current.labelY - current.anchorY
        const distance = Math.hypot(offsetX, offsetY)
        if (distance > maxOffset) {
          const scale = maxOffset / distance
          current.labelX = current.anchorX + offsetX * scale
          current.labelY = current.anchorY + offsetY * scale
          current.labelX =
            boundMinX > boundMaxX
              ? (minX + maxX) / 2
              : clamp(current.labelX, boundMinX, boundMaxX)
          current.labelY =
            boundMinY > boundMaxY
              ? (minY + maxY) / 2
              : clamp(current.labelY, boundMinY, boundMaxY)
        }
      }
    }

    // Early exit: no overlaps detected after initial settling
    if (totalOverlaps === 0 && iter > 5) break

    step *= 0.92
  }

  // Final overlap count based on settled positions (used for culling).
  for (const box of boxes) {
    if (box) box.overlapCount = 0
  }
  for (let i = 0; i < boxes.length; i++) {
    const current = boxes[i]
    if (!current) continue
    for (let j = i + 1; j < boxes.length; j++) {
      const other = boxes[j]
      if (!other) continue
      const dx = current.labelX - other.labelX
      const dy = current.labelY - other.labelY
      const overlapX =
        (current.width + other.width) / 2 + padding - Math.abs(dx)
      const overlapY =
        (current.height + other.height) / 2 + padding - Math.abs(dy)
      if (overlapX > 0 && overlapY > 0) {
        current.overlapCount++
        other.overlapCount++
      }
    }
  }

  // Return with updated positions, preserved extra properties, and leader line info
  return boxes.map((box) => {
    const displacement = Math.hypot(box.labelX - box.anchorX, box.labelY - box.anchorY)
    return {
      ...box.extra,
      anchorX: box.anchorX,
      anchorY: box.anchorY,
      labelX: box.labelX,
      labelY: box.labelY,
      text: box.text,
      displacement,
      needsLeaderLine: displacement > minSegmentLength,
      overlapCount: box.overlapCount,
    }
  }) as (T & RepelLabelOutput)[]
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
