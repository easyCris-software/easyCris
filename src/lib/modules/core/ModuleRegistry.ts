/**
 * Module Registry
 *
 * Centralized registry for statistical test modules.
 * Ported from Avalonia StatisticalTestModuleRegistry.cs
 *
 * Phase 2: Core Infrastructure
 * - Single source of truth for module lookups
 * - Priority-based fallback (if module not found, graceful degradation)
 * - Lazy loading via dynamic imports (code splitting)
 */

import type { ITestModule } from './types'

/**
 * Module loader function type
 * Returns a Promise that resolves to the test module
 */
type ModuleLoader = () => Promise<ITestModule>

/**
 * Module Registry Class
 *
 * Manages registration and retrieval of statistical test modules.
 * Uses lazy loading to avoid bundling all modules upfront.
 */
class ModuleRegistry {
  private modules: Map<string, ModuleLoader> = new Map()

  /**
   * Register a test module
   *
   * @param moduleId - Unique identifier for the module (matches testRegistry.ts)
   * @param loader - Async function that imports and returns the module
   */
  register(moduleId: string, loader: ModuleLoader): void {
    if (this.modules.has(moduleId)) {
      console.warn(`ModuleRegistry: Module '${moduleId}' is already registered. Overwriting.`)
    }
    this.modules.set(moduleId, loader)
  }

  /**
   * Get a test module by ID
   *
   * @param moduleId - The module identifier
   * @returns The test module, or null if not found
   */
  async getModule(moduleId: string): Promise<ITestModule | null> {
    const loader = this.modules.get(moduleId)
    if (!loader) {
      return null // Graceful fallback: module not registered
    }

    try {
      return await loader()
    } catch (error) {
      console.error(`ModuleRegistry: Failed to load module '${moduleId}':`, error)
      return null
    }
  }

  /**
   * Check if a module is registered
   *
   * @param moduleId - The module identifier
   * @returns True if the module is registered
   */
  hasModule(moduleId: string): boolean {
    return this.modules.has(moduleId)
  }

  /**
   * Get all registered module IDs
   *
   * @returns Array of registered module identifiers
   */
  getRegisteredModules(): string[] {
    return Array.from(this.modules.keys())
  }

  /**
   * Clear all registered modules (for testing)
   */
  clear(): void {
    this.modules.clear()
  }
}

// Singleton instance
const moduleRegistry = new ModuleRegistry()

// =============================================================================
// MODULE REGISTRATION
// =============================================================================
// Register all available modules here
// Adding a new module only requires adding one line to this section

// Parametric Tests
moduleRegistry.register('independent_ttest', async () => {
  const { independentTTestModule } = await import('../parametric/tTestModule')
  return independentTTestModule
})

moduleRegistry.register('paired_ttest', async () => {
  const { pairedTTestModule } = await import('../parametric/pairedTTestModule')
  return pairedTTestModule
})

moduleRegistry.register('one_sample_ttest', async () => {
  const { oneSampleTTestModule } = await import('../parametric/oneSampleTTestModule')
  return oneSampleTTestModule
})

moduleRegistry.register('one_way_anova', async () => {
  const { oneWayAnovaModule } = await import('../parametric/oneWayAnovaModule')
  return oneWayAnovaModule
})

moduleRegistry.register('two_way_anova', async () => {
  const { twoWayAnovaModule } = await import('../parametric/twoWayAnovaModule')
  return twoWayAnovaModule
})

moduleRegistry.register('lmm_anova', async () => {
  const { lmmAnovaModule } = await import('../parametric/lmmAnovaModule')
  return lmmAnovaModule
})

// Nonparametric Tests
moduleRegistry.register('mann_whitney', async () => {
  const { mannWhitneyModule } = await import('../nonparametric/mannWhitneyModule')
  return mannWhitneyModule
})

moduleRegistry.register('wilcoxon', async () => {
  const { wilcoxonModule } = await import('../nonparametric/wilcoxonModule')
  return wilcoxonModule
})

moduleRegistry.register('kruskal_wallis', async () => {
  const { kruskalWallisModule } = await import('../nonparametric/kruskalWallisModule')
  return kruskalWallisModule
})

moduleRegistry.register('friedman', async () => {
  const { friedmanModule } = await import('../nonparametric/friedmanModule')
  return friedmanModule
})

moduleRegistry.register('scheirer_ray_hare', async () => {
  const { scheirerRayHareModule } = await import('../nonparametric/scheirerRayHareModule')
  return scheirerRayHareModule
})

moduleRegistry.register('multifactorial_anova', async () => {
  const { multifactorialAnovaModule } = await import('../parametric/multifactorialAnovaModule')
  return multifactorialAnovaModule
})

// Categorical Tests
moduleRegistry.register('chi_square', async () => {
  const { chiSquareModule } = await import('../categorical/chiSquareModule')
  return chiSquareModule
})

moduleRegistry.register('fishers_exact', async () => {
  const { fisherExactModule } = await import('../categorical/fisherExactModule')
  return fisherExactModule
})

moduleRegistry.register('mcnemar', async () => {
  const { mcnemarModule } = await import('../categorical/mcnemarModule')
  return mcnemarModule
})

moduleRegistry.register('chi_square_gof', async () => {
  const { chiSquareGofModule } = await import('../categorical/chiSquareGofModule')
  return chiSquareGofModule
})

