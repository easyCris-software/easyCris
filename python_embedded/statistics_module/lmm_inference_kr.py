from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import stats

from .lmm_parameterization import finite_df_negloglike_from_varpar


@dataclass(frozen=True)
class KrInferenceBundle:
    fit: Any
    fe_params: np.ndarray
    cov_beta: np.ndarray
    cov_beta_unadjusted: np.ndarray
    theta_cov: np.ndarray
    p_matrices: list[np.ndarray]
    reml_refit: bool


def _natural_step_sizes(theta: np.ndarray, rel_step: float = 1e-4, abs_step: float = 1e-6) -> np.ndarray:
    values = np.asarray(theta, dtype=float)
    steps = np.maximum(np.abs(values) * rel_step, abs_step)
    positive = values > 0
    steps[positive] = np.minimum(steps[positive], np.maximum(values[positive] * 0.25, np.finfo(float).eps))
    return steps


def _numerical_hessian(func, theta: np.ndarray) -> np.ndarray:
    values = np.asarray(theta, dtype=float)
    steps = _natural_step_sizes(values)
    base = float(func(values))
    hessian = np.zeros((values.size, values.size), dtype=float)
    for i, step_i in enumerate(steps):
        plus_i = values.copy()
        minus_i = values.copy()
        plus_i[i] += step_i
        minus_i[i] -= step_i
        f_plus = float(func(plus_i))
        f_minus = float(func(minus_i))
        hessian[i, i] = (f_plus - (2.0 * base) + f_minus) / (step_i * step_i)
        for j in range(i + 1, values.size):
            step_j = steps[j]
            pp = values.copy()
            pm = values.copy()
            mp = values.copy()
            mm = values.copy()
            pp[i] += step_i
            pp[j] += step_j
            pm[i] += step_i
            pm[j] -= step_j
            mp[i] -= step_i
            mp[j] += step_j
            mm[i] -= step_i
            mm[j] -= step_j
            mixed = (
                float(func(pp))
                - float(func(pm))
                - float(func(mp))
                + float(func(mm))
            ) / (4.0 * step_i * step_j)
            hessian[i, j] = mixed
            hessian[j, i] = mixed
    return 0.5 * (hessian + hessian.T)


def _require_random_intercept_only(fit) -> None:
    if int(getattr(fit.model, "k_re", 0)) != 1 or int(getattr(fit.model, "k_vc", 0)) != 0:
        raise ValueError("Kenward-Roger currently supports only random-intercept models.")


def _natural_varpar_from_fit(fit) -> np.ndarray:
    tau2 = float(np.asarray(fit.cov_re, dtype=float)[0, 0])
    sigma2 = float(fit.scale)
    if not np.isfinite(tau2) or tau2 <= 0:
        raise ValueError("Kenward-Roger requires a positive random-intercept variance.")
    if not np.isfinite(sigma2) or sigma2 <= 0:
        raise ValueError("Kenward-Roger requires a positive residual variance.")
    return np.array([tau2, sigma2], dtype=float)


def _natural_negloglike(fit, natural_varpar: np.ndarray) -> float:
    tau2, sigma2 = np.asarray(natural_varpar, dtype=float)
    if tau2 <= 0 or sigma2 <= 0 or not np.isfinite(tau2) or not np.isfinite(sigma2):
        raise ValueError("Kenward-Roger natural variance parameters must be positive and finite.")
    profile_theta = tau2 / sigma2
    sigma = math.sqrt(sigma2)
    return finite_df_negloglike_from_varpar(fit, np.array([profile_theta, sigma], dtype=float))


def _group_sigma_components(fit, tau2: float, sigma2: float):
    x_groups = fit.model.exog_li
    components = []
    for exog in x_groups:
        n_i = exog.shape[0]
        eye = np.eye(n_i, dtype=float)
        ones = np.ones((n_i, n_i), dtype=float)
        sigma = (tau2 * ones) + (sigma2 * eye)
        sigma_inv = np.linalg.inv(sigma)
        components.append((np.asarray(exog, dtype=float), sigma, sigma_inv, ones, eye))
    return components


def _build_kr_components(fit, phi: np.ndarray, theta_cov: np.ndarray):
    tau2, sigma2 = _natural_varpar_from_fit(fit)
    p = phi.shape[0]
    p_list = [np.zeros((p, p), dtype=float) for _ in range(2)]
    q_mats = [[np.zeros((p, p), dtype=float) for _ in range(2)] for _ in range(2)]
    r_mats = [[np.zeros((p, p), dtype=float) for _ in range(2)] for _ in range(2)]
    k_trace = np.zeros((2, 2), dtype=float)

    for exog, sigma, sigma_inv, d_tau, d_sigma in _group_sigma_components(fit, tau2, sigma2):
        derivs = [d_tau, d_sigma]
        sigma_inv_d1 = [-(sigma_inv @ deriv @ sigma_inv) for deriv in derivs]
        for i in range(2):
            p_list[i] += exog.T @ sigma_inv_d1[i] @ exog
            h_i = derivs[i] @ sigma_inv
            for j in range(2):
                q_mats[i][j] += exog.T @ sigma_inv_d1[i] @ sigma @ sigma_inv_d1[j] @ exog
                h_j = derivs[j] @ sigma_inv
                k_trace[i, j] += float(np.trace(h_i @ h_j))

    ie2 = np.zeros((2, 2), dtype=float)
    for i in range(2):
        for j in range(2):
            ie2[i, j] = (
                k_trace[i, j]
                - 2.0 * float(np.trace(phi @ q_mats[i][j]))
                + float(np.trace(phi @ p_list[i] @ phi @ p_list[j]))
            )
    w = 2.0 * np.linalg.inv(ie2)

    u = np.zeros_like(phi)
    for i in range(2):
        for j in range(2):
            u += w[i, j] * (q_mats[i][j] - (p_list[i] @ phi @ p_list[j]) - (0.25 * r_mats[i][j]))
    phi_adj = phi + (2.0 * phi @ u @ phi)
    phi_adj = 0.5 * (phi_adj + phi_adj.T)
    return p_list, w, phi_adj


