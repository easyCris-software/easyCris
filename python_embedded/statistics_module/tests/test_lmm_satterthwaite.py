import numpy as np
import pandas as pd
import sys
from pathlib import Path
from patsy import dmatrix
import statsmodels.formula.api as smf
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python_embedded.statistics_module.lmm_parameterization import (
    cov_beta_from_finite_df_varpar,
    cov_beta_from_packed_theta,
    extract_finite_df_varpar_spec,
    extract_packed_theta_spec,
    finite_df_negloglike_from_varpar,
    update_packed_theta,
)
from python_embedded.statistics_module.lmm_inference_satterthwaite import (
    finite_difference_step_sizes,
    numerical_cov_beta_jacobian,
)
from python_embedded.statistics_module import lmm_inference_satterthwaite as sat_module
from python_embedded.statistics_module.lmm_inference_core import (
    contract_cov_jacobian,
    effective_rank,
    infer_1d_from_df,
    infer_md_from_df,
    md_denom_df,
    quad_form_mat,
    quad_form_vec,
    rotate_subcontrasts,
    satterthwaite_df_1d,
    satterthwaite_df_md,
)
from python_embedded.statistics_module.lmm_type3 import (
    build_type3_contrasts_from_formulas,
    normalize_term_name,
    type3_correction_matrix,
)


def test_quad_form_vec_returns_scalar_quadratic_form():
    vec = np.array([1.0, -2.0])
    mat = np.array([[2.0, 0.5], [0.5, 3.0]])

    result = quad_form_vec(vec, mat)

    assert result == 12.0


def test_quad_form_mat_returns_projected_covariance():
    contrast = np.array([[1.0, 0.0], [1.0, -1.0]])
    cov = np.array([[2.0, 0.5], [0.5, 3.0]])

    result = quad_form_mat(contrast, cov)

    assert np.allclose(result, np.array([[2.0, 1.5], [1.5, 4.0]]))


def test_effective_rank_ignores_tiny_eigenvalues():
    cov = np.diag([3.0, 1e-12, 0.25])

    result = effective_rank(cov)

    assert result == 2


def test_effective_rank_preserves_small_but_full_rank_matrices():
    cov = np.array(
        [
            [1.70433294e-14, -8.52166469e-15],
            [-8.52166469e-15, 1.70433294e-14],
        ]
    )

    result = effective_rank(cov)

    assert result == 2


def _fit_random_intercept_model():
    df = pd.DataFrame(
        {
            "y": [1.0, 1.2, 2.0, 2.3, 3.0, 3.1, 4.0, 4.2],
            "x": [0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
            "group": ["A", "A", "B", "B", "C", "C", "D", "D"],
        }
    )
    return smf.mixedlm("y ~ x", df, groups=df["group"]).fit(reml=False, method="lbfgs", disp=False)


def _fit_random_slope_model():
    rows = []
    group_offsets = {"A": -0.4, "B": 0.2, "C": 0.9, "D": 1.5}
    group_slopes = {"A": 0.7, "B": 1.0, "C": 1.4, "D": 1.8}
    for group, offset in group_offsets.items():
        slope = group_slopes[group]
        for x_value in [0.0, 0.5, 1.0, 1.5]:
            rows.append(
                {
                    "y": 2.0 + offset + ((1.2 + slope) * x_value),
                    "x": x_value,
                    "group": group,
                }
            )
    df = pd.DataFrame(rows)
    return smf.mixedlm("y ~ x", df, groups=df["group"], re_formula="1 + x").fit(
        reml=False,
        method="lbfgs",
        disp=False,
    )


def test_extract_packed_theta_spec_matches_statsmodels_parameter_order():
    fit = _fit_random_intercept_model()

    spec = extract_packed_theta_spec(fit)

    assert spec.names == list(fit.params.index[fit.model.k_fe :])
    assert spec.theta.shape == (len(spec.names),)
    assert spec.covariance.shape == (len(spec.names), len(spec.names))


def test_extract_packed_theta_spec_keeps_name_to_covariance_alignment():
    fit = _fit_random_intercept_model()

    spec = extract_packed_theta_spec(fit)

    theta_name = spec.names[0]
    statsmodels_cov = np.asarray(fit.cov_params().iloc[fit.model.k_fe :, fit.model.k_fe :], dtype=float)

    assert spec.index[theta_name] == 0
    assert spec.theta[spec.index[theta_name]] == fit.params.iloc[fit.model.k_fe]
    assert np.allclose(spec.covariance, statsmodels_cov)


def test_update_packed_theta_overrides_named_component_without_reordering():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)

    updated = update_packed_theta(spec, **{spec.names[0]: spec.theta[0] + 1.5})

    assert updated.shape == spec.theta.shape
    assert updated[0] == spec.theta[0] + 1.5


