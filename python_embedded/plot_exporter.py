"""
Plot export helper using Plotly + Kaleido.

Exports Plotly figure JSON to static images (png, svg, pdf, etc.).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
import json
import math
import os
import sys
import tempfile
from datetime import datetime
import traceback

import plotly.io as pio

EXPORTER_BUILD_TAG = "plot-exporter-2026-02-28-json-hardening-1"

RASTER_FORMATS = {"png", "jpg", "jpeg", "webp", "tiff", "tif"}
TIGHTEN_MARGIN_PX = 0


def _compute_scale(fmt: str, dpi: Optional[int], scale: Optional[float]) -> Optional[float]:
    if scale is not None:
        return scale
    if dpi is None:
        return None
    if fmt.lower() not in RASTER_FORMATS:
        return None
    # Plotly/Kaleido scale is relative to a baseline screen DPI.
    base_dpi = 96.0
    return float(dpi) / base_dpi


_KALEIDO_CONFIGURED = False


def _get_kaleido_user_data_dir() -> str:
    """Get or create a writable user-data-dir for Kaleido/Chromium."""
    import os
    import tempfile

    # Use a persistent directory in temp for Kaleido's Chromium profile
    user_data_dir = os.path.join(tempfile.gettempdir(), "kaleido_user_data")
    os.makedirs(user_data_dir, exist_ok=True)
    return user_data_dir


def _configure_kaleido() -> None:
    """Configure Kaleido for bundled/sidecar environments (Tauri)."""
    global _KALEIDO_CONFIGURED
    if _KALEIDO_CONFIGURED:
        return
    _KALEIDO_CONFIGURED = True

    user_data_dir = _get_kaleido_user_data_dir()

    scope = getattr(pio, "kaleido", None)
    scope = getattr(scope, "scope", None)
    if scope is None:
        return

    # Prefer an explicit Kaleido executable in embedded/runtime layouts.
    # This avoids PATH-dependent resolution failures in packaged builds.
    try:
        import os
        import sys
        import kaleido as kaleido_pkg

        candidates = []
        kaleido_dir = os.path.dirname(getattr(kaleido_pkg, "__file__", "") or "")
        if kaleido_dir:
            candidates.extend(
                [
                    os.path.join(kaleido_dir, "executable", "bin", "kaleido.exe"),
                    os.path.join(kaleido_dir, "executable", "kaleido.exe"),
                    os.path.join(kaleido_dir, "executable", "kaleido"),
                    os.path.join(kaleido_dir, "kaleido.exe"),
                    os.path.join(kaleido_dir, "kaleido"),
                ]
            )

        py_dir = os.path.dirname(sys.executable)
        candidates.extend(
            [
                os.path.join(py_dir, "kaleido.exe"),
                os.path.join(py_dir, "kaleido"),
            ]
        )

        for candidate in candidates:
            if candidate and os.path.isfile(candidate):
                scope.executable = candidate
                break
    except Exception:
        # Keep default Kaleido resolution if explicit probing fails.
        pass

    chromium_args = list(getattr(scope, "chromium_args", ()) or ())
    chromium_args = [
        arg for arg in chromium_args if not str(arg).startswith("--user-data-dir=")
    ]
    chromium_args.append(f"--user-data-dir={user_data_dir}")
    scope.chromium_args = tuple(chromium_args)
    if scope.mathjax is None:
        scope.mathjax = "https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.5/MathJax.js"


def _get_backend_fingerprint() -> Dict[str, Any]:
    plotly_version = None
    kaleido_version = None
    try:
        import plotly

        plotly_version = getattr(plotly, "__version__", None)
    except Exception:
        plotly_version = None

    try:
        import kaleido

        kaleido_version = getattr(kaleido, "__version__", None)
    except Exception:
        kaleido_version = None

    try:
        file_mtime = int(os.path.getmtime(__file__))
    except Exception:
        file_mtime = None

    return {
        "build_tag": EXPORTER_BUILD_TAG,
        "module": os.path.abspath(__file__),
        "file_mtime_epoch": file_mtime,
        "python_version": sys.version.split(" ", maxsplit=1)[0],
        "plotly_version": plotly_version,
        "kaleido_version": kaleido_version,
        "pid": os.getpid(),
    }


def _tighten_margins(layout: Dict[str, Any], px: int = TIGHTEN_MARGIN_PX) -> Dict[str, Any]:
    """Match export defaults: only tighten if margins are untouched."""
    margin = layout.get("margin")
    if isinstance(margin, dict) and any(
        margin.get(key) is not None for key in ("l", "r", "t", "b")
    ):
        return layout
    if margin is not None and not isinstance(margin, dict):
        return layout

    title = layout.get("title")
    has_title = bool(title.get("text")) if isinstance(title, dict) else bool(title)
    margin_top = None if has_title else max(40, px)
    return {
        **layout,
        "margin": {"l": px, "r": px, "t": margin_top, "b": px},
    }


def _apply_transparent_background(layout: Dict[str, Any]) -> Dict[str, Any]:
    """Force transparent backgrounds for raster exports that support alpha."""
    return {
        **layout,
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
    }


def _sanitize_layout(layout: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sanitize layout values to fix validation errors.

    Plotly validation requires:
    - title.y must be in range [0, 1]
    - title.x must be in range [0, 1]

    This fixes user-created plots with out-of-bounds values.
    """
    layout = dict(layout)  # Make a copy to avoid mutation

    # Fix title position if out of bounds
    title = layout.get("title")
    if isinstance(title, dict):
        title = dict(title)  # Copy to avoid mutation

        # Clamp title.y to [0, 1]
        if "y" in title and isinstance(title["y"], (int, float)):
            if title["y"] < 0:
                title["y"] = 0.0
            elif title["y"] > 1:
                title["y"] = 1.0

        # Clamp title.x to [0, 1]
        if "x" in title and isinstance(title["x"], (int, float)):
            if title["x"] < 0:
                title["x"] = 0.0
            elif title["x"] > 1:
                title["x"] = 1.0

        layout["title"] = title

    return layout


