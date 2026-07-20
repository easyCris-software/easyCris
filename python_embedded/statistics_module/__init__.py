"""
Modular Statistical Analysis Package.

Exports a stable public API while keeping imports lazy so backend startup
does not eagerly pull heavy optional families.
"""

from __future__ import annotations

import importlib
from typing import Callable


def _missing_dependency(dep_name: str, exc: Exception) -> Callable:
    """Return a placeholder function that raises a helpful ImportError."""

    def _raiser(*args, **kwargs):
        raise ImportError(
            f"statistics_module requires optional dependency '{dep_name}' "
            f"for this function. Original error: {exc}"
        ) from exc

    return _raiser


__version__ = "2.6.0"  # Added drug combination analysis (HSA, Bliss, Loewe, ZIP)

__all__ = [
    # Utils
    "preprocess_data",
    "format_number",
    "sanitize_for_json",
    "ensure_critical_statistics",
    "interpret_partial_eta",
    "significance_marker",
    "significance_text",
    "set_context_metadata",
    "validate_input",
    # Descriptive
    "descriptive_statistics",
    "outlier_detection",
    # Parametric tests
    "t_test_one_sample",
    "t_test_two_sample",
    "t_test_paired",
    "anova_one_way",
    "anova_two_way",
    "multifactorial_anova",
    "lmm_anova",
    # Non-parametric tests
    "wilcoxon_signed_rank",
    "mann_whitney_u",
    "kruskal_wallis",
    "scheirer_ray_hare",
    "friedman_test",
    # Regression
    "logistic_regression_binary_statsmodels",
    "logistic_regression_binary_adaptive",
    "logistic_regression_multinomial_statsmodels",
    "logistic_regression_multinomial_adaptive",
    "multiple_linear_regression",
    # Correlation
    "correlation_analysis",
    "kendall_correlation",
    # Distributions
    "normality_tests",
    "anderson_darling_test",
    "kolmogorov_smirnov_test",
    "shapiro_wilk_test",
    "cramer_von_mises_test",
    "jarque_bera_test",
    # Contingency
    "chi_squared_test",
    "chi_squared_goodness_of_fit",
    "fisher_exact_test",
    "mcnemar_test",
    # Survival Analysis
    "kaplan_meier_analysis",
    "cox_proportional_hazards",
    "nelson_aalen_analysis",
    # Mediation Analysis
    "mediation_analysis",
    # Moderation Analysis
    "simple_moderation",
    "moderated_mediation_model7",
    # Dose-Response Analysis
    "fit_4pl_dose_response",
    "dose_response_analysis",
    "compare_dose_response_models",
    # Drug Combination Analysis
    "calculate_hsa_synergy",
    "calculate_bliss_synergy",
    "calculate_loewe_synergy",
    "calculate_zip_synergy",
    "synergy_analysis_json",
]

