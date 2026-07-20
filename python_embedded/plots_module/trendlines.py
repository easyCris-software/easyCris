"""
trendlines.py - Trendline computation for scatter plots

Computes regression lines and returns Plotly-compatible trace data.
Uses NumPy for fast, accurate least-squares fitting.

Supported types:
- linear: y = mx + b
- polynomial: y = a_n*x^n + ... + a_1*x + a_0 (degree 2-5)

License: BSD (NumPy dependency)
"""

import numpy as np
from typing import List, Dict, Any, Optional, Literal

TrendlineType = Literal["linear", "polynomial"]


def compute_trendline(
    x: List[float],
    y: List[float],
    trendline_type: TrendlineType = "linear",
    degree: int = 2,
    num_points: int = 100,
    line_color: Optional[str] = None,
    line_dash: str = "solid",
    show_equation: bool = True,
    show_r_squared: bool = True,
) -> Dict[str, Any]:
    """
    Compute a trendline for scatter plot data.

    Args:
        x: X values (numeric array)
        y: Y values (numeric array)
        trendline_type: "linear" or "polynomial"
        degree: Polynomial degree (2-5, ignored for linear)
        num_points: Number of points for smooth line
        line_color: Line color (default: semi-transparent black)
        line_dash: Line style ("solid", "dash", "dot", "dashdot")
        show_equation: Include equation string in stats
        show_r_squared: Include R-squared in stats

    Returns:
        {
            "trace": Plotly trace dict (mode: "lines"),
            "stats": {
                "type": "linear" | "polynomial",
                "coefficients": [...],
                "r_squared": float,
                "equation": str,
                "slope": float (linear only),
                "intercept": float (linear only)
            }
        }
    """
    # Convert to numpy arrays and filter out NaN/None
    x_arr = np.array(x, dtype=float)
    y_arr = np.array(y, dtype=float)

    # Remove NaN values (paired removal)
    valid_mask = ~(np.isnan(x_arr) | np.isnan(y_arr))
    x_clean = x_arr[valid_mask]
    y_clean = y_arr[valid_mask]

    if len(x_clean) < 2:
        raise ValueError("Need at least 2 valid data points for trendline")

    # Determine degree
    if trendline_type == "linear":
        deg = 1
    else:
        deg = max(2, min(degree, 5))  # Clamp to 2-5 for polynomial

    # Fit polynomial (degree 1 = linear)
    coeffs = np.polyfit(x_clean, y_clean, deg)
    poly = np.poly1d(coeffs)

    # Generate smooth line points
    x_min, x_max = float(np.min(x_clean)), float(np.max(x_clean))
    x_fit = np.linspace(x_min, x_max, num_points)
    y_fit = poly(x_fit)

    # Compute R-squared
    y_pred = poly(x_clean)
    ss_res = np.sum((y_clean - y_pred) ** 2)
    ss_tot = np.sum((y_clean - np.mean(y_clean)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot != 0 else 0.0

    # Build equation string
    equation = _format_equation(coeffs, trendline_type, deg)

    # Build stats dict
    stats: Dict[str, Any] = {
        "type": trendline_type,
        "degree": deg,
        "coefficients": coeffs.tolist(),
        "r_squared": round(r_squared, 6),
        "n_points": len(x_clean),
        "trendline": True,
    }

    if show_equation:
        stats["equation"] = equation

    if show_r_squared:
        stats["r_squared_display"] = f"R^2 = {r_squared:.4f}"

    # For linear, also provide slope/intercept directly
    if trendline_type == "linear":
        stats["slope"] = round(float(coeffs[0]), 6)
        stats["intercept"] = round(float(coeffs[1]), 6)

    # Build Plotly trace
    trace_name = "Trendline"

    trace: Dict[str, Any] = {
        "x": x_fit.tolist(),
        "y": y_fit.tolist(),
        "mode": "lines",
        "type": "scatter",
        "name": trace_name,
        "line": {
            "dash": line_dash,
            "color": line_color or "rgba(20, 20, 20, 0.9)",
            "width": 3,
        },
        "hoverinfo": "skip",  # Don't show hover for trendline
        "showlegend": True,
    }

    return {
        "trace": trace,
        "stats": stats,
    }


def _format_equation(coeffs: np.ndarray, trendline_type: str, degree: int) -> str:
    """Format polynomial coefficients as equation string."""
    if trendline_type == "linear":
        m, b = coeffs[0], coeffs[1]
        sign = "+" if b >= 0 else "-"
        return f"y = {m:.4g}x {sign} {abs(b):.4g}"

    # Polynomial
    terms = []
    for i, c in enumerate(coeffs):
        power = degree - i
        if abs(c) < 1e-10:
            continue

        coef_str = f"{c:.4g}"
        if power == 0:
            terms.append(coef_str)
        elif power == 1:
            terms.append(f"{coef_str}x")
        else:
            terms.append(f"{coef_str}x^{power}")

    if not terms:
        return "y = 0"

    equation = " + ".join(terms).replace("+ -", "- ")
    return f"y = {equation}"


# Convenience functions for specific trendline types

def linear_trendline(x: List[float], y: List[float], **kwargs) -> Dict[str, Any]:
    """Compute linear trendline (y = mx + b)."""
    return compute_trendline(x, y, trendline_type="linear", **kwargs)


def polynomial_trendline(
    x: List[float], y: List[float], degree: int = 2, **kwargs
) -> Dict[str, Any]:
    """Compute polynomial trendline."""
    return compute_trendline(x, y, trendline_type="polynomial", degree=degree, **kwargs)
