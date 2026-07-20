"""
plots_module - Plot computation utilities for easyCris

Provides server-side computation for plot enhancements:
- Trendlines (linear, polynomial)
- Confidence intervals
- Smoothing curves

All computations return Plotly-compatible trace data.
"""

__version__ = "1.0.0"

from .trendlines import compute_trendline

__all__ = ["compute_trendline"]
