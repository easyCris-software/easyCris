/**
 * Python Fixture Helpers
 *
 * Utilities for loading and validating Python response fixtures.
 *
 * CRITICAL: All fixtures must be generated from actual Python backend execution.
 * DO NOT manually edit fixture values or invent synthetic data.
 *
 * Fixtures are sourced from `_test_validation/` directory and regenerated when:
 * - VALIDATED_VERSIONS.json is updated
 * - requirements-validated.txt changes
 * - Validation tests reveal schema drift
 */

/**
 * Helper to load Python response fixtures
 *
 * @param testName - Name of the test (e.g., 't_test', 'linear_regression')
 * @returns Python response object
 *
 * @example
 * const response = loadPythonFixture('t_test')
 * expect(response.p_value).toBeDefined()
 */
export function loadPythonFixture(testName: string): Record<string, unknown> {
  // In real implementation, use dynamic import or fs.readFileSync
  // For now, return empty object (tests will provide inline fixtures)
  try {
    return require(`./fixtures/${testName}_response.json`)
  } catch (error) {
    throw new Error(
      `Python fixture not found: ${testName}_response.json. ` +
      `Generate fixtures from actual Python backend using: ` +
      `python_embedded/python.exe -c "from statistics_module.${testName} import ..."`
    )
  }
}

/**
 * Validate Python response schema
 *
 * Ensures required fields are present in Python response.
 * Useful for detecting schema drift when Python backend changes.
 *
 * @param response - Python response object
 * @param requiredFields - Array of required field names
 * @throws Error if any required field is missing
 *
 * @example
 * validatePythonResponse(response, ['p_value', 'statistic', 'degrees_of_freedom'])
 */
export function validatePythonResponse(
  response: Record<string, unknown>,
  requiredFields: string[]
): void {
  const missingFields: string[] = []

  for (const field of requiredFields) {
    if (!(field in response)) {
      missingFields.push(field)
    }
  }

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required fields in Python response: ${missingFields.join(', ')}. ` +
      `This may indicate schema drift. Regenerate fixtures or update test expectations.`
    )
  }
}

/**
 * Validate fixture version matches expected Python module version
 *
 * Ensures fixtures are regenerated when Python modules are updated.
 *
 * @param fixture - Python response fixture
 * @param expectedVersion - Expected Python module version (e.g., 'parametric.py v2.4.0')
 * @throws Error if version mismatch
 *
 * @example
 * validateFixtureVersion(fixture, 'parametric.py v2.4.0')
 */
export function validateFixtureVersion(
  fixture: Record<string, unknown>,
  expectedVersion: string
): void {
  const fixtureVersion = fixture._python_module_version as string | undefined

  if (!fixtureVersion) {
    console.warn(
      `Fixture missing version metadata. Consider regenerating with version header.`
    )
    return
  }

  if (fixtureVersion !== expectedVersion) {
    throw new Error(
      `Fixture version mismatch: expected ${expectedVersion}, got ${fixtureVersion}. ` +
      `Regenerate fixtures after Python module updates.`
    )
  }
}

/**
 * Common Python response schemas for validation
 *
 * Provides predefined schemas for different test families.
 */
export const PYTHON_RESPONSE_SCHEMAS = {
  // Parametric tests (t-test, paired t-test, etc.)
  parametric: ['p_value', 'statistic', 'degrees_of_freedom'],

  // Non-parametric tests (Mann-Whitney, Wilcoxon, etc.)
  nonparametric: ['p_value', 'statistic'],

  // ANOVA tests
  anova: ['p_value', 'f_statistic', 'degrees_of_freedom_between', 'degrees_of_freedom_within'],

  // Regression tests
  regression: ['coefficients', 'p_values', 'r_squared'],

  // Survival tests
  survival: ['median_survival', 'survival_curve'],

  // Correlation tests
  correlation: ['p_value', 'correlation_coefficient'],

  // Contingency tests
  contingency: ['p_value', 'chi_squared', 'degrees_of_freedom'],
} as const

/**
 * Helper to create inline fixture for testing
 *
 * Use this for simple tests that don't need full Python backend integration.
 * For integration tests, use loadPythonFixture() with real fixtures.
 *
 * @param baseData - Base fixture data
 * @param overrides - Additional or override fields
 * @returns Complete fixture with version metadata
 *
 * @example
 * const fixture = createInlineFixture(
 *   { p_value: 0.023, statistic: 2.45 },
 *   { _python_module_version: 'parametric.py v2.4.0' }
 * )
 */
export function createInlineFixture(
  baseData: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    _fixture_version: '1.0.0',
    _python_module_version: 'test-inline',
    _generated_date: new Date().toISOString().split('T')[0],
    ...baseData,
    ...overrides,
  }
}
