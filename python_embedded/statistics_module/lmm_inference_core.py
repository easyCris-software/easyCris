from __future__ import annotations

import numpy as np
from scipy import stats


def quad_form_vec(vec: np.ndarray, mat: np.ndarray) -> float:
    vector = np.asarray(vec, dtype=float).reshape(-1)
    matrix = np.asarray(mat, dtype=float)
    return float(vector @ matrix @ vector)


def quad_form_mat(contrast: np.ndarray, cov: np.ndarray) -> np.ndarray:
    contrast_matrix = np.asarray(contrast, dtype=float)
    covariance = np.asarray(cov, dtype=float)
    return contrast_matrix @ covariance @ contrast_matrix.T


def effective_rank(mat: np.ndarray, tol: float = 1e-10) -> int:
    matrix = np.asarray(mat, dtype=float)
    if matrix.size == 0:
        return 0
    eigenvalues = np.linalg.eigvalsh(matrix)
    threshold = float(np.max(np.abs(eigenvalues))) * tol if eigenvalues.size else tol
    return int(np.count_nonzero(np.abs(eigenvalues) > threshold))


def contract_cov_jacobian(contrast: np.ndarray, jacobian: np.ndarray) -> np.ndarray:
    vector = np.asarray(contrast, dtype=float).reshape(-1)
    jac = np.asarray(jacobian, dtype=float)
    return np.asarray([quad_form_vec(vector, deriv) for deriv in jac], dtype=float)


def satterthwaite_df_1d(
    contrast: np.ndarray,
    cov_beta: np.ndarray,
    jacobian: np.ndarray,
    theta_cov: np.ndarray,
) -> float:
    variance = quad_form_vec(np.asarray(contrast, dtype=float), np.asarray(cov_beta, dtype=float))
    gradient = contract_cov_jacobian(contrast, jacobian)
    denom = quad_form_vec(gradient, np.asarray(theta_cov, dtype=float))
    if variance <= 0 or denom <= 0:
        return float("inf")
    return float((2.0 * variance * variance) / denom)


def infer_1d_from_df(estimate: float, standard_error: float, df: float) -> tuple[float, float]:
    statistic = float(estimate / standard_error)
    if not np.isfinite(df):
        p_value = float(2.0 * stats.norm.sf(abs(statistic)))
    else:
        p_value = float(2.0 * stats.t.sf(abs(statistic), df))
    return statistic, p_value


def rotate_subcontrasts(
    contrast: np.ndarray, cov_beta: np.ndarray, tol: float = 1e-10
) -> tuple[np.ndarray, np.ndarray]:
    l_matrix = np.asarray(contrast, dtype=float)
    lc_lt = quad_form_mat(l_matrix, np.asarray(cov_beta, dtype=float))
    eigenvalues, eigenvectors = np.linalg.eigh(lc_lt)
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]
    keep = eigenvalues > (float(np.max(np.abs(eigenvalues))) * tol if eigenvalues.size else tol)
    eigenvalues = eigenvalues[keep]
    eigenvectors = eigenvectors[:, keep]
    rotated = eigenvectors.T @ l_matrix
    return rotated, eigenvalues


def md_denom_df(component_dfs: np.ndarray) -> float:
    dfs = np.asarray(component_dfs, dtype=float)
    if dfs.size == 0:
        return float("inf")
    if dfs.size == 1:
        return float(dfs[0])
    if np.all(np.abs(np.diff(dfs)) < np.sqrt(np.finfo(float).eps)):
        return float(np.mean(dfs))
    if np.any(dfs <= 2):
        return 2.0
    if np.any(~np.isfinite(dfs)):
        return float("inf")
    expectation = float(np.sum(dfs / (dfs - 2.0)))
    q = float(dfs.size)
    if expectation <= q:
        return float("inf")
    return float((2.0 * expectation) / (expectation - q))


def satterthwaite_df_md(
    contrast: np.ndarray,
    cov_beta: np.ndarray,
    jacobian: np.ndarray,
    theta_cov: np.ndarray,
) -> tuple[int, float]:
    rotated, eigenvalues = rotate_subcontrasts(contrast, cov_beta)
    num_df = int(eigenvalues.size)
    if num_df == 0:
        return 0, float("inf")
    component_dfs = np.asarray(
        [satterthwaite_df_1d(row, cov_beta, jacobian, theta_cov) for row in rotated],
        dtype=float,
    )
    return num_df, md_denom_df(component_dfs)


def infer_md_from_df(quadratic_form: float, num_df: int, den_df: float) -> tuple[float, float]:
    statistic = float(quadratic_form / num_df)
    if not np.isfinite(den_df):
        p_value = float(stats.chi2.sf(quadratic_form, num_df))
    else:
        p_value = float(stats.f.sf(statistic, num_df, den_df))
    return statistic, p_value
