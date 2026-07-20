from __future__ import annotations

import re
from collections import OrderedDict

import numpy as np
from patsy import dmatrix


def normalize_term_name(term_name: str) -> str:
    normalized = re.sub(r"C\(([^,()]+),\s*[^()]+\)", r"\1", str(term_name))
    return normalized.replace(" ", "")


def preliminary_type3_contrasts(design_info) -> OrderedDict[str, np.ndarray]:
    identity = np.eye(len(design_info.column_names))
    contrasts: OrderedDict[str, np.ndarray] = OrderedDict()
    for term_name, term_slice in design_info.term_name_slices.items():
        if term_name == "Intercept":
            continue
        block = identity[term_slice]
        if block.size == 0:
            continue
        contrasts[normalize_term_name(term_name)] = block
    return contrasts


def type3_correction_matrix(x_t: np.ndarray, x_c: np.ndarray) -> np.ndarray:
    xt = np.asarray(x_t, dtype=float)
    xc = np.asarray(x_c, dtype=float)
    if xt.ndim != 2 or xc.ndim != 2:
        raise ValueError("Type III design matrices must be two-dimensional")
    if xt.shape[0] != xc.shape[0]:
        raise ValueError("Type III design matrices must have the same number of rows")
    return np.linalg.pinv(xc.T @ xc) @ xc.T @ xt


def build_type3_contrasts_from_matrices(
    x_t,
    design_info_t,
    x_c,
    design_info_c,
    tol: float = 1e-10,
) -> OrderedDict[str, np.ndarray]:
    xt = np.asarray(x_t, dtype=float)
    xc = np.asarray(x_c, dtype=float)
    if xt.ndim != 2 or xc.ndim != 2:
        raise ValueError("Type III design matrices must be two-dimensional")
    if xt.shape[0] != xc.shape[0]:
        raise ValueError("Type III design matrices must have the same number of rows")

    p_c = xc.shape[1]
    all_indices = np.arange(p_c, dtype=int)
    corrected: OrderedDict[str, np.ndarray] = OrderedDict()
    for raw_term_name, term_slice in design_info_c.term_name_slices.items():
        if raw_term_name == "Intercept":
            continue

        term_indices = np.arange(term_slice.start, term_slice.stop, dtype=int)
        if term_indices.size == 0:
            continue

        other_indices = all_indices[~np.isin(all_indices, term_indices)]
        x_term = xc[:, term_indices]
        x_term_original = x_term.copy()
        x_other = xc[:, other_indices]

        if x_other.size:
            q_other, r_other = np.linalg.qr(x_other, mode="reduced")
            if r_other.size:
                keep_other = np.abs(np.diag(r_other)) > tol
                q_other = q_other[:, keep_other]
            if q_other.size:
                x_term = x_term - q_other @ (q_other.T @ x_term)

        q_term, r_term = np.linalg.qr(x_term, mode="reduced")
        if r_term.size == 0:
            continue
        keep_term = np.abs(np.diag(r_term)) > tol
        if not np.any(keep_term):
            # Rank-deficient edge case: preserve a term-aligned basis so downstream
            # callers keep contrast bookkeeping instead of dropping the term entirely.
            q_term, r_term = np.linalg.qr(x_term_original, mode="reduced")
            if r_term.size == 0:
                continue
            keep_term = np.abs(np.diag(r_term)) > tol
            if not np.any(keep_term):
                continue
        q_term = q_term[:, keep_term]

        # Map the residualized term subspace into fitted-coefficient space.
        contrast = np.asarray(q_term.T @ xt, dtype=float)
        if contrast.shape[1] != xt.shape[1]:
            raise ValueError("Corrected Type III contrast columns must align with the fitted design matrix")

        # Keep an orthonormal basis for the contrast row space for numerical stability.
        _u, singular_values, vh = np.linalg.svd(contrast, full_matrices=False)
        rank = int(np.sum(singular_values > tol))
        if rank == 0:
            continue
        contrast_basis = np.asarray(vh[:rank, :], dtype=float)
        contrast_basis[np.abs(contrast_basis) < tol] = 0.0

        corrected[normalize_term_name(raw_term_name)] = contrast_basis
    return corrected


def build_type3_contrasts_from_formulas(
    data,
    formula_t: str,
    formula_c: str,
    tol: float = 1e-10,
) -> OrderedDict[str, np.ndarray]:
    x_t = dmatrix(formula_t, data, return_type="dataframe")
    x_c = dmatrix(formula_c, data, return_type="dataframe")
    return build_type3_contrasts_from_matrices(x_t.to_numpy(), x_t.design_info, x_c.to_numpy(), x_c.design_info, tol=tol)