def test_cov_beta_from_packed_theta_reproduces_fitted_covariance():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)

    cov_beta = cov_beta_from_packed_theta(fit, spec.theta)
    fitted_cov = np.asarray(fit.cov_params().iloc[: fit.model.k_fe, : fit.model.k_fe], dtype=float)

    assert cov_beta.shape == (fit.model.k_fe, fit.model.k_fe)
    assert np.allclose(cov_beta, fitted_cov)


def test_cov_beta_from_packed_theta_stays_stable_under_small_perturbation():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)
    perturbed = update_packed_theta(spec, **{spec.names[0]: spec.theta[0] * 1.01})

    cov_beta = cov_beta_from_packed_theta(fit, perturbed)

    assert cov_beta.shape == (fit.model.k_fe, fit.model.k_fe)
    assert np.all(np.isfinite(cov_beta))
    assert np.allclose(cov_beta, cov_beta.T)


def test_cov_beta_from_packed_theta_rejects_invalid_random_intercept_variance():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)
    invalid = update_packed_theta(spec, **{spec.names[0]: -1.0})

    with pytest.raises(ValueError, match="non-positive-definite"):
        cov_beta_from_packed_theta(fit, invalid)


def test_extract_finite_df_varpar_spec_uses_relative_cholesky_theta_and_sigma():
    fit = _fit_random_intercept_model()

    spec = extract_finite_df_varpar_spec(fit)

    expected_theta = float(np.sqrt(np.asarray(fit.cov_re, dtype=float)[0, 0] / float(fit.scale)))
    assert spec.names == ["theta_cholesky", "Sigma"]
    assert spec.theta.shape == (2,)
    assert spec.theta[0] == pytest.approx(expected_theta)
    assert spec.theta[1] == pytest.approx(float(np.sqrt(fit.scale)))
    assert spec.covariance.shape == (2, 2)
    assert np.all(np.isfinite(spec.covariance))


def test_finite_df_negloglike_from_varpar_matches_fitted_loglikelihood():
    fit = _fit_random_intercept_model()
    spec = extract_finite_df_varpar_spec(fit)

    neg_loglike = finite_df_negloglike_from_varpar(fit, spec.theta)

    assert neg_loglike == pytest.approx(-fit.llf, rel=1e-6, abs=1e-6)


def test_cov_beta_from_finite_df_varpar_reproduces_fitted_covariance():
    fit = _fit_random_intercept_model()
    spec = extract_finite_df_varpar_spec(fit)

    cov_beta = cov_beta_from_finite_df_varpar(fit, spec.theta)
    fitted_cov = np.asarray(fit.cov_params().iloc[: fit.model.k_fe, : fit.model.k_fe], dtype=float)

    assert cov_beta.shape == (fit.model.k_fe, fit.model.k_fe)
    assert np.allclose(cov_beta, fitted_cov)


def test_cov_beta_from_finite_df_varpar_changes_when_sigma_changes():
    fit = _fit_random_intercept_model()
    spec = extract_finite_df_varpar_spec(fit)
    perturbed = np.array(spec.theta, copy=True)
    perturbed[1] *= 1.05

    cov_beta = cov_beta_from_finite_df_varpar(fit, perturbed)
    fitted_cov = np.asarray(fit.cov_params().iloc[: fit.model.k_fe, : fit.model.k_fe], dtype=float)

    assert cov_beta.shape == fitted_cov.shape
    assert not np.allclose(cov_beta, fitted_cov)


