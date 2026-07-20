/**
 * Type declarations for fast-formula-parser
 *
 * @see https://github.com/nicholaswmin/fast-formula-parser
 */

declare module 'fast-formula-parser' {
  export interface CellRef {
    row: number
    col: number
    sheet?: string
  }

  export interface RangeRef {
    from: CellRef
    to: CellRef
    sheet?: string
  }

  export interface FormulaParserConfig {
    onCell?: (ref: CellRef) => unknown
    onRange?: (ref: RangeRef) => unknown[][]
    functions?: Record<string, (...args: unknown[]) => unknown>
  }

  export interface CellPosition {
    row: number
    col: number
    sheet?: string
  }

  export interface FormulaError extends Error {
    name: string
    message: string
  }

  export interface DepParserResult {
    cells?: CellRef[]
    ranges?: RangeRef[]
  }

  export class DepParser {
    parse(formula: string, position?: CellPosition): DepParserResult
  }

  export default class FormulaParser {
    constructor(config?: FormulaParserConfig)
    parse(formula: string, position?: CellPosition): unknown
    on(event: string, handler: (...args: unknown[]) => void): void
    off(event: string, handler: (...args: unknown[]) => void): void
  }
}
