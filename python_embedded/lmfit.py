"""
Lightweight compatibility layer for the subset of lmfit that easyCris uses.

This module replaces the external ``lmfit`` dependency (which is not available
inside the embedded Python runtime) with a minimal implementation that exposes
the ``Model`` and ``Parameters`` classes backed by ``scipy.optimize.curve_fit``.

Only the functionality exercised by ``statistics_module.dose_response`` is
implemented: single independent-variable curve fitting, parameter bounds, and
standard-error estimation from the covariance matrix. The API surface is kept
compatible with the parts of lmfit that the codebase relies on (``params.add``,
``Model.fit``, ``result.params[...]``, ``result.best_fit``, ``result.residual``).
"""

from __future__ import annotations

from dataclasses import dataclass
import inspect
from typing import Dict, Iterable, List, Optional

import numpy as np
from scipy.optimize import curve_fit


@dataclass
class _Parameter:
    """Internal representation of a parameter definition."""

    name: str
    value: float
    min: float = -np.inf
    max: float = np.inf
    vary: bool = True
    stderr: Optional[float] = None


class Parameters:
    """
    Minimal stand-in for ``lmfit.Parameters`` supporting ``add`` and ``[]`` access.
    """

    def __init__(self) -> None:
        self._params: Dict[str, _Parameter] = {}
        self._order: List[str] = []

    def add(
        self,
        name: str,
        value: float,
        min: float = -np.inf,
        max: float = np.inf,
        vary: bool = True,
    ) -> _Parameter:
        param = _Parameter(name=name, value=value, min=min, max=max, vary=vary)
        self._params[name] = param
        if name not in self._order:
            self._order.append(name)
        return param

    def __getitem__(self, name: str) -> _Parameter:
        return self._params[name]

    def __contains__(self, name: str) -> bool:
        return name in self._params

    def keys(self) -> Iterable[str]:
        return list(self._order)


class _ModelResult:
    """Subset of ``lmfit.model.ModelResult`` returned by ``Model.fit``."""

    def __init__(self, params: Dict[str, _Parameter], best_fit: np.ndarray, residual: np.ndarray) -> None:
        self.params = params
        self.best_fit = np.asarray(best_fit, dtype=float)
        self.residual = np.asarray(residual, dtype=float)
        self.success = True


class Model:
    """
    Simplified ``lmfit.Model`` that supports the operations required by easyCris.
    """

    def __init__(self, func):
        self.func = func
        signature = inspect.signature(func)
        self._arg_names = list(signature.parameters.keys())
        if len(self._arg_names) < 2:
            raise ValueError("Model functions must define an independent variable and at least one parameter")
        self._independent_var = self._arg_names[0]
        self._parameter_names = self._arg_names[1:]

    def fit(self, data, params: Parameters, **kwargs):
        """
        Fit the model to ``data`` using non-linear least squares.

        Parameters
        ----------
        data : array-like
            Observed responses.
        params : Parameters
            Parameter definitions with initial values and bounds.
        kwargs :
            Must include the independent variable specified by the model function
            (e.g., ``dose=...``). Optionally accepts ``weights`` for weighted fits.
        """

        if self._independent_var not in kwargs:
            raise ValueError(f"Missing independent variable '{self._independent_var}' in Model.fit()")

        ydata = np.asarray(data, dtype=float)
        xdata = np.asarray(kwargs.pop(self._independent_var), dtype=float)
        weights = kwargs.pop("weights", None)

        if kwargs:
            # No other keyword arguments are supported in this compatibility layer.
            raise ValueError(f"Unsupported keyword arguments in Model.fit(): {list(kwargs.keys())}")

        # Build parameter vectors in function order.
        p0 = []
        lower_bounds = []
        upper_bounds = []
        ordered_params: List[_Parameter] = []
        for name in self._parameter_names:
            if name not in params:
                raise ValueError(f"Parameter '{name}' missing from Parameters collection")
            param = params[name]
            ordered_params.append(param)
            p0.append(param.value)
            lower_bounds.append(param.min if param.min is not None else -np.inf)
            upper_bounds.append(param.max if param.max is not None else np.inf)

        sigma = None
        if weights is not None:
            w = np.asarray(weights, dtype=float)
            sigma = np.empty_like(w, dtype=float)
            # Convert weights (1/sigma) to sigma, guarding against zeros.
            finite_mask = np.isfinite(w) & (np.abs(w) > 0)
            sigma[finite_mask] = 1.0 / w[finite_mask]
            sigma[~finite_mask] = 1e12  # effectively zero weight

        def wrapped_func(x, *theta):
            return self.func(x, *theta)

        popt, pcov = curve_fit(
            wrapped_func,
            xdata,
            ydata,
            p0=p0,
            bounds=(np.asarray(lower_bounds, dtype=float), np.asarray(upper_bounds, dtype=float)),
            sigma=sigma,
            maxfev=20000,
        )

        best_fit = wrapped_func(xdata, *popt)
        residual = ydata - best_fit

        stderr = [None] * len(popt)
        if pcov is not None:
            diag = np.diag(pcov)
            with np.errstate(invalid="ignore"):
                stderr = [float(np.sqrt(d)) if np.isfinite(d) and d >= 0 else None for d in diag]

        fitted_params: Dict[str, _Parameter] = {}
        for idx, name in enumerate(self._parameter_names):
            original = ordered_params[idx]
            fitted = _Parameter(
                name=name,
                value=float(popt[idx]),
                min=original.min,
                max=original.max,
                vary=original.vary,
                stderr=stderr[idx],
            )
            fitted_params[name] = fitted

        return _ModelResult(fitted_params, best_fit, residual)


__all__ = ["Model", "Parameters"]