// Distribution Tests
moduleRegistry.register('normality_shapiro', async () => {
  const { shapiroWilkModule } = await import('../distribution/shapiroWilkModule')
  return shapiroWilkModule
})

moduleRegistry.register('normality_ks', async () => {
  const { ksModule } = await import('../distribution/ksModule')
  return ksModule
})

moduleRegistry.register('normality_ad', async () => {
  const { andersonDarlingModule } = await import('../distribution/andersonDarlingModule')
  return andersonDarlingModule
})

moduleRegistry.register('normality_cvm', async () => {
  const { cramerVonMisesModule } = await import('../distribution/cramerVonMisesModule')
  return cramerVonMisesModule
})

moduleRegistry.register('normality_jb', async () => {
  const { jarqueBerraModule } = await import('../distribution/jarqueBerraModule')
  return jarqueBerraModule
})

moduleRegistry.register('normality_all', async () => {
  const { normalityAllModule } = await import('../distribution/normalityAllModule')
  return normalityAllModule
})

// Descriptive Tests
moduleRegistry.register('descriptive_stats', async () => {
  const { descriptiveStatsModule } = await import('../descriptive/descriptiveStatsModule')
  return descriptiveStatsModule
})

moduleRegistry.register('outlier_detection', async () => {
  const { outlierDetectionModule } = await import('../descriptive/outlierDetectionModule')
  return outlierDetectionModule
})

// Correlation Tests
moduleRegistry.register('correlation_pearson', async () => {
  const { pearsonModule } = await import('../correlation/pearsonModule')
  return pearsonModule
})

moduleRegistry.register('correlation_spearman', async () => {
  const { spearmanModule } = await import('../correlation/spearmanModule')
  return spearmanModule
})

moduleRegistry.register('correlation_kendall', async () => {
  const { kendallModule } = await import('../correlation/kendallModule')
  return kendallModule
})

// Regression Tests (unified module with dynamic type detection)
moduleRegistry.register('regression', async () => {
  const { regressionModule } = await import('../regression/regressionModule')
  return regressionModule
})

moduleRegistry.register('linear_regression', async () => {
  const { regressionModule } = await import('../regression/regressionModule')
  return regressionModule
})

moduleRegistry.register('multiple_linear_regression', async () => {
  const { regressionModule } = await import('../regression/regressionModule')
  return regressionModule
})

moduleRegistry.register('logistic_regression', async () => {
  const { regressionModule } = await import('../regression/regressionModule')
  return regressionModule
})

moduleRegistry.register('logistic_multinomial', async () => {
  const { regressionModule } = await import('../regression/regressionModule')
  return regressionModule
})

// Survival Analysis
moduleRegistry.register('kaplan_meier', async () => {
  const { kaplanMeierModule } = await import('../survival/kaplanMeierModule')
  return kaplanMeierModule
})

moduleRegistry.register('cox_regression', async () => {
  const { coxRegressionModule } = await import('../survival/coxRegressionModule')
  return coxRegressionModule
})

moduleRegistry.register('nelson_aalen', async () => {
  const { nelsonAalenModule } = await import('../survival/nelsonAalenModule')
  return nelsonAalenModule
})

// Pharmacology - Dose Response
moduleRegistry.register('dose_response_3pl', async () => {
  const { doseResponse3plModule } = await import('../pharmacology/doseResponse3plModule')
  return doseResponse3plModule
})

moduleRegistry.register('dose_response_4pl', async () => {
  const { doseResponse4plModule } = await import('../pharmacology/doseResponse4plModule')
  return doseResponse4plModule
})

moduleRegistry.register('dose_response_5pl', async () => {
  const { doseResponse5plModule } = await import('../pharmacology/doseResponse5plModule')
  return doseResponse5plModule
})

moduleRegistry.register('dose_response_compare', async () => {
  const { doseResponseCompareModule } = await import('../pharmacology/doseResponseCompareModule')
  return doseResponseCompareModule
})

// Pharmacology - Synergy
moduleRegistry.register('synergy_bliss', async () => {
  const { synergyBlissModule } = await import('../pharmacology/synergyBlissModule')
  return synergyBlissModule
})

moduleRegistry.register('synergy_hsa', async () => {
  const { synergyHsaModule } = await import('../pharmacology/synergyHsaModule')
  return synergyHsaModule
})

moduleRegistry.register('synergy_loewe', async () => {
  const { synergyLoeweModule } = await import('../pharmacology/synergyLoeweModule')
  return synergyLoeweModule
})

moduleRegistry.register('synergy_zip', async () => {
  const { synergyZipModule } = await import('../pharmacology/synergyZipModule')
  return synergyZipModule
})

moduleRegistry.register('synergy_all', async () => {
  const { synergyAllModule } = await import('../pharmacology/synergyAllModule')
  return synergyAllModule
})

// Mediation & Moderation Analysis
moduleRegistry.register('mediation_model4', async () => {
  const { mediationModule } = await import('../mediation/mediationModule')
  return mediationModule
})

moduleRegistry.register('moderation_model1', async () => {
  const { moderationModule } = await import('../moderation/moderationModule')
  return moderationModule
})

moduleRegistry.register('moderated_mediation_model7', async () => {
  const { moderatedMediationModule } = await import('../moderation/moderatedMediationModule')
  return moderatedMediationModule
})

// Export singleton instance
export { moduleRegistry }
export type { ModuleLoader }