def test_contract_cov_jacobian_projects_each_theta_gradient():
    contrast = np.array([1.0, -1.0])
    jacobian = np.array(
        [
            [[1.0, 0.2], [0.2, 0.5]],
            [[0.5, 0.0], [0.0, 0.5]],
        ]
    )

    gradient = contract_cov_jacobian(contrast, jacobian)

    assert np.allclose(gradient, np.array([1.1, 1.0]))


def test_satterthwaite_df_1d_returns_positive_finite_df():
    contrast = np.array([1.0, -1.0])
    cov_beta = np.array([[2.0, 0.5], [0.5, 3.0]])
    jacobian = np.array(
        [
            [[1.0, 0.2], [0.2, 0.5]],
            [[0.5, 0.0], [0.0, 0.5]],
        ]
    )
    theta_cov = np.array([[2.0, 0.3], [0.3, 1.5]])

    df = satterthwaite_df_1d(contrast, cov_beta, jacobian, theta_cov)

    assert round(df, 4) == 6.9869


def test_satterthwaite_df_1d_returns_infinity_for_zero_gradient():
    contrast = np.array([1.0, 0.0])
    cov_beta = np.array([[2.0, 0.0], [0.0, 3.0]])
    jacobian = np.zeros((2, 2, 2))
    theta_cov = np.eye(2)

    df = satterthwaite_df_1d(contrast, cov_beta, jacobian, theta_cov)

    assert df == float("inf")


def test_test_1d_from_df_uses_t_distribution_for_finite_df():
    statistic, p_value = infer_1d_from_df(estimate=2.0, standard_error=0.5, df=10.0)

    assert statistic == 4.0
    assert round(p_value, 6) == 0.002518


def test_rotate_subcontrasts_preserves_rank_one_direction():
    contrast = np.array([[1.0, -1.0]])
    cov_beta = np.array([[2.0, 0.5], [0.5, 3.0]])

    rotated, eigenvalues = rotate_subcontrasts(contrast, cov_beta)

    assert rotated.shape == (1, 2)
    assert round(eigenvalues[0], 4) == 4.0
    assert np.allclose(rotated[0], contrast[0])


def test_md_denom_df_matches_1d_case_for_single_component():
    denom_df = md_denom_df(np.array([6.9869]))

    assert round(denom_df, 4) == 6.9869


def test_md_denom_df_returns_mean_for_effectively_equal_components():
    denom_df = md_denom_df(np.array([6.0, 6.0 + 1e-10]))

    assert denom_df == pytest.approx(6.00000000005)


def test_md_denom_df_returns_two_when_any_component_hits_boundary():
    denom_df = md_denom_df(np.array([6.0, 2.0]))

    assert denom_df == 2.0


def test_satterthwaite_df_md_returns_rank_two_surface():
    contrast = np.eye(2)
    cov_beta = np.array([[2.0, 0.0], [0.0, 3.0]])
    jacobian = np.array(
        [
            [[1.0, 0.0], [0.0, 0.0]],
            [[0.0, 0.0], [0.0, 1.0]],
        ]
    )
    theta_cov = np.array([[1.0, 0.0], [0.0, 2.0]])

    num_df, den_df = satterthwaite_df_md(contrast, cov_beta, jacobian, theta_cov)

    assert num_df == 2
    assert round(den_df, 4) == 8.4615


def test_infer_md_from_df_uses_f_distribution():
    statistic, p_value = infer_md_from_df(quadratic_form=12.0, num_df=2, den_df=10.0)

    assert statistic == 6.0
    assert round(p_value, 6) == 0.019404


def test_normalize_term_name_removes_contrast_encoding():
    assert normalize_term_name("C(A, Treatment):C(B, Sum)") == "A:B"


def test_type3_correction_matrix_matches_known_2x2_example():
    df = pd.DataFrame({"A": ["a1", "a1", "a2", "a2"], "B": ["b1", "b2", "b1", "b2"]})
    xt = dmatrix("1 + C(A, Treatment) * C(B, Treatment)", df, return_type="dataframe").to_numpy()
    xc = dmatrix("1 + C(A, Sum) * C(B, Sum)", df, return_type="dataframe").to_numpy()

    correction = type3_correction_matrix(xt, xc)

    assert np.allclose(
        correction,
        np.array(
            [
                [1.0, 0.5, 0.5, 0.25],
                [0.0, -0.5, 0.0, -0.25],
                [0.0, 0.0, -0.5, -0.25],
                [0.0, 0.0, 0.0, 0.25],
            ]
        ),
    )


