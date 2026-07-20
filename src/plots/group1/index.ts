/**
 * Group 1 (Hypothesis Testing) Plot Builders
 *
 * Modular plot builders for parametric and nonparametric tests.
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * All exports are validated against validation baseline. Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

// Nonparametric builders
export { buildScheirerRayHareGroupedBar } from './nonparametric'

// Types
export type { GroupedBarOptions, CellSummary, GroupedBarBuilder } from './types'
