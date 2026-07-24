from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from statsmodels.regression.mixed_linear_model import MixedLMParams, _smw_logdet, _smw_solver


@dataclass(frozen=True)
class PackedThetaSpec:
    names: list[str]
    theta: np.ndarray
    covariance: np.ndarray
    index: dict[str, int]


def extract_packed_theta_spec(fit) -> PackedThetaSpec:
    k_fe = int(fit.model.k_fe)
    names = [str(name) for name in fit.params.index[k_fe:]]
    theta = np.asarray(fit.params.iloc[k_fe:], dtype=float)
    covariance = np.asarray(fit.cov_params().iloc[k_fe:, k_fe:], dtype=float)
    index = {name: position for position, name in enumerate(names)}
    return PackedThetaSpec(names=names, theta=theta, covariance=covariance, index=index)


def update_packed_theta(spec: PackedThetaSpec, **updates: float) -> np.ndarray:
    theta = np.array(spec.theta, dtype=float, copy=True)
    for name, value in updates.items():
        theta[spec.index[name]] = float(value)
    return theta


def _phase1a_step_sizes(theta: np.ndarray, rel_step: float = 1e-4, abs_step: float = 1e-4) -> np.ndarray:
    values = np.asarray(theta, dtype=float)
    steps = np.maximum(np.abs(values) * rel_step, abs_step)
    positive = values > 0
    steps[positive] = np.minimum(steps[positive], np.maximum(values[positive] * 0.25, np.finfo(float).eps))
    return steps


def _numerical_hessian(func, theta: np.ndarray) -> np.ndarray:
    values = np.asarray(theta, dtype=float)
    steps = _phase1a_step_sizes(values)
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


def _stable_relative_cholesky(cov_re_unscaled: np.ndarray) -> np.ndarray:
    matrix = 0.5 * (np.asarray(cov_re_unscaled, dtype=float) + np.asarray(cov_re_unscaled, dtype=float).T)
    try:
        return np.linalg.cholesky(matrix)
    except np.linalg.LinAlgError:
        size = int(matrix.shape[0])
        scale = max(float(np.trace(matrix)) / max(size, 1), float(np.max(np.abs(np.diag(matrix)))), 1.0)
        ridge = scale * 1e-10
        eye = np.eye(size, dtype=float)
        for _ in range(8):
            try:
                return np.linalg.cholesky(matrix + ridge * eye)
            except np.linalg.LinAlgError:
                ridge *= 10.0
        raise


def _stable_inverse_hessian(hessian: np.ndarray, rcond: float = 1e-10) -> np.ndarray:
    matrix = 0.5 * (np.asarray(hessian, dtype=float) + np.asarray(hessian, dtype=float).T)
    eigvals, eigvecs = np.linalg.eigh(matrix)
    scale = max(float(np.max(np.abs(eigvals))), 1.0)
    floor = scale * rcond
    clipped = np.maximum(eigvals, floor)
    inverse = eigvecs @ np.diag(1.0 / clipped) @ eigvecs.T
    return 0.5 * (inverse + inverse.T)