def test_build_type3_contrasts_from_formulas_returns_single_factor_term():
    df = pd.DataFrame({"A": ["a1", "a1", "a2", "a2"]})

    contrasts = build_type3_contrasts_from_formulas(
        df,
        "1 + C(A, Treatment)",
        "1 + C(A, Sum)",
    )

    assert list(contrasts.keys()) == ["A"]
    assert np.allclose(contrasts["A"], np.array([[0.0, -0.5]]))


def test_build_type3_contrasts_from_formulas_returns_interaction_term():
    df = pd.DataFrame({"A": ["a1", "a1", "a2", "a2"], "B": ["b1", "b2", "b1", "b2"]})

    contrasts = build_type3_contrasts_from_formulas(
        df,
        "1 + C(A, Treatment) * C(B, Treatment)",
        "1 + C(A, Sum) * C(B, Sum)",
    )

    assert set(contrasts.keys()) == {"A", "B", "A:B"}
    assert np.allclose(contrasts["A:B"], np.array([[0.0, 0.0, 0.0, 0.25]]))


def test_build_type3_contrasts_from_formulas_uses_sum_preliminary_when_coding_matches():
    df = pd.DataFrame({"A": ["a1", "a1", "a2", "a2"], "B": ["b1", "b2", "b1", "b2"]})

    contrasts = build_type3_contrasts_from_formulas(
        df,
        "1 + C(A, Sum) * C(B, Sum)",
        "1 + C(A, Sum) * C(B, Sum)",
    )

    assert np.allclose(contrasts["A"], np.array([[0.0, 1.0, 0.0, 0.0]]))
    assert np.allclose(contrasts["B"], np.array([[0.0, 0.0, 1.0, 0.0]]))
    assert np.allclose(contrasts["A:B"], np.array([[0.0, 0.0, 0.0, 1.0]]))


def test_build_type3_contrasts_rank_deficient_design_preserves_fitted_column_alignment():
    df = pd.DataFrame({"A": ["a1", "a1", "a2"], "B": ["b1", "b2", "b1"]})
    xt = dmatrix("1 + C(A, Treatment) * C(B, Treatment)", df, return_type="dataframe")
    xc = dmatrix("1 + C(A, Sum) * C(B, Sum)", df, return_type="dataframe")

    contrasts = build_type3_contrasts_from_formulas(
        df,
        "1 + C(A, Treatment) * C(B, Treatment)",
        "1 + C(A, Sum) * C(B, Sum)",
    )

    assert np.linalg.matrix_rank(xt.to_numpy()) < xt.shape[1]
    assert np.linalg.matrix_rank(xc.to_numpy()) < xc.shape[1]
    assert set(contrasts.keys()) == {"A", "B", "A:B"}
    assert all(matrix.shape[1] == xt.shape[1] for matrix in contrasts.values())
    assert np.all(np.isfinite(contrasts["A:B"]))


def test_type3_correction_matrix_rejects_mismatched_row_counts():
    xt = np.ones((4, 2))
    xc = np.ones((3, 2))

    with pytest.raises(ValueError, match="same number of rows"):
        type3_correction_matrix(xt, xc)


def test_finite_difference_step_sizes_scale_with_theta_magnitude():
    theta = np.array([100.0, 0.0])

    steps = finite_difference_step_sizes(theta, rel_step=1e-4, abs_step=1e-6)

    assert np.allclose(steps, np.array([0.01, 1e-6]))


def test_numerical_cov_beta_jacobian_returns_symmetric_random_intercept_derivatives():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)

    jacobian = numerical_cov_beta_jacobian(fit, spec.theta)

    assert jacobian.shape == (len(spec.names), fit.model.k_fe, fit.model.k_fe)
    assert np.all(np.isfinite(jacobian))
    assert np.allclose(jacobian[0], jacobian[0].T)