_EXPORT_SPECS: dict[str, tuple[str, str]] = {
    # utils
    "preprocess_data": ("statistics_module.utils", "preprocess_data"),
    "format_number": ("statistics_module.utils", "format_number"),
    "sanitize_for_json": ("statistics_module.utils", "sanitize_for_json"),
    "ensure_critical_statistics": ("statistics_module.utils", "ensure_critical_statistics"),
    "interpret_partial_eta": ("statistics_module.utils", "interpret_partial_eta"),
    "significance_marker": ("statistics_module.utils", "significance_marker"),
    "significance_text": ("statistics_module.utils", "significance_text"),
    "set_context_metadata": ("statistics_module.utils", "set_context_metadata"),
    "validate_input": ("statistics_module.utils", "validate_input"),
    # descriptive
    "descriptive_statistics": ("statistics_module.descriptive", "descriptive_statistics"),
    "outlier_detection": ("statistics_module.descriptive", "outlier_detection"),
    # parametric + anova
    "t_test_one_sample": ("statistics_module.parametric", "t_test_one_sample"),
    "t_test_two_sample": ("statistics_module.parametric", "t_test_two_sample"),
    "t_test_paired": ("statistics_module.parametric", "t_test_paired"),
    "anova_one_way": ("statistics_module.parametric", "anova_one_way"),
    "anova_two_way": ("statistics_module.anova", "anova_two_way"),
    "multifactorial_anova": ("statistics_module.multifactorial_anova", "multifactorial_anova"),
    "lmm_anova": ("statistics_module.lmm_anova", "lmm_anova"),
    # non-parametric
    "wilcoxon_signed_rank": ("statistics_module.nonparametric", "wilcoxon_signed_rank"),
    "mann_whitney_u": ("statistics_module.nonparametric", "mann_whitney_u"),
    "kruskal_wallis": ("statistics_module.nonparametric", "kruskal_wallis"),
    "scheirer_ray_hare": ("statistics_module.nonparametric", "scheirer_ray_hare"),
    "friedman_test": ("statistics_module.nonparametric", "friedman_test"),
    # regression
    "logistic_regression_binary_statsmodels": (
        "statistics_module.regression",
        "logistic_regression_binary_statsmodels",
    ),
    "logistic_regression_binary_adaptive": (
        "statistics_module.regression",
        "logistic_regression_binary_adaptive",
    ),
    "logistic_regression_multinomial_statsmodels": (
        "statistics_module.regression",
        "logistic_regression_multinomial_statsmodels",
    ),
    "logistic_regression_multinomial_adaptive": (
        "statistics_module.regression",
        "logistic_regression_multinomial_adaptive",
    ),
    "multiple_linear_regression": ("statistics_module.regression", "multiple_linear_regression"),
    # correlation
    "correlation_analysis": ("statistics_module.correlation", "correlation_analysis"),
    "kendall_correlation": ("statistics_module.correlation", "kendall_correlation"),
    # distributions
    "normality_tests": ("statistics_module.distributions", "normality_tests"),
    "anderson_darling_test": ("statistics_module.distributions", "anderson_darling_test"),
    "kolmogorov_smirnov_test": ("statistics_module.distributions", "kolmogorov_smirnov_test"),
    "shapiro_wilk_test": ("statistics_module.distributions", "shapiro_wilk_test"),
    "cramer_von_mises_test": ("statistics_module.distributions", "cramer_von_mises_test"),
    "jarque_bera_test": ("statistics_module.distributions", "jarque_bera_test"),
    # contingency
    "chi_squared_test": ("statistics_module.contingency", "chi_squared_test"),
    "chi_squared_goodness_of_fit": (
        "statistics_module.contingency",
        "chi_squared_goodness_of_fit",
    ),
    "fisher_exact_test": ("statistics_module.contingency", "fisher_exact_test"),
    "mcnemar_test": ("statistics_module.contingency", "mcnemar_test"),
    # survival
    "kaplan_meier_analysis": ("statistics_module.survival", "kaplan_meier_analysis"),
    "cox_proportional_hazards": ("statistics_module.survival", "cox_proportional_hazards"),
    "nelson_aalen_analysis": ("statistics_module.survival", "nelson_aalen_analysis"),
    # mediation/moderation
    "mediation_analysis": ("statistics_module.mediation", "mediation_analysis"),
    "simple_moderation": ("statistics_module.moderation", "simple_moderation"),
    "moderated_mediation_model7": (
        "statistics_module.moderation",
        "moderated_mediation_model7",
    ),
    # dose-response
    "fit_4pl_dose_response": ("statistics_module.dose_response", "fit_4pl_dose_response"),
    "dose_response_analysis": ("statistics_module.dose_response", "dose_response_analysis"),
    "compare_dose_response_models": (
        "statistics_module.dose_response",
        "compare_dose_response_models",
    ),
    # drug combo
    "calculate_hsa_synergy": ("statistics_module.drug_combo", "calculate_hsa_synergy"),
    "calculate_bliss_synergy": ("statistics_module.drug_combo", "calculate_bliss_synergy"),
    "calculate_loewe_synergy": ("statistics_module.drug_combo", "calculate_loewe_synergy"),
    "calculate_zip_synergy": ("statistics_module.drug_combo", "calculate_zip_synergy"),
    "synergy_analysis_json": ("statistics_module.drug_combo", "synergy_analysis_json"),
}

_OPTIONAL_DEPENDENCY_HINTS: dict[str, str] = {
    "fit_4pl_dose_response": "lmfit",
    "dose_response_analysis": "lmfit",
    "compare_dose_response_models": "lmfit",
    "calculate_hsa_synergy": "dose_response/drug_combo",
    "calculate_bliss_synergy": "dose_response/drug_combo",
    "calculate_loewe_synergy": "dose_response/drug_combo",
    "calculate_zip_synergy": "dose_response/drug_combo",
    "synergy_analysis_json": "dose_response/drug_combo",
}


def __getattr__(name: str):
    spec = _EXPORT_SPECS.get(name)
    if spec is None:
        raise AttributeError(f"module 'statistics_module' has no attribute '{name}'")

    module_name, attr_name = spec
    try:
        module = importlib.import_module(module_name)
        value = getattr(module, attr_name)
    except Exception as exc:
        dep_hint = _OPTIONAL_DEPENDENCY_HINTS.get(name)
        if not dep_hint:
            raise
        value = _missing_dependency(dep_hint, exc)

    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals().keys()) | set(__all__))