def _sanitize_string(value: str) -> str:
    """
    Replace JSON-hostile string code points:
    - unpaired surrogate code units
    - illegal control chars (except tab/newline/carriage return)
    """
    if not value:
        return value

    changed = False
    chars: List[str] = []
    for ch in value:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            chars.append("\uFFFD")
            changed = True
            continue
        if code < 0x20 and ch not in ("\t", "\n", "\r"):
            chars.append(" ")
            changed = True
            continue
        chars.append(ch)
    return "".join(chars) if changed else value


def _string_has_json_hostile_chars(value: str) -> bool:
    for ch in value:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            return True
        if code < 0x20 and ch not in ("\t", "\n", "\r"):
            return True
    return False


def _sanitize_nan_inf(value: Any) -> Any:
    """
    Recursively replace NaN/Infinity values with None so Kaleido receives valid JSON.
    """
    if value is None or isinstance(value, (bool, int)):
        return value

    if isinstance(value, str):
        return _sanitize_string(value)

    if isinstance(value, float):
        return value if math.isfinite(value) else None

    if isinstance(value, dict):
        cleaned: Dict[Any, Any] = {}
        for key, item in value.items():
            safe_key = _sanitize_string(key) if isinstance(key, str) else key
            cleaned[safe_key] = _sanitize_nan_inf(item)
        return cleaned

    if isinstance(value, list):
        return [_sanitize_nan_inf(item) for item in value]

    if isinstance(value, tuple):
        return [_sanitize_nan_inf(item) for item in value]

    # Handle scalar-like objects (for example numpy scalar values) without
    # introducing hard runtime dependencies.
    item_getter = getattr(value, "item", None)
    if callable(item_getter):
        try:
            return _sanitize_nan_inf(item_getter())
        except Exception:
            return value

    return value


def _preflight_json_validity(fig_dict: Dict[str, Any]) -> Optional[str]:
    """
    Return an error string when figure cannot be serialized as strict JSON.
    """
    try:
        serialized = json.dumps(fig_dict, allow_nan=False, ensure_ascii=False)
        serialized.encode("utf-8", "strict")
        return None
    except Exception as exc:
        return str(exc)


def _collect_suspect_string_paths(
    value: Any,
    path: str = "$",
    suspects: Optional[List[str]] = None,
    limit: int = 20,
) -> List[str]:
    if suspects is None:
        suspects = []

    if len(suspects) >= limit:
        return suspects

    if isinstance(value, str):
        if _string_has_json_hostile_chars(value):
            suspects.append(path)
        return suspects

    if isinstance(value, dict):
        for key, item in value.items():
            if len(suspects) >= limit:
                break
            key_text = str(key)
            _collect_suspect_string_paths(item, f"{path}.{key_text}", suspects, limit)
        return suspects

    if isinstance(value, list):
        for idx, item in enumerate(value):
            if len(suspects) >= limit:
                break
            _collect_suspect_string_paths(item, f"{path}[{idx}]", suspects, limit)
        return suspects

    return suspects