def test_numerical_cov_beta_jacobian_supports_phase1a_varpar_surface():
    fit = _fit_random_intercept_model()
    spec = extract_finite_df_varpar_spec(fit)

    jacobian = numerical_cov_beta_jacobian(
        fit,
        spec.theta,
        evaluator=cov_beta_from_finite_df_varpar,
    )

    assert jacobian.shape == (2, fit.model.k_fe, fit.model.k_fe)
    assert np.all(np.isfinite(jacobian))
    assert np.allclose(jacobian[0], jacobian[0].T)
    assert np.allclose(jacobian[1], jacobian[1].T)


def test_extract_finite_df_varpar_spec_supports_one_random_slope():
    fit = _fit_random_slope_model()

    spec = extract_finite_df_varpar_spec(fit)

    assert spec.theta.shape == (fit.model.k_re2 + 1,)
    assert spec.covariance.shape == (fit.model.k_re2 + 1, fit.model.k_re2 + 1)
    assert spec.names[-1] == "Sigma"
    assert spec.theta[-1] == pytest.approx(float(np.sqrt(fit.scale)))
    assert np.all(np.isfinite(spec.covariance))


def test_cov_beta_from_finite_df_varpar_reproduces_fitted_covariance_for_one_random_slope():
    fit = _fit_random_slope_model()
    spec = extract_finite_df_varpar_spec(fit)

    cov_beta = cov_beta_from_finite_df_varpar(fit, spec.theta)
    fitted_cov = np.asarray(fit.cov_params().iloc[: fit.model.k_fe, : fit.model.k_fe], dtype=float)

    assert cov_beta.shape == fitted_cov.shape
    assert np.allclose(cov_beta, fitted_cov, rtol=1e-5, atol=1e-7)


def test_numerical_cov_beta_jacobian_supports_one_random_slope_varpar_surface():
    fit = _fit_random_slope_model()
    spec = extract_finite_df_varpar_spec(fit)

    jacobian = numerical_cov_beta_jacobian(
        fit,
        spec.theta,
        evaluator=cov_beta_from_finite_df_varpar,
    )

    assert jacobian.shape == (fit.model.k_re2 + 1, fit.model.k_fe, fit.model.k_fe)
    assert np.all(np.isfinite(jacobian))
    assert all(np.allclose(component, component.T) for component in jacobian)


def test_numerical_cov_beta_jacobian_is_stable_across_step_sizes():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)

    coarse = numerical_cov_beta_jacobian(fit, spec.theta, rel_step=1e-4, abs_step=1e-6)
    fine = numerical_cov_beta_jacobian(fit, spec.theta, rel_step=5e-5, abs_step=5e-7)

    assert np.allclose(coarse, fine, atol=1e-6, rtol=5e-2)


def test_numerical_cov_beta_jacobian_contract_shape_matches_theta_order():
    fit = _fit_random_intercept_model()
    spec = extract_packed_theta_spec(fit)
    jacobian = numerical_cov_beta_jacobian(fit, spec.theta)
    contrast = np.array([1.0, -1.0])

    gradient = contract_cov_jacobian(contrast, jacobian)

    assert gradient.shape == spec.theta.shape
    assert np.all(np.isfinite(gradient))


def test_numerical_cov_beta_jacobian_uses_one_sided_fallback_when_one_side_is_invalid(monkeypatch):
    def fake_cov_beta(_fit, theta):
        value = float(theta[0])
        if value > 1.0:
            raise ValueError("upper boundary")
        if value < 0.0:
            raise ValueError("lower boundary")
        return np.array([[value, 0.0], [0.0, value]])

    monkeypatch.setattr(sat_module, "cov_beta_from_packed_theta", fake_cov_beta)

    jacobian = numerical_cov_beta_jacobian(fit=None, theta=np.array([1.0]), rel_step=0.1, abs_step=0.1)

    assert jacobian.shape == (1, 2, 2)
    assert np.allclose(jacobian[0], np.eye(2))


def test_numerical_cov_beta_jacobian_errors_when_neither_side_is_valid(monkeypatch):
    def fake_cov_beta(_fit, theta):
        value = float(theta[0])
        if value != 0.0:
            raise ValueError("outside valid window")
        return np.eye(2)

    monkeypatch.setattr(sat_module, "cov_beta_from_packed_theta", fake_cov_beta)

    with pytest.raises(ValueError, match="Unable to evaluate"):
        numerical_cov_beta_jacobian(fit=None, theta=np.array([0.0]), rel_step=0.1, abs_step=0.1)
