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
    correction = type3_correction_matrix(xt, xc)
    prelim = preliminary_type3_contrasts(design_info_c)
    corrected: OrderedDict[str, np.ndarray] = OrderedDict()
    for term_name, matrix in prelim.items():
        contrast = np.asarray(matrix @ correction, dtype=float)
        if contrast.shape[1] != xt.shape[1]:
            raise ValueError("Corrected Type III contrast columns must align with the fitted design matrix")
        contrast[np.abs(contrast) < tol] = 0.0
        corrected[term_name] = contrast
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
