from __future__ import annotations

import numpy as np

from .lmm_parameterization import cov_beta_from_packed_theta


def finite_difference_step_sizes(theta: np.ndarray, rel_step: float = 1e-4, abs_step: float = 1e-6) -> np.ndarray:
    packed = np.asarray(theta, dtype=float)
    return np.maximum(np.abs(packed) * rel_step, abs_step)


def _near_zero_cholesky_diagonal_indices(fit, theta: np.ndarray, evaluator) -> set[int]:
    if evaluator is None or evaluator is cov_beta_from_packed_theta:
        return set()
    k_re = int(getattr(fit.model, "k_re", 0))
    if k_re == 1 and len(theta) >= 1:
        return {0}
    if k_re == 2 and len(theta) >= 3:
        return {0, 2}
    return set()


def numerical_cov_beta_jacobian(
    fit,
    theta: np.ndarray,
    rel_step: float = 1e-4,
    abs_step: float = 1e-6,
    evaluator=None,
) -> np.ndarray:
    packed = np.asarray(theta, dtype=float)
    cov_beta_evaluator = cov_beta_from_packed_theta if evaluator is None else evaluator
    base = cov_beta_evaluator(fit, packed)
    steps = finite_difference_step_sizes(packed, rel_step=rel_step, abs_step=abs_step)
    jacobian = np.zeros((packed.size, *base.shape), dtype=float)
    one_sided_positive = _near_zero_cholesky_diagonal_indices(fit, packed, evaluator)

    for index, step in enumerate(steps):
        plus_theta = packed.copy()
        minus_theta = packed.copy()
        plus_theta[index] += step
        minus_theta[index] -= step

        plus_cov = None
        minus_cov = None
        plus_ok = False
        minus_ok = False
        try:
            plus_cov = cov_beta_evaluator(fit, plus_theta)
            plus_ok = True
        except ValueError:
            plus_ok = False
        try:
            minus_cov = cov_beta_evaluator(fit, minus_theta)
            minus_ok = True
        except ValueError:
            minus_ok = False

        if index in one_sided_positive and abs(float(packed[index])) <= (10.0 * step) and plus_ok:
            deriv = (plus_cov - base) / step
        elif plus_ok and minus_ok:
            deriv = (plus_cov - minus_cov) / (2.0 * step)
        elif plus_ok:
            deriv = (plus_cov - base) / step
        elif minus_ok:
            deriv = (base - minus_cov) / step
        else:
            raise ValueError(f"Unable to evaluate a finite-difference perturbation for theta index {index}")

        jacobian[index] = 0.5 * (deriv + deriv.T)

    return jacobian