def build_kr_inference_bundle(fit, reml_refit: bool = False) -> KrInferenceBundle:
    _require_random_intercept_only(fit)
    fe_names = list(fit.fe_params.index)
    fe_params = np.asarray(fit.fe_params, dtype=float)
    cov_df = fit.cov_params()
    cov_beta = np.asarray(cov_df.loc[fe_names, fe_names], dtype=float)
    natural_varpar = _natural_varpar_from_fit(fit)
    hessian = _numerical_hessian(lambda values: _natural_negloglike(fit, values), natural_varpar)
    theta_cov = np.linalg.inv(hessian)
    p_list, w, cov_beta_adj = _build_kr_components(fit, cov_beta, theta_cov)
    return KrInferenceBundle(
        fit=fit,
        fe_params=fe_params,
        cov_beta=cov_beta_adj,
        cov_beta_unadjusted=cov_beta,
        theta_cov=w,
        p_matrices=p_list,
        reml_refit=reml_refit,
    )


def _kr_df_components(contrast: np.ndarray, cov_beta: np.ndarray, theta_cov: np.ndarray, p_list: list[np.ndarray]):
    l = np.atleast_2d(np.asarray(contrast, dtype=float))
    slvol = np.linalg.solve(l @ cov_beta @ l.T, l)
    m_mat = l.T @ slvol
    q = l.shape[0]
    mv0 = m_mat @ cov_beta
    mv0pv0 = [mv0 @ p_matrix @ cov_beta for p_matrix in p_list]
    a1 = 0.0
    a2 = 0.0
    for i in range(len(p_list)):
        for j in range(len(p_list)):
            a1 += theta_cov[i, j] * float(np.trace(mv0pv0[i])) * float(np.trace(mv0pv0[j]))
            a2 += theta_cov[i, j] * float(np.trace(mv0pv0[i] @ mv0pv0[j]))
    if abs(a2) < 1e-12:
        return float("inf"), 1.0
    b = (a1 + (6.0 * a2)) / (2.0 * q)
    e_star = 1.0 / (1.0 - (a2 / q))
    g = (((q + 1.0) * a1) - ((q + 4.0) * a2)) / ((q + 2.0) * a2)
    denom = (3.0 * q) + 2.0 - (2.0 * g)
    c1 = g / denom
    c2 = (q - g) / denom
    c3 = (q + 2.0 - g) / denom
    v_star = (2.0 / q) * (1.0 + (c1 * b)) / (((1.0 - (c2 * b)) ** 2) * (1.0 - (c3 * b)))
    rho = v_star / (2.0 * (e_star**2))
    m = 4.0 + ((q + 2.0) / ((q * rho) - 1.0))
    lambda_ = m / (e_star * (m - 2.0))
    return float(m), float(lambda_)


def infer_kr_1d(bundle: KrInferenceBundle, contrast: np.ndarray, estimate: float) -> tuple[float, float, float, float]:
    contrast_vec = np.asarray(contrast, dtype=float).reshape(-1)
    variance = float(contrast_vec @ bundle.cov_beta @ contrast_vec.T)
    variance = max(variance, 0.0)
    se = float(math.sqrt(variance))
    if se <= 0:
        return 0.0, 0.0, float("inf"), 1.0
    df, _lambda = _kr_df_components(contrast_vec, bundle.cov_beta_unadjusted, bundle.theta_cov, bundle.p_matrices)
    statistic = float(estimate / se)
    if np.isfinite(df):
        p_value = float(2.0 * stats.t.sf(abs(statistic), df))
    else:
        p_value = float(2.0 * stats.norm.sf(abs(statistic)))
    return se, statistic, df, p_value


def infer_kr_md(
    bundle: KrInferenceBundle,
    contrast_matrix: np.ndarray,
    projected: np.ndarray,
) -> tuple[float, int, float, float]:
    l_matrix = np.atleast_2d(np.asarray(contrast_matrix, dtype=float))
    q = int(l_matrix.shape[0])
    if q <= 0:
        raise ValueError("Kenward-Roger omnibus inference requires a non-empty contrast matrix.")
    den_df, lambda_ = _kr_df_components(
        l_matrix,
        bundle.cov_beta_unadjusted,
        bundle.theta_cov,
        bundle.p_matrices,
    )
    middle = l_matrix @ bundle.cov_beta @ l_matrix.T
    quadratic = float(np.asarray(projected, dtype=float).T @ np.linalg.pinv(middle) @ np.asarray(projected, dtype=float))
    f_wald = quadratic / q
    f_value = float(lambda_ * f_wald)
    if np.isfinite(den_df):
        p_value = float(stats.f.sf(f_value, q, den_df))
    else:
        p_value = float(stats.chi2.sf(quadratic, q))
    return f_value, q, den_df, p_value