def _dump_invalid_json_artifact(
    fig_dict: Dict[str, Any],
    output_path: str,
    options: Dict[str, Any],
    error: str,
    details: str,
    suspect_paths: List[str],
) -> Tuple[Optional[str], Optional[str]]:
    try:
        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S%fZ")
        artifact_path = os.path.join(
            tempfile.gettempdir(),
            f"easycris-kaleido-invalid-json-{timestamp}.json",
        )
        payload = {
            "kind": "kaleido_invalid_json_debug",
            "exporter_fingerprint": _get_backend_fingerprint(),
            "output_path": output_path,
            "options": options,
            "error": error,
            "details": details,
            "suspect_paths": suspect_paths,
            "plotly_json": fig_dict,
        }
        with open(artifact_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

        replay_command = (
            "python -c \"import json; from plot_exporter import export_plot_image; "
            f"p=json.load(open(r'{artifact_path}', encoding='utf-8')); "
            "print(export_plot_image(p['plotly_json'], p['output_path'], p['options']))\""
        )
        return artifact_path, replay_command
    except Exception:
        return None, None


def export_plot_image(
    plotly_json: Dict[str, Any],
    output_path: str,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Export a Plotly figure to a static image file."""
    options = options or {}
    backend_fingerprint = _get_backend_fingerprint()
    fmt = str(options.get("format", "png")).lower()
    supported = {"png", "jpg", "jpeg", "webp", "svg", "pdf", "tiff", "tif"}
    if fmt not in supported:
        return {
            "success": False,
            "error": f"Unsupported format: {fmt}",
            "backend_fingerprint": backend_fingerprint,
        }
    width = options.get("width")
    height = options.get("height")
    dpi = options.get("dpi")
    scale = options.get("scale")
    transparent = options.get("transparent")

    try:
        _configure_kaleido()
        if hasattr(plotly_json, "to_dict"):
            fig_dict = plotly_json.to_dict()
        elif isinstance(plotly_json, dict):
            fig_dict = dict(plotly_json)
        else:
            return {
                "success": False,
                "error": "plotly_json must be a dict or Figure",
                "backend_fingerprint": backend_fingerprint,
            }

        layout = fig_dict.get("layout") or {}
        if isinstance(layout, dict):
            layout = _sanitize_layout(layout)  # Fix out-of-bounds values first
            layout = _tighten_margins(layout)
            if fmt == "png" and transparent:
                layout = _apply_transparent_background(layout)
            fig_dict["layout"] = layout

        fig_dict = _sanitize_nan_inf(fig_dict)
        json_error = _preflight_json_validity(fig_dict)
        if json_error:
            suspect_paths = _collect_suspect_string_paths(fig_dict)
            artifact_path, replay_command = _dump_invalid_json_artifact(
                fig_dict=fig_dict,
                output_path=output_path,
                options=options,
                error=json_error,
                details="Preflight JSON validation failed before Kaleido transform.",
                suspect_paths=suspect_paths,
            )
            return {
                "success": False,
                "error": f"Invalid figure JSON before Kaleido transform: {json_error}",
                "error_type": "InvalidFigureJson",
                "suspect_paths": suspect_paths,
                "debug_payload_path": artifact_path,
                "replay_command": replay_command,
                "backend_fingerprint": backend_fingerprint,
            }

        export_scale = _compute_scale(fmt, dpi, scale)

        # TIFF: Export as PNG first, then convert via Pillow
        if fmt in ("tiff", "tif"):
            from io import BytesIO
            from PIL import Image

            try:
                png_bytes = pio.to_image(
                    fig_dict,
                    format="png",
                    width=width,
                    height=height,
                    scale=export_scale,
                    engine="kaleido",
                    validate=True,
                )
            except Exception:
                # Fallback to validate=False if strict validation fails
                png_bytes = pio.to_image(
                    fig_dict,
                    format="png",
                    width=width,
                    height=height,
                    scale=export_scale,
                    engine="kaleido",
                    validate=False,
                )
            img = Image.open(BytesIO(png_bytes)).convert("RGB")
            img.save(
                output_path,
                format="TIFF",
                compression="tiff_lzw",
                dpi=(dpi or 96, dpi or 96),
            )
        else:
            try:
                pio.write_image(
                    fig_dict,
                    output_path,
                    format=fmt,
                    width=width,
                    height=height,
                    scale=export_scale,
                    engine="kaleido",
                    validate=True,
                )
            except Exception:
                # Fallback to validate=False if strict validation fails
                pio.write_image(
                    fig_dict,
                    output_path,
                    format=fmt,
                    width=width,
                    height=height,
                    scale=export_scale,
                    engine="kaleido",
                    validate=False,
                )

        return {
            "success": True,
            "path": output_path,
            "format": fmt,
            "width": width,
            "height": height,
            "dpi": dpi,
            "scale": export_scale,
            "backend_fingerprint": backend_fingerprint,
        }
    except Exception as e:
        details = traceback.format_exc(limit=8)
        suspect_paths: List[str] = []
        artifact_path: Optional[str] = None
        replay_command: Optional[str] = None
        is_invalid_json = "invalid json" in str(e).lower() or "invalid json" in details.lower()

        # Attempt focused diagnostics for Transform Invalid JSON failures.
        if is_invalid_json:
            try:
                fig_value = locals().get("fig_dict")
                if isinstance(fig_value, dict):
                    suspect_paths = _collect_suspect_string_paths(fig_value)
                    artifact_path, replay_command = _dump_invalid_json_artifact(
                        fig_dict=fig_value,
                        output_path=output_path,
                        options=options,
                        error=str(e),
                        details=details,
                        suspect_paths=suspect_paths,
                    )
            except Exception:
                suspect_paths = []

        return {
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__,
            "details": details,
            "message": f"Failed to export plot: {str(e)}",
            "suspect_paths": suspect_paths,
            "debug_payload_path": artifact_path,
            "replay_command": replay_command,
            "backend_fingerprint": backend_fingerprint,
        }
