/**
 * Group 3: Regression & Correlation Plots
 *
 * All plots autogenerate from test results.
 * Each test type gets 2 plots:
 * - Plot 1: Relationship (coefficients/correlation)
 * - Plot 2: Diagnostics/Performance (residuals/ROC/probability)
 */

// Correlation plots
export {
  generateCorrelationScatter,
  generatePearsonCorrelationHeatmap,
  generateSpearmanCorrelationHeatmap,
  generateKendallCorrelationHeatmap,
} from './correlation/generateCorrelationPlots'

// Simple Linear Regression plots
export {
  generateLinearRegressionScatterWithFit,
  generateLinearRegressionResidualPlot,
} from './regression/generateLinearRegressionPlots'

// Multiple Linear Regression plots
export {
  generateMultipleLinearForestPlot,
  generateMultipleLinearResidualPlot,
} from './regression/generateMultipleLinearRegressionPlots'

// Binary Logistic Regression plots
export {
  generateBinaryLogisticForestPlot,
  generateBinaryLogisticROCCurve,
} from './regression/generateBinaryLogisticPlots'

// Multinomial Logistic Regression plots
export {
  generateMultinomialLogisticForestPlot,
  generateMultinomialLogisticProbabilityPlot,
  generateMultinomialLogisticROCPlot,
} from './regression/generateMultinomialLogisticPlots'

// Types
export * from './types'