def _phase1a_unpack_varpar(fit, varpar: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    values = np.asarray(varpar, dtype=float)
    expected = int(fit.model.k_re2 + fit.model.k_vc + 1)
    if values.ndim != 1 or values.shape[0] != expected or np.any(~np.isfinite(values)):
        raise ValueError("phase1a varpar must be a finite one-dimensional vector with theta and sigma")
    sigma = float(values[-1])
    if sigma <= 0:
        raise ValueError("phase1a varpar requires a positive sigma")
    theta = values[:-1]
    if int(fit.model.k_vc) != 0:
        raise ValueError("phase1a varpar bridge does not support variance components")

    if int(fit.model.k_re) == 1:
        l11 = float(theta[0])
        cov_re_unscaled = np.array([[l11 * l11]], dtype=float)
    elif int(fit.model.k_re) == 2:
        l11 = float(theta[0])
        l21 = float(theta[1])
        l22 = float(theta[2])
        lower = np.array([[l11, 0.0], [l21, l22]], dtype=float)
        cov_re_unscaled = lower @ lower.T
    else:
        raise ValueError("phase1a varpar bridge only supports one random intercept or one random slope")

    return cov_re_unscaled, np.empty(0, dtype=float), sigma


def finite_df_negloglike_from_varpar(fit, varpar: np.ndarray) -> float:
    cov_re_unscaled, vcomp_unscaled, sigma = _phase1a_unpack_varpar(fit, varpar)
    fe_params, singular = fit.model.get_fe_params(cov_re_unscaled, vcomp_unscaled)
    scale = sigma * sigma

    if fit.model.k_re == 0:
        cov_re_inv = np.empty((0, 0))
        cov_re_logdet = 0.0
    else:
        cov_re_inv = np.linalg.pinv(cov_re_unscaled)
        _, cov_re_logdet = np.linalg.slogdet(cov_re_unscaled)

    logdet = 0.0
    qf = 0.0
    xvx = np.zeros((fit.model.k_fe, fit.model.k_fe), dtype=float)
    resid_all = fit.model.endog - np.dot(fit.model.exog, fe_params)

    for group_ix, group in enumerate(fit.model.group_labels):
        vc_var = fit.model._expand_vcomp(vcomp_unscaled, group_ix)
        vc_vari = np.zeros_like(vc_var) if vc_var.size else np.empty(0)
        positive = vc_var > 1e-10
        vc_vari[positive] = 1.0 / vc_var[positive]
        exog = fit.model.exog_li[group_ix]
        ex_r, ex2_r = fit.model._aex_r[group_ix], fit.model._aex_r2[group_ix]
        solver = _smw_solver(1.0, ex_r, ex2_r, cov_re_inv, vc_vari)
        cov_aug_logdet = cov_re_logdet + (float(np.sum(np.log(vc_var))) if vc_var.size else 0.0)
        logdet += _smw_logdet(1.0, ex_r, ex2_r, cov_re_inv, vc_vari, cov_aug_logdet)
        resid = resid_all[fit.model.row_indices[group]]
        solved = solver(resid)
        qf += float(np.dot(resid, solved))
        if fit.model.reml:
            xvx += exog.T @ solver(exog)

    if fit.model.reml:
        dof = fit.model.n_totobs - fit.model.k_fe
        _, xvx_logdet = np.linalg.slogdet(xvx)
        return float(0.5 * ((dof * np.log(2.0 * np.pi * scale)) + logdet + xvx_logdet + (qf / scale)))
    return float(0.5 * ((fit.model.n_totobs * np.log(2.0 * np.pi * scale)) + logdet + (qf / scale)))


def extract_finite_df_varpar_spec(fit) -> PackedThetaSpec:
    if int(fit.model.k_re) not in {1, 2} or int(fit.model.k_vc) != 0:
        raise ValueError(
            "Phase 1 varpar bridge only supports random-intercept models or one random slope without variance components"
        )

    cov_re_unscaled = np.asarray(fit.cov_re, dtype=float) / float(fit.scale)
    chol = _stable_relative_cholesky(cov_re_unscaled)
    theta_re = chol[np.tril_indices(int(fit.model.k_re))]
    theta = np.concatenate(
        [
            np.asarray(theta_re, dtype=float),
            np.array([float(np.sqrt(fit.scale))], dtype=float),
        ]
    )
    hessian = _numerical_hessian(lambda values: finite_df_negloglike_from_varpar(fit, values), theta)
    covariance = _stable_inverse_hessian(hessian) if int(fit.model.k_re) == 2 else np.linalg.inv(hessian)
    if theta.size == 2:
        names = ["theta_cholesky", "Sigma"]
    else:
        names = ["theta_cholesky::L11", "theta_cholesky::L21", "theta_cholesky::L22", "Sigma"]
    index = {name: position for position, name in enumerate(names)}
    return PackedThetaSpec(names=names, theta=theta, covariance=covariance, index=index)


def cov_beta_from_finite_df_varpar(fit, varpar: np.ndarray) -> np.ndarray:
    cov_re_unscaled, vcomp_unscaled, sigma = _phase1a_unpack_varpar(fit, varpar)
    fe_params, singular = fit.model.get_fe_params(cov_re_unscaled, vcomp_unscaled)
    scale = sigma * sigma

    if fit.model.k_re == 0:
        cov_re_inv = np.empty((0, 0))
    else:
        cov_re_inv = np.linalg.pinv(cov_re_unscaled)

    xtvix = np.zeros((fit.model.k_fe, fit.model.k_fe), dtype=float)
    for group_ix, _group in enumerate(fit.model.group_labels):
        vc_var = fit.model._expand_vcomp(vcomp_unscaled, group_ix)
        vc_vari = np.zeros_like(vc_var) if vc_var.size else np.empty(0)
        positive = vc_var > 1e-10
        vc_vari[positive] = 1.0 / vc_var[positive]
        solver = _smw_solver(
            1.0,
            fit.model._aex_r[group_ix],
            fit.model._aex_r2[group_ix],
            cov_re_inv,
            vc_vari,
        )
        exog = fit.model.exog_li[group_ix]
        xtvix += exog.T @ solver(exog)

    inv = np.linalg.pinv(xtvix) if singular else np.linalg.inv(xtvix)
    return np.asarray(inv * scale, dtype=float)


def cov_beta_from_packed_theta(fit, theta: np.ndarray) -> np.ndarray:
    packed_theta = np.asarray(theta, dtype=float)
    if packed_theta.ndim != 1 or np.any(~np.isfinite(packed_theta)):
        raise ValueError("packed theta must be a finite one-dimensional vector")

    params = MixedLMParams.from_packed(
        packed_theta,
        fit.model.k_fe,
        fit.model.k_re,
        use_sqrt=False,
        has_fe=False,
    )
    cov_re_unscaled = params.cov_re
    vcomp_unscaled = params.vcomp
    if cov_re_unscaled.size:
        eigvals = np.linalg.eigvalsh(cov_re_unscaled)
        if np.min(eigvals) <= 0:
            raise ValueError("packed theta produced a non-positive-definite random-effects covariance")
    if vcomp_unscaled.size and np.any(vcomp_unscaled <= 0):
        raise ValueError("packed theta produced non-positive variance components")

    fe_params, singular = fit.model.get_fe_params(cov_re_unscaled, vcomp_unscaled)
    scale = fit.model.get_scale(fe_params, cov_re_unscaled, vcomp_unscaled)
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("packed theta produced a non-positive residual scale")

    if fit.model.k_re == 0:
        cov_re_inv = np.empty((0, 0))
    else:
        cov_re_inv = np.linalg.pinv(cov_re_unscaled)

    xtvix = np.zeros((fit.model.k_fe, fit.model.k_fe), dtype=float)
    for group_ix, _group in enumerate(fit.model.group_labels):
        vc_var = fit.model._expand_vcomp(vcomp_unscaled, group_ix)
        vc_vari = np.zeros_like(vc_var) if vc_var.size else np.empty(0)
        positive = vc_var > 1e-10
        vc_vari[positive] = 1.0 / vc_var[positive]
        solver = _smw_solver(
            1.0,
            fit.model._aex_r[group_ix],
            fit.model._aex_r2[group_ix],
            cov_re_inv,
            vc_vari,
        )
        exog = fit.model.exog_li[group_ix]
        xtvix += exog.T @ solver(exog)

    inv = np.linalg.pinv(xtvix) if singular else np.linalg.inv(xtvix)
    return np.asarray(inv * scale, dtype=float)
