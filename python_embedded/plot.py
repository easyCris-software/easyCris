#!/usr/bin/env python3
"""
plot.py - Backend router for plot computations

Handles plot-related computations separate from statistical tests.
Called from Tauri/TypeScript frontend via child process.

Usage:
    echo '{"action": "trendline", "x": [...], "y": [...]}' | python plot.py

Actions:
    - trendline: Compute trendline for scatter plot
    - export_plot: Export plotly figure via Kaleido

Version: 1.0.0
"""

import sys
import json
import os

from platform_trust import configure_platform_trust

configure_platform_trust()

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plots_module import compute_trendline


def handle_trendline(params: dict) -> dict:
    """
    Handle trendline computation request.

    Expected params:
        x: List[float] - X values
        y: List[float] - Y values
        type: str - "linear" or "polynomial" (default: "linear")
        degree: int - Polynomial degree 2-5 (default: 2)
        lineColor: str - Line color (optional)
        lineDash: str - "solid", "dash", "dot", "dashdot" (default: "solid")
        showEquation: bool - Include equation (default: True)
        showRSquared: bool - Include R^2 (default: True)

    Returns:
        {
            "success": True,
            "trace": {...},  # Plotly trace to append
            "stats": {...}   # Trendline statistics
        }
    """
    x = params.get("x", [])
    y = params.get("y", [])

    if not x or not y:
        return {
            "success": False,
            "error": "Missing x or y data arrays",
        }

    if len(x) != len(y):
        return {
            "success": False,
            "error": f"x and y arrays must have same length (got {len(x)} and {len(y)})",
        }

    trendline_type = params.get("type", "linear")
    degree = params.get("degree", 2)
    line_color = params.get("lineColor")
    line_dash = params.get("lineDash", "solid")
    show_equation = params.get("showEquation", True)
    show_r_squared = params.get("showRSquared", True)

    try:
        result = compute_trendline(
            x=x,
            y=y,
            trendline_type=trendline_type,
            degree=degree,
            line_color=line_color,
            line_dash=line_dash,
            show_equation=show_equation,
            show_r_squared=show_r_squared,
        )

        return {
            "success": True,
            "trace": result["trace"],
            "stats": result["stats"],
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e),
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Trendline computation failed: {str(e)}",
        }


def handle_export_plot(params: dict) -> dict:
    """
    Handle static plot export (Kaleido-backed).

    Expected params:
        plotly_json: dict - Plotly figure JSON payload (data/layout)
        output_path: str - Destination file path
        options: dict - Export options (format/width/height/dpi/scale/transparent)
    """
    plotly_json = params.get("plotly_json")
    output_path = params.get("output_path")
    options = params.get("options", {}) or {}

    if not isinstance(plotly_json, dict):
        return {"success": False, "error": "plotly_json must be an object"}
    if not isinstance(output_path, str) or not output_path.strip():
        return {"success": False, "error": "output_path is required"}
    if not isinstance(options, dict):
        return {"success": False, "error": "options must be an object"}

    try:
        # Lazy import to avoid loading Plotly/Kaleido for non-export actions.
        from plot_exporter import export_plot_image

        result = export_plot_image(
            plotly_json=plotly_json,
            output_path=output_path,
            options=options,
        )
        if not isinstance(result, dict):
            return {"success": False, "error": "Invalid exporter response"}
        return result
    except Exception as e:
        return {
            "success": False,
            "error": f"Plot export failed: {str(e)}",
        }


def handle_request(request: dict) -> dict:
    action = request.get("action", "")
    if action == "trendline":
        return handle_trendline(request)
    if action == "export_plot":
        return handle_export_plot(request)
    if action == "ping":
        return {"success": True, "message": "plot is ready", "version": "1.0.0"}
    return {"success": False, "error": f"Unknown action: {action}"}


def run_single_request_mode() -> int:
    """Compatibility mode: reads one JSON payload from stdin and exits."""
    try:
        input_data = sys.stdin.read()
        if not input_data.strip():
            print(json.dumps({"success": False, "error": "No input provided"}))
            return 1

        request = json.loads(input_data)
        print(json.dumps(handle_request(request)))
        return 0
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {str(e)}"}))
        return 1
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Backend error: {str(e)}"}))
        return 1


def run_persistent_mode() -> int:
    """
    Worker mode: read newline-delimited JSON requests and emit one JSON result line per request.
    Enabled by EASYCRIS_PLOT_BACKEND_PERSISTENT=1.
    """
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except Exception as e:
            response = {"success": False, "error": f"Backend error: {str(e)}"}

        print(json.dumps(response), flush=True)
    return 0


def main():
    persistent = os.environ.get("EASYCRIS_PLOT_BACKEND_PERSISTENT") == "1"
    exit_code = run_persistent_mode() if persistent else run_single_request_mode()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
