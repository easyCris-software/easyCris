"""
easyCris Python Backend Entry Point
Compiled with Nuitka for standalone execution.

VERSION: 2.1.0
DATE: December 21, 2025

Supports:
- JSON control payloads (small datasets)
- Apache Arrow IPC files (large datasets >100K rows)
- DuckDB hybrid cache (large datasets >= 1M rows) via DataProvider
- All 45 validated statistical tests across 7 groups

Phase 4 Fix: Complete test routing for all validated tests
Phase 5: DuckDB hybrid cache support via DataProvider
"""

import sys
import json
import os
import importlib
from pathlib import Path

from platform_trust import configure_platform_trust

configure_platform_trust()

format_number = None
set_context_metadata = None
sanitize_for_json = None

# Lazy-loaded statistics families to reduce startup crash surface in compiled mode.
parametric = None
nonparametric = None
anova = None
regression = None
correlation = None
dose_response = None
survival = None
mediation = None
moderation = None
contingency = None
descriptive = None
distributions = None
mf_anova = None
lmm = None
drug_combo = None
_utils_loaded = False

_FAMILY_LOADERS = {
    "parametric": lambda: importlib.import_module("statistics_module.parametric"),
    "nonparametric": lambda: importlib.import_module("statistics_module.nonparametric"),
    "anova": lambda: importlib.import_module("statistics_module.anova"),
    "regression": lambda: importlib.import_module("statistics_module.regression"),
    "correlation": lambda: importlib.import_module("statistics_module.correlation"),
    "dose_response": lambda: importlib.import_module("statistics_module.dose_response"),
    "survival": lambda: importlib.import_module("statistics_module.survival"),
    "mediation": lambda: importlib.import_module("statistics_module.mediation"),
    "moderation": lambda: importlib.import_module("statistics_module.moderation"),
    "contingency": lambda: importlib.import_module("statistics_module.contingency"),
    "descriptive": lambda: importlib.import_module("statistics_module.descriptive"),
    "distributions": lambda: importlib.import_module("statistics_module.distributions"),
    "mf_anova": lambda: importlib.import_module("statistics_module.multifactorial_anova").multifactorial_anova,
    "lmm": lambda: importlib.import_module("statistics_module.lmm_anova"),
    "drug_combo": lambda: importlib.import_module("statistics_module.drug_combo"),
}

_FAMILY_TESTS = {
    "parametric": {"independent_ttest", "paired_ttest", "one_sample_ttest", "one_way_anova"},
    "nonparametric": {"mann_whitney", "wilcoxon", "kruskal_wallis", "friedman", "scheirer_ray_hare"},
    "anova": {"two_way_anova"},
    "mf_anova": {"multifactorial_anova"},
    "regression": {"linear_regression", "multiple_linear_regression", "logistic_regression", "logistic_multinomial"},
    "correlation": {"correlation_pearson", "correlation_spearman", "correlation_kendall"},
    "contingency": {"chi_square", "chi_square_gof", "fishers_exact", "mcnemar"},
    "descriptive": {"descriptive_stats", "outlier_detection", "independent_ttest", "paired_ttest", "one_sample_ttest", "one_way_anova"},
    "distributions": {"normality_shapiro", "normality_ks", "normality_ad", "normality_cvm", "normality_jb", "normality_all", "normality_tests"},
    "dose_response": {"dose_response_3pl", "dose_response_4pl", "dose_response_5pl", "dose_response_compare"},
    "drug_combo": {"synergy_bliss", "synergy_hsa", "synergy_loewe", "synergy_zip", "synergy_all"},
    "survival": {"kaplan_meier", "cox_regression", "nelson_aalen"},
    "mediation": {"mediation_model4"},
    "moderation": {"moderation_model1", "moderated_mediation_model7"},
    "lmm": {"lmm_anova"},
}


def _ensure_stats_family_loaded(test_name: str) -> None:
    required_families = [
        family for family, tests in _FAMILY_TESTS.items() if test_name in tests
    ]
    for family in required_families:
        if globals().get(family) is not None:
            continue
        try:
            globals()[family] = _FAMILY_LOADERS[family]()
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load statistics dependency family '{family}' for test '{test_name}': {exc}"
            ) from exc

def _ensure_utils_loaded() -> None:
    global format_number, set_context_metadata, sanitize_for_json, _utils_loaded
    if _utils_loaded:
        return
    try:
        utils_module = importlib.import_module("statistics_module.utils")
        format_number = utils_module.format_number
        set_context_metadata = utils_module.set_context_metadata
        sanitize_for_json = utils_module.sanitize_for_json
        _utils_loaded = True
    except Exception as exc:
        raise RuntimeError(f"Failed to load statistics utility helpers: {exc}") from exc


# Optional: RNA-seq module (Phase 8) - loaded lazily per rnaseq_* test only.
RNASEQ_AVAILABLE = False
RNASEQ_IMPORT_ERROR = None
run_deseq2_analysis = None
get_gene_symbols = None
compute_pca_for_biplot = None
validate_count_matrix = None
validate_metadata = None
match_samples = None


def _ensure_rnaseq_module_loaded() -> None:
    global RNASEQ_AVAILABLE, RNASEQ_IMPORT_ERROR
    global run_deseq2_analysis, get_gene_symbols, compute_pca_for_biplot
    global validate_count_matrix, validate_metadata, match_samples

    if RNASEQ_AVAILABLE:
        return

    try:
        rnaseq_module = importlib.import_module("rnaseq_module")
        run_deseq2_analysis = rnaseq_module.run_deseq2_analysis
        get_gene_symbols = rnaseq_module.get_gene_symbols
        compute_pca_for_biplot = rnaseq_module.compute_pca_for_biplot
        validate_count_matrix = rnaseq_module.validate_count_matrix
        validate_metadata = rnaseq_module.validate_metadata
        match_samples = rnaseq_module.match_samples
        RNASEQ_AVAILABLE = True
        RNASEQ_IMPORT_ERROR = None
    except Exception as exc:
        RNASEQ_AVAILABLE = False
        RNASEQ_IMPORT_ERROR = exc
        raise RuntimeError(
            "RNA-seq module is not available. Install PyDESeq2: "
            "pip install pydeseq2 --target python_embedded/python_dependencies/"
        ) from exc

# Optional: Apache Arrow support (will be added when needed)
try:
    import pyarrow as pa
    import pyarrow.feather as feather
    ARROW_AVAILABLE = True
except ImportError:
    ARROW_AVAILABLE = False

# Phase 5: Optional DuckDB/Polars support for large datasets
try:
    from data_provider import DataProvider, create_provider
    DATAPROVIDER_AVAILABLE = True
except ImportError:
    DATAPROVIDER_AVAILABLE = False
    DataProvider = None
    create_provider = None

RNASEQ_DEBUG = os.environ.get("RNASEQ_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}


def _rnaseq_debug(message: str) -> None:
    if RNASEQ_DEBUG:
        print(message, file=sys.stderr, flush=True)


def emit_stats_progress(stage: str, message: str, percent: float = None, **extra_fields) -> None:
    """Emit machine-readable progress events for the Rust/Tauri bridge."""
    payload = {
        "type": "progress",
        "source": "statistics",
        "stage": stage,
        "message": message,
    }
    if percent is not None:
        payload["percent"] = float(percent)
    payload.update(extra_fields)
    try:
        print(json.dumps(payload), file=sys.stderr, flush=True)
    except Exception:
        # Progress reporting must never break analysis execution.
        pass


def dumps_strict_json(payload: dict, indent: int | None = 2) -> str:
    """
    Serialize payload as strict JSON.

    This guarantees no NaN/Infinity tokens are emitted to stdout, which keeps
    Rust-side JSON parsing deterministic.
    """
    def _sanitize_for_json_fallback(value):
        """Best-effort fallback sanitizer when statistics_module.utils is not loaded."""
        import math

        if isinstance(value, dict):
            return {k: _sanitize_for_json_fallback(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_sanitize_for_json_fallback(v) for v in value]

        # Handle numpy/pandas scalar wrappers without importing heavy modules here.
        if hasattr(value, "item") and callable(getattr(value, "item")):
            try:
                return _sanitize_for_json_fallback(value.item())
            except Exception:
                pass
        if hasattr(value, "tolist") and callable(getattr(value, "tolist")):
            try:
                return _sanitize_for_json_fallback(value.tolist())
            except Exception:
                pass

        if isinstance(value, float):
            return value if math.isfinite(value) else None
        return value

    if sanitize_for_json is not None:
        safe_payload = sanitize_for_json(payload)
    else:
        safe_payload = _sanitize_for_json_fallback(payload)
    return json.dumps(safe_payload, indent=indent, allow_nan=False)


def _dose_response_error(message: str, error_type: str, warnings: list | None = None) -> dict:
    err = {
        "success": False,
        "error": message,
        "error_type": error_type,
    }
    if warnings:
        err["warnings"] = [str(w) for w in warnings]
    return err


def _as_float_array(values):
    import numpy as np

    try:
        arr = np.asarray(values, dtype=float)
    except Exception:
        return None
    if arr.ndim != 1:
        arr = arr.reshape(-1)
    return arr


def _evaluate_dose_response_suitability(
    doses,
    responses,
    min_positive_observations: int,
    require_all_positive_doses: bool = False,
    warn_if_unique_positive_below: int = 4,
):
    """
    Validate dose-response modelability before fitting.

    Gate policy:
    - Hard fail on non-numeric/non-finite/mismatched inputs.
    - 3PL/4PL hard minimum: >= min_positive_observations dose rows where dose > 0.
    - Compare-model hard rule: all doses must be > 0 (no zero-dose controls).
    - Limited unique positive dose levels is a soft warning, not a hard failure.
    """
    import numpy as np
    from scipy.stats import spearmanr

    doses_arr = _as_float_array(doses)
    responses_arr = _as_float_array(responses)
    if doses_arr is None or responses_arr is None:
        return _dose_response_error(
            "Dose-response requires numeric dose and response values.",
            "DoseResponseDataUnsuitable",
        )
    if doses_arr.size != responses_arr.size:
        return _dose_response_error(
            "Doses and responses must have the same length.",
            "DoseResponseDataUnsuitable",
        )
    if doses_arr.size == 0:
        return _dose_response_error(
            "No dose-response observations were provided.",
            "DoseResponseDataUnsuitable",
        )
    if np.any(~np.isfinite(doses_arr)) or np.any(~np.isfinite(responses_arr)):
        return _dose_response_error(
            "Dose-response input contains NaN or infinite values.",
            "DoseResponseDataUnsuitable",
        )
    if require_all_positive_doses and np.any(doses_arr <= 0):
        return _dose_response_error(
            "All dose values must be greater than zero for model comparison.",
            "DoseResponseDataUnsuitable",
        )
    if np.any(doses_arr < 0):
        return _dose_response_error(
            "Dose values must be >= 0 for dose-response models.",
            "DoseResponseDataUnsuitable",
        )

    positive = doses_arr[doses_arr > 0]
    if positive.size < min_positive_observations:
        return _dose_response_error(
            f"Need at least {min_positive_observations} positive-dose observations; "
            f"found {int(positive.size)}.",
            "DoseResponseDataUnsuitable",
        )

    unique_positive = np.unique(positive)

    warnings = []

    # Soft warning: weak dynamic range in response values.
    response_span = float(np.max(responses_arr) - np.min(responses_arr))
    response_scale = max(float(np.max(np.abs(responses_arr))), 1.0)
    if response_span <= max(1e-6, 0.01 * response_scale):
        warnings.append(
            "Weak response range detected; uncertainty estimates may be unstable."
        )

    # Soft warning: weak monotonic association with dose.
    if doses_arr.size >= 4:
        rho, _ = spearmanr(doses_arr, responses_arr)
        if rho is None or not np.isfinite(rho) or abs(float(rho)) < 0.25:
            warnings.append(
                "Weak dose-response monotonic signal detected; curve identifiability may be poor."
            )

    if unique_positive.size < max(2, int(warn_if_unique_positive_below)):
        warnings.append(
            f"Fewer than {max(2, int(warn_if_unique_positive_below))} unique positive dose levels "
            "detected; fit uncertainty may be elevated."
        )
    elif unique_positive.size < 6:
        warnings.append(
            "Limited unique positive dose levels; model uncertainty may be elevated."
        )

    return {
        "success": True,
        "warnings": warnings,
    }


def _merge_warnings(payload: dict, warnings: list | None) -> None:
    if not warnings:
        return
    if not isinstance(payload, dict):
        return
    existing = payload.get("warnings", [])
    if not isinstance(existing, list):
        existing = [str(existing)]
    payload["warnings"] = existing + [str(w) for w in warnings]


def get_data_provider(duckdb_path: str, columns: list = None):
    """
    Phase 5: Create DataProvider for large dataset access.

    Args:
        duckdb_path: Path to DuckDB file containing the dataset
        columns: Optional list of column IDs to load

    Returns:
        DataProvider instance configured for lazy access

    Raises:
        RuntimeError if DataProvider is not available
    """
    if not DATAPROVIDER_AVAILABLE:
        raise RuntimeError(
            "DataProvider is not available. Install polars and duckdb: "
            "pip install polars duckdb"
        )

    return DataProvider(duckdb_path, mode='lazy', columns=columns)


def normalize_event_encoding(event_encoding: dict | None):
    if not event_encoding:
        return None

    if 'event_value' in event_encoding or 'censored_value' in event_encoding:
        return {
            'event_value': event_encoding.get('event_value'),
            'censored_value': event_encoding.get('censored_value'),
            'was_encoded': event_encoding.get('was_encoded', event_encoding.get('wasEncoded', False)),
        }

    return {
        'event_value': event_encoding.get('eventValue'),
        'censored_value': event_encoding.get('censoredValue'),
        'was_encoded': event_encoding.get('wasEncoded', event_encoding.get('was_encoded', False)),
    }


def load_arrow_data(arrow_path: str):
    """Load Arrow IPC/Feather/Parquet file."""
    if not ARROW_AVAILABLE:
        raise RuntimeError("PyArrow is not installed. Cannot load Arrow data.")

    path = Path(arrow_path)

    if not path.exists():
        raise FileNotFoundError(f"Arrow file not found: {arrow_path}")

    try:
        if path.suffix == '.feather':
            return feather.read_table(str(path))
        elif path.suffix in ['.arrow', '.ipc']:
            with pa.ipc.open_file(str(path)) as reader:
                return reader.read_all()
        elif path.suffix == '.parquet':
            import pyarrow.parquet as pq
            return pq.read_table(str(path))
        else:
            raise ValueError(f"Unsupported Arrow format: {path.suffix}")
    except Exception as e:
        raise RuntimeError(f"Failed to load Arrow file: {e}")


# Phase 7: Tier 3 tests that require sampling for large datasets
# These tests use iterative fitting algorithms that can't stream efficiently
TIER_3_TESTS = {
    # Dose-Response (iterative curve fitting)
    'dose_response_3pl',
    'dose_response_4pl',
    'dose_response_5pl',
    'dose_response_compare',
    # Survival Analysis (iterative estimation)
    'kaplan_meier',
    'cox_regression',
    'nelson_aalen',
    # Mediation/Moderation (bootstrap-based)
    'mediation_model4',
    'moderation_model1',
    'moderated_mediation_model7',
}

# Phase 7: Tier 2 tests that can use sampling in large mode to reduce RAM use
TIER_2_TESTS = {
    'paired_ttest',
    'one_sample_ttest',
    'one_way_anova',
    'two_way_anova',
    'multifactorial_anova',
    'mann_whitney',
    'wilcoxon',
    'kruskal_wallis',
    'friedman',
    'scheirer_ray_hare',
    'linear_regression',
    'multiple_linear_regression',
    'logistic_regression',
    'logistic_multinomial',
    'correlation_pearson',
    'correlation_spearman',
    'correlation_kendall',
    'normality_shapiro',
    'normality_ks',
    'normality_ad',
    'normality_cvm',
    'normality_jb',
    'normality_all',
    'normality_tests',
    'outlier_detection',
}

# Default sample size for large dataset sampling (Tier 2/3)
TIER_2_SAMPLE_SIZE = 100_000
TIER_3_SAMPLE_SIZE = 100_000
TIER_2_SAMPLE_THRESHOLD = 1_000_000
TIER_3_SAMPLE_THRESHOLD = 1_000_000
TIER_3_RANDOM_SEED = 42


def extract_column_data(data: dict, data_provider, column_key: str, column_name: str = None):
    """
    Phase 5: Extract column data from embedded payload or DataProvider.

    For small datasets, data is embedded in the payload.
    For large datasets, we use DataProvider to query DuckDB lazily.

    Args:
        data: Embedded data dict from payload
        data_provider: DataProvider instance (or None for small datasets)
        column_key: Key in the data dict (e.g., 'group1', 'values')
        column_name: Column name in DuckDB (defaults to column_key)

    Returns:
        List/array of values
    """
    # First try embedded data (always preferred if available)
    embedded = data.get(column_key, [])
    if embedded:
        return embedded

    # If no embedded data and we have a data_provider, try to fetch from DuckDB
    if data_provider is not None and column_name:
        try:
            return data_provider.get_column(column_name).tolist()
        except Exception:
            pass  # Fall back to empty list

    return []


def fetch_data_for_large_dataset(data_provider, params: dict, test_name: str) -> dict:
    """
    Phase 5: Fetch and transform data from DataProvider for large datasets.

    This function handles the data transformation that frontend normally does,
    converting raw DuckDB columns into the format expected by each test.

    Args:
        data_provider: DataProvider instance for DuckDB access
        params: Parameters dict containing column_names, column_types, etc.
        test_name: Name of the statistical test

    Returns:
        Dict with data in the format expected by the test
    """
    import numpy as np

    column_names = params.get('column_names', [])
    column_ids = params.get('column_ids', [])
    column_types = params.get('column_types', [])

    if not column_ids:
        column_ids = column_names

    if not column_names or len(column_names) != len(column_ids):
        column_names = list(column_ids)

    if not column_ids or data_provider is None:
        return {}

    def _normalize_dtype(value):
        if value is None:
            return ""
        if isinstance(value, str):
            normalized = value.strip().lower()
        else:
            normalized = str(value).strip().lower()
        return normalized.replace("_", " ").replace("-", " ")

    def _is_numeric(dtype):
        normalized = _normalize_dtype(dtype)
        return normalized in ("numeric", "ordinal", "0", "3")

    def _is_categorical(dtype):
        normalized = _normalize_dtype(dtype)
        return normalized in ("categorical", "binary", "1", "2")

    def _is_binary(dtype):
        normalized = _normalize_dtype(dtype)
        return normalized in ("binary", "2")

    if len(column_types) < len(column_ids):
        column_types = column_types + [None] * (len(column_ids) - len(column_types))

    id_to_name = {column_ids[i]: column_names[i] for i in range(len(column_ids))}
    name_to_id = {column_names[i]: column_ids[i] for i in range(len(column_ids))}

    def display_name(column_id: str) -> str:
        return id_to_name.get(column_id, column_id)

    # Fetch all selected columns from DuckDB (by column IDs)
    df = data_provider.get_dataframe(columns=column_ids)

    def _error(message: str) -> dict:
        return {"__error__": message}

    def _numeric_series(column_id: str):
        import pandas as pd
        return pd.to_numeric(df[column_id], errors="coerce")

    def _factor_series(column_id: str):
        return df[column_id].astype(str)

    def _resolve_column(value):
        if not value:
            return None
        if value in column_ids:
            return value
        if value in name_to_id:
            return name_to_id[value]
        return None

    # Transform based on test type
    result_data = {}

    # -------------------------------------------------------------------------
    # Two-sample tests (t-test, Mann-Whitney): 1 numeric + 1 categorical
    # -------------------------------------------------------------------------
    if test_name in ('independent_ttest', 'mann_whitney'):
        # Check for explicit column mapping from dialog
        if test_name == 'mann_whitney':
            ttest_mapping = (
                params.get("mann_whitney_mapping")
                or params.get("mannWhitneyMapping")
                or params.get("ttest_mapping")
                or params.get("ttestMapping")
                or {}
            )
        else:
            ttest_mapping = params.get("ttest_mapping") or params.get("ttestMapping") or {}

        numeric_col = None
        cat_col = None

        if test_name == 'mann_whitney':
            warnings = []
            id_to_type = {column_ids[i]: column_types[i] for i in range(len(column_ids))}

            def _col_type(column_id: str):
                return id_to_type.get(column_id)

            def _is_numeric_col(column_id: str) -> bool:
                return _is_numeric(_col_type(column_id))

            mapped_group = _resolve_column(ttest_mapping.get("group"))
            mapped_outcome = _resolve_column(ttest_mapping.get("outcome"))

            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            categorical_cols = [name for name, dtype in zip(column_ids, column_types) if _is_categorical(dtype)]

            is_wide_format = False
            wide_col1 = None
            wide_col2 = None

            if mapped_group and mapped_outcome and _is_numeric_col(mapped_group) and _is_numeric_col(mapped_outcome):
                is_wide_format = True
                wide_col1 = mapped_group
                wide_col2 = mapped_outcome
            elif len(numeric_cols) == 2 and len(categorical_cols) == 0:
                is_wide_format = True
                wide_col1 = numeric_cols[0]
                wide_col2 = numeric_cols[1]

            if is_wide_format:
                if not wide_col1 or not wide_col2:
                    return _error("mann_whitney requires two numeric columns in wide format.")

                series1 = _numeric_series(wide_col1).dropna()
                series2 = _numeric_series(wide_col2).dropna()

                group1_data = series1.tolist()
                group2_data = series2.tolist()

                if not group1_data or not group2_data:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_data) < 2 or len(group2_data) < 2:
                    return _error(
                        f"Insufficient sample size. {display_name(wide_col1)}: {len(group1_data)}, "
                        f"{display_name(wide_col2)}: {len(group2_data)}. Minimum 2 observations per group required."
                    )

                warnings.append(
                    "Wide format treats each numeric column as a separate group. Ensure each column contains independent observations."
                )

                result_data['data1'] = group1_data
                result_data['data2'] = group2_data
                result_data['group_name1'] = str(display_name(wide_col1))
                result_data['group_name2'] = str(display_name(wide_col2))
                if warnings:
                    result_data['warnings'] = warnings
            else:
                # Use explicit mapping if provided
                if mapped_group and mapped_outcome:
                    cat_col = mapped_group
                    numeric_col = mapped_outcome
                else:
                    # Fall back to auto-detection
                    for name, dtype in zip(column_ids, column_types):
                        if _is_numeric(dtype) and numeric_col is None:
                            numeric_col = name
                        elif _is_categorical(dtype) and cat_col is None:
                            cat_col = name

                if not numeric_col or not cat_col:
                    return _error(f"{test_name} requires 1 numeric column and 1 categorical column.")

                numeric_vals = _numeric_series(numeric_col)
                cat_vals = _factor_series(cat_col)
                mask = numeric_vals.notna() & cat_vals.notna() & (cat_vals.str.strip() != "")
                numeric_vals = numeric_vals[mask]
                cat_vals = cat_vals[mask]

                group_names = []
                group_index = {}
                for group_val in cat_vals.tolist():
                    group_str = str(group_val).strip()
                    if group_str not in group_index:
                        group_index[group_str] = len(group_names)
                        group_names.append(group_str)

                if len(group_names) != 2:
                    return _error(f"{test_name} requires exactly 2 groups. Found {len(group_names)}.")

                groups = [[] for _ in group_names]
                for group_val, num_val in zip(cat_vals.tolist(), numeric_vals.tolist()):
                    group_str = str(group_val).strip()
                    idx = group_index.get(group_str)
                    if idx is None:
                        continue
                    groups[idx].append(float(num_val))

                group1_data = groups[0]
                group2_data = groups[1]

                if not group1_data or not group2_data:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_data) < 2 or len(group2_data) < 2:
                    return _error(
                        f"Insufficient sample size. {group_names[0]}: {len(group1_data)}, {group_names[1]}: {len(group2_data)}. "
                        "Minimum 2 observations per group required."
                    )

                result_data['data1'] = group1_data
                result_data['data2'] = group2_data
                result_data['group_name1'] = str(group_names[0])
                result_data['group_name2'] = str(group_names[1])
        else:
            warnings = []
            id_to_type = {column_ids[i]: column_types[i] for i in range(len(column_ids))}

            def _col_type(column_id: str):
                return id_to_type.get(column_id)

            def _is_numeric_col(column_id: str) -> bool:
                return _is_numeric(_col_type(column_id))

            mapped_group = _resolve_column(ttest_mapping.get("group"))
            mapped_outcome = _resolve_column(ttest_mapping.get("outcome"))

            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            categorical_cols = [name for name, dtype in zip(column_ids, column_types) if _is_categorical(dtype)]

            is_wide_format = False
            wide_col1 = None
            wide_col2 = None

            if mapped_group and mapped_outcome and _is_numeric_col(mapped_group) and _is_numeric_col(mapped_outcome):
                is_wide_format = True
                wide_col1 = mapped_group
                wide_col2 = mapped_outcome
            elif len(numeric_cols) == 2 and len(categorical_cols) == 0:
                is_wide_format = True
                wide_col1 = numeric_cols[0]
                wide_col2 = numeric_cols[1]

            if is_wide_format:
                if not wide_col1 or not wide_col2:
                    return _error("independent_ttest requires two numeric columns in wide format.")

                series1 = _numeric_series(wide_col1).dropna()
                series2 = _numeric_series(wide_col2).dropna()

                group1_data = series1.tolist()
                group2_data = series2.tolist()

                if not group1_data or not group2_data:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_data) < 2 or len(group2_data) < 2:
                    return _error(
                        f"Insufficient sample size. {display_name(wide_col1)}: {len(group1_data)}, "
                        f"{display_name(wide_col2)}: {len(group2_data)}. Minimum 2 observations per group required."
                    )

                warnings.append(
                    "Wide format treats each numeric column as a separate group. Ensure each column contains independent observations."
                )

                result_data['group1'] = group1_data
                result_data['group2'] = group2_data
                result_data['group1_name'] = str(display_name(wide_col1))
                result_data['group2_name'] = str(display_name(wide_col2))
                if warnings:
                    result_data['warnings'] = warnings
            else:
                # Use explicit mapping if provided
                if mapped_group and mapped_outcome:
                    cat_col = mapped_group
                    numeric_col = mapped_outcome
                else:
                    # Fall back to auto-detection
                    for name, dtype in zip(column_ids, column_types):
                        if _is_numeric(dtype):
                            numeric_col = name
                        elif _is_categorical(dtype):
                            cat_col = name

                if not numeric_col or not cat_col:
                    return _error(f"{test_name} requires 1 numeric column and 1 categorical column.")

                numeric_vals = _numeric_series(numeric_col)
                cat_vals = _factor_series(cat_col)
                mask = numeric_vals.notna() & cat_vals.notna() & (cat_vals.str.strip() != "")
                numeric_vals = numeric_vals[mask]
                cat_vals = cat_vals[mask]

                groups = sorted(cat_vals.unique().tolist())
                if len(groups) != 2:
                    return _error(f"{test_name} requires exactly 2 groups. Found {len(groups)}.")

                group1_mask = cat_vals == groups[0]
                group2_mask = cat_vals == groups[1]

                group1_data = numeric_vals[group1_mask].tolist()
                group2_data = numeric_vals[group2_mask].tolist()

                if not group1_data or not group2_data:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_data) < 2 or len(group2_data) < 2:
                    return _error(
                        f"Insufficient sample size. {groups[0]}: {len(group1_data)}, {groups[1]}: {len(group2_data)}. "
                        "Minimum 2 observations per group required."
                    )

                result_data['group1'] = group1_data
                result_data['group2'] = group2_data
                result_data['group1_name'] = str(groups[0])
                result_data['group2_name'] = str(groups[1])

    # -------------------------------------------------------------------------
    # Paired tests (paired t-test, Wilcoxon)
    # -------------------------------------------------------------------------
    elif test_name == 'one_sample_ttest':
        numeric_col = None
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype):
                numeric_col = name
                break
        if not numeric_col:
            return _error("One-sample t-test requires a numeric column.")
        values = _numeric_series(numeric_col).dropna().tolist()
        try:
            import sys
            preview = values[:3]
            print(
                f"[LargeMode] one_sample_ttest numeric_col={numeric_col} "
                f"non_null={len(values)} preview={preview}",
                file=sys.stderr
            )
        except Exception:
            pass
        if not values:
            return _error("No valid data after removing missing values. Check selected column.")
        result_data['values'] = values

    # -------------------------------------------------------------------------
    # Paired tests (paired t-test, Wilcoxon)
    # -------------------------------------------------------------------------
    elif test_name in ('paired_ttest', 'wilcoxon'):
        # Check for explicit column mapping from dialog (test-specific)
        if test_name == 'wilcoxon':
            paired_mapping = params.get("wilcoxon_mapping") or params.get("wilcoxonMapping") or {}
        else:
            paired_mapping = params.get("paired_ttest_mapping") or params.get("pairedTtestMapping") or {}

        if test_name == 'wilcoxon':
            warnings = []
            numeric_col = None
            cat_col = None

            id_to_type = {column_ids[i]: column_types[i] for i in range(len(column_ids))}

            def _col_type(column_id: str):
                return id_to_type.get(column_id)

            def _is_numeric_col(column_id: str) -> bool:
                return _is_numeric(_col_type(column_id))

            def _is_categorical_col(column_id: str) -> bool:
                return _is_categorical(_col_type(column_id))

            # Resolve mapping if provided
            mapped_group = _resolve_column(paired_mapping.get("group"))
            mapped_outcome = _resolve_column(paired_mapping.get("outcome"))
            pair_id_col = _resolve_column(paired_mapping.get("pair_id"))

            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            categorical_cols = [name for name, dtype in zip(column_ids, column_types) if _is_categorical(dtype)]

            is_wide_format = False
            wide_col1 = None
            wide_col2 = None

            if mapped_group and mapped_outcome:
                if _is_numeric_col(mapped_group) and _is_numeric_col(mapped_outcome):
                    is_wide_format = True
                    wide_col1 = mapped_group
                    wide_col2 = mapped_outcome
                else:
                    cat_col = mapped_group
                    numeric_col = mapped_outcome
            elif len(numeric_cols) == 2 and len(categorical_cols) == 0:
                is_wide_format = True
                wide_col1 = numeric_cols[0]
                wide_col2 = numeric_cols[1]
            else:
                # Fall back to auto-detection (long format)
                for name, dtype in zip(column_ids, column_types):
                    if _is_numeric(dtype) and numeric_col is None:
                        numeric_col = name
                    elif _is_categorical(dtype) and cat_col is None:
                        cat_col = name

            if is_wide_format:
                if not wide_col1 or not wide_col2:
                    return _error("Wilcoxon Signed-Rank Test requires two numeric columns in wide format.")

                series1 = _numeric_series(wide_col1)
                series2 = _numeric_series(wide_col2)
                mask = series1.notna() & series2.notna()
                series1 = series1[mask]
                series2 = series2[mask]

                group1_vals = series1.tolist()
                group2_vals = series2.tolist()

                if not group1_vals or not group2_vals:
                    return _error("No valid data in at least one column after removing missing values.")
                if len(group1_vals) < 2:
                    return _error(
                        f"Insufficient sample size: {len(group1_vals)} pairs. Minimum 2 pairs required."
                    )

                warnings.append(
                    "Wide format pairs rows by position. Ensure each row represents a matched pair."
                )

                result_data['group1'] = group1_vals
                result_data['group2'] = group2_vals
                result_data['group1_name'] = display_name(wide_col1)
                result_data['group2_name'] = display_name(wide_col2)
                if warnings:
                    result_data['warnings'] = warnings
            else:
                if not numeric_col or not cat_col:
                    return _error("wilcoxon requires 1 numeric column and 1 categorical column.")

                numeric_vals = _numeric_series(numeric_col)
                cat_vals = _factor_series(cat_col)
                mask = numeric_vals.notna() & cat_vals.notna() & (cat_vals.str.strip() != "")

                pair_vals = None
                if pair_id_col:
                    pair_raw = df[pair_id_col]
                    pair_vals = pair_raw.astype(str)
                    mask = mask & pair_raw.notna() & (pair_vals.str.strip() != "")

                numeric_vals = numeric_vals[mask]
                cat_vals = cat_vals[mask]
                if pair_vals is not None:
                    pair_vals = pair_vals[mask]

                # Preserve first-seen group order
                group_names = []
                group_index = {}
                for group_val in cat_vals.tolist():
                    group_str = str(group_val).strip()
                    if group_str not in group_index:
                        group_index[group_str] = len(group_names)
                        group_names.append(group_str)

                if len(group_names) != 2:
                    return _error(f"{test_name} requires exactly 2 groups. Found {len(group_names)}.")

                groups = [[] for _ in group_names]

                if pair_vals is not None:
                    pair_map = {}
                    for group_val, num_val, pair_val in zip(
                        cat_vals.tolist(),
                        numeric_vals.tolist(),
                        pair_vals.tolist(),
                    ):
                        group_str = str(group_val).strip()
                        pair_str = str(pair_val).strip()
                        entry = pair_map.get(pair_str)
                        if entry is None:
                            entry = {"values": {}, "duplicate": False}
                            pair_map[pair_str] = entry
                        if group_str in entry["values"]:
                            entry["duplicate"] = True
                        else:
                            entry["values"][group_str] = float(num_val)

                    for entry in pair_map.values():
                        if entry.get("duplicate"):
                            continue
                        has_all = True
                        for group_name in group_names:
                            if group_name not in entry["values"]:
                                has_all = False
                                break
                        if not has_all:
                            continue
                        for idx, group_name in enumerate(group_names):
                            groups[idx].append(entry["values"][group_name])
                else:
                    for group_val, num_val in zip(cat_vals.tolist(), numeric_vals.tolist()):
                        group_str = str(group_val).strip()
                        idx = group_index.get(group_str)
                        if idx is None:
                            continue
                        groups[idx].append(float(num_val))

                    warnings.append(
                        "Pair/Subject ID not provided. Pairing uses row order within each time point; ensure data are aligned."
                    )

                group1_vals = groups[0]
                group2_vals = groups[1]

                if not group1_vals or not group2_vals:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_vals) != len(group2_vals):
                    return _error(
                        f"{test_name} requires equal sample sizes. Found: {group_names[0]} (n={len(group1_vals)}), "
                        f"{group_names[1]} (n={len(group2_vals)})."
                    )
                if len(group1_vals) < 2:
                    return _error(
                        f"Insufficient sample size: {len(group1_vals)} pairs. Minimum 2 pairs required."
                    )

                result_data['group1'] = group1_vals
                result_data['group2'] = group2_vals
                result_data['group1_name'] = str(group_names[0])
                result_data['group2_name'] = str(group_names[1])
                if warnings:
                    result_data['warnings'] = warnings
        else:
            warnings = []
            numeric_col = None
            cat_col = None

            id_to_type = {column_ids[i]: column_types[i] for i in range(len(column_ids))}

            def _col_type(column_id: str):
                return id_to_type.get(column_id)

            def _is_numeric_col(column_id: str) -> bool:
                return _is_numeric(_col_type(column_id))

            # Resolve mapping if provided
            mapped_group = _resolve_column(paired_mapping.get("group"))
            mapped_outcome = _resolve_column(paired_mapping.get("outcome"))
            pair_id_col = _resolve_column(paired_mapping.get("pair_id"))

            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            categorical_cols = [name for name, dtype in zip(column_ids, column_types) if _is_categorical(dtype)]

            is_wide_format = False
            wide_col1 = None
            wide_col2 = None

            if mapped_group and mapped_outcome:
                if _is_numeric_col(mapped_group) and _is_numeric_col(mapped_outcome):
                    is_wide_format = True
                    wide_col1 = mapped_group
                    wide_col2 = mapped_outcome
                else:
                    cat_col = mapped_group
                    numeric_col = mapped_outcome
            elif len(numeric_cols) == 2 and len(categorical_cols) == 0:
                is_wide_format = True
                wide_col1 = numeric_cols[0]
                wide_col2 = numeric_cols[1]
            else:
                # Fall back to auto-detection (long format)
                for name, dtype in zip(column_ids, column_types):
                    if _is_numeric(dtype) and numeric_col is None:
                        numeric_col = name
                    elif _is_categorical(dtype) and cat_col is None:
                        cat_col = name

            if is_wide_format:
                if not wide_col1 or not wide_col2:
                    return _error("Paired t-test requires two numeric columns in wide format.")

                series1 = _numeric_series(wide_col1)
                series2 = _numeric_series(wide_col2)
                mask = series1.notna() & series2.notna()
                series1 = series1[mask]
                series2 = series2[mask]

                group1_vals = series1.tolist()
                group2_vals = series2.tolist()

                if not group1_vals or not group2_vals:
                    return _error("No valid data in at least one column after removing missing values.")
                if len(group1_vals) < 2:
                    return _error(
                        f"Insufficient sample size: {len(group1_vals)} pairs. Minimum 2 pairs required."
                    )

                warnings.append(
                    "Wide format pairs rows by position. Ensure each row represents a matched pair."
                )

                result_data['group1'] = group1_vals
                result_data['group2'] = group2_vals
                result_data['group1_name'] = display_name(wide_col1)
                result_data['group2_name'] = display_name(wide_col2)
                if warnings:
                    result_data['warnings'] = warnings
            else:
                if not numeric_col or not cat_col:
                    return _error(f"{test_name} requires 1 numeric column and 1 categorical column.")

                numeric_vals = _numeric_series(numeric_col)
                cat_vals = _factor_series(cat_col)
                mask = numeric_vals.notna() & cat_vals.notna() & (cat_vals.str.strip() != "")

                pair_vals = None
                if pair_id_col:
                    pair_raw = df[pair_id_col]
                    pair_vals = pair_raw.astype(str)
                    mask = mask & pair_raw.notna() & (pair_vals.str.strip() != "")

                numeric_vals = numeric_vals[mask]
                cat_vals = cat_vals[mask]
                if pair_vals is not None:
                    pair_vals = pair_vals[mask]

                # Preserve first-seen group order
                group_names = []
                group_index = {}
                for group_val in cat_vals.tolist():
                    group_str = str(group_val).strip()
                    if group_str not in group_index:
                        group_index[group_str] = len(group_names)
                        group_names.append(group_str)

                if len(group_names) != 2:
                    return _error(f"{test_name} requires exactly 2 groups. Found {len(group_names)}.")

                groups = [[] for _ in group_names]

                if pair_vals is not None:
                    pair_map = {}
                    for group_val, num_val, pair_val in zip(
                        cat_vals.tolist(),
                        numeric_vals.tolist(),
                        pair_vals.tolist(),
                    ):
                        group_str = str(group_val).strip()
                        pair_str = str(pair_val).strip()
                        entry = pair_map.get(pair_str)
                        if entry is None:
                            entry = {"values": {}, "duplicate": False}
                            pair_map[pair_str] = entry
                        if group_str in entry["values"]:
                            entry["duplicate"] = True
                        else:
                            entry["values"][group_str] = float(num_val)

                    for entry in pair_map.values():
                        if entry.get("duplicate"):
                            continue
                        has_all = True
                        for group_name in group_names:
                            if group_name not in entry["values"]:
                                has_all = False
                                break
                        if not has_all:
                            continue
                        for idx, group_name in enumerate(group_names):
                            groups[idx].append(entry["values"][group_name])
                else:
                    for group_val, num_val in zip(cat_vals.tolist(), numeric_vals.tolist()):
                        group_str = str(group_val).strip()
                        idx = group_index.get(group_str)
                        if idx is None:
                            continue
                        groups[idx].append(float(num_val))

                    warnings.append(
                        "Pair/Subject ID not provided. Pairing uses row order within each time point; ensure data are aligned."
                    )

                group1_vals = groups[0]
                group2_vals = groups[1]

                if not group1_vals or not group2_vals:
                    return _error("No valid data in at least one group after removing missing values.")
                if len(group1_vals) != len(group2_vals):
                    return _error(
                        f"{test_name} requires equal sample sizes. Found: {group_names[0]} (n={len(group1_vals)}), "
                        f"{group_names[1]} (n={len(group2_vals)})."
                    )
                if len(group1_vals) < 2:
                    return _error(
                        f"Insufficient sample size: {len(group1_vals)} pairs. Minimum 2 pairs required."
                    )

                result_data['group1'] = group1_vals
                result_data['group2'] = group2_vals
                result_data['group1_name'] = str(group_names[0])
                result_data['group2_name'] = str(group_names[1])
                if warnings:
                    result_data['warnings'] = warnings

    # -------------------------------------------------------------------------
    # One-sample test: single numeric column
    # -------------------------------------------------------------------------
    elif test_name == 'one_sample_ttest':
        numeric_col = None
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype):
                numeric_col = name
                break
        if not numeric_col:
            return _error("One-sample t-test requires a numeric column.")
        values = _numeric_series(numeric_col).dropna().tolist()
        if not values:
            return _error("No valid data after removing missing values. Check selected column.")
        if len(values) < 2:
            return _error(f"Insufficient sample size: {len(values)} observations. Minimum 2 required.")
        result_data['values'] = values

    # -------------------------------------------------------------------------
    # One-way ANOVA / Kruskal-Wallis: 1 numeric + 1 categorical (multiple groups)
    # -------------------------------------------------------------------------
    elif test_name in ('one_way_anova', 'kruskal_wallis'):
        # Check for explicit column mapping from dialog
        if test_name == 'one_way_anova':
            anova_mapping = params.get("one_way_anova_mapping") or params.get("oneWayAnovaMapping") or {}
        elif test_name == 'kruskal_wallis':
            anova_mapping = params.get("kruskal_wallis_mapping") or params.get("kruskalWallisMapping") or {}
        else:
            anova_mapping = {}

        numeric_col = None
        cat_col = None

        # Use explicit mapping if provided
        if anova_mapping.get("group") and anova_mapping.get("outcome"):
            cat_col = _resolve_column(anova_mapping.get("group"))
            numeric_col = _resolve_column(anova_mapping.get("outcome"))
        else:
            # Fall back to auto-detection
            for name, dtype in zip(column_ids, column_types):
                if _is_numeric(dtype):
                    numeric_col = name
                elif _is_categorical(dtype):
                    cat_col = name

        # Mirror small-dataset payload behavior: apply post-hoc settings from mapping
        if test_name == 'one_way_anova':
            if anova_mapping.get("posthoc_adjustment"):
                params["posthoc_adjustment"] = anova_mapping.get("posthoc_adjustment")
            if "control_level" in anova_mapping:
                params["control_level"] = anova_mapping.get("control_level")
            if "posthoc_q" in anova_mapping:
                params["posthoc_q"] = anova_mapping.get("posthoc_q")
        if test_name == 'kruskal_wallis':
            if anova_mapping.get("posthoc_adjustment"):
                params["posthoc_adjustment"] = anova_mapping.get("posthoc_adjustment")
            if "posthoc_q" in anova_mapping:
                params["posthoc_q"] = anova_mapping.get("posthoc_q")

        # Long format (numeric + categorical)
        if numeric_col and cat_col:
            numeric_vals = _numeric_series(numeric_col)
            cat_vals = _factor_series(cat_col)
            mask = numeric_vals.notna() & cat_vals.notna() & (cat_vals.str.strip() != "")
            numeric_vals = numeric_vals[mask]
            cat_vals = cat_vals[mask]
            groups = sorted(cat_vals.unique().tolist())
            result_groups = [
                numeric_vals[cat_vals == g].tolist()
                for g in groups
            ]

            if len(result_groups) < 2:
                return _error(f"Only {len(result_groups)} group found after removing missing values.")
            if any(len(g) == 0 for g in result_groups):
                return _error("No valid data in at least one group after removing missing values.")
            min_group_size = min(len(g) for g in result_groups)
            if min_group_size < 2:
                return _error(
                    f"Insufficient sample size in at least one group: minimum {min_group_size} observations. "
                    "Each group requires at least 2 observations."
                )

            result_data['groups'] = result_groups
            params['group_labels'] = [str(g) for g in groups]
        else:
            # Wide format (2+ numeric columns)
            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            if len(numeric_cols) < 2:
                return _error(f"{test_name} requires at least 2 numeric columns or a numeric + categorical pair.")
            numeric_df = df[numeric_cols].apply(lambda s: _numeric_series(s.name))
            mask = numeric_df.notna().all(axis=1)
            result_groups = [numeric_df.loc[mask, col].tolist() for col in numeric_cols]
            if len(result_groups) == 0 or any(len(g) == 0 for g in result_groups):
                return _error("No valid data after removing missing values. Check selected columns.")
            min_group_size = min(len(g) for g in result_groups)
            if min_group_size < 2:
                return _error(
                    f"Insufficient sample size in at least one group: minimum {min_group_size} observations. "
                    "Each group requires at least 2 observations."
                )
            result_data['groups'] = result_groups
            params['group_labels'] = [display_name(c) for c in numeric_cols]

    # -------------------------------------------------------------------------
    # Two-way ANOVA: 1 numeric + 2 categorical
    # -------------------------------------------------------------------------
    elif test_name == 'two_way_anova':
        numeric_col = None
        cat_cols = []
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype):
                numeric_col = name
            elif _is_categorical(dtype):
                cat_cols.append(name)

        mapping = params.get("factor_role_mapping") or {}
        if mapping.get("factorA") and mapping.get("factorB"):
            cat_cols = [mapping.get("factorA"), mapping.get("factorB")]

        if not numeric_col or len(cat_cols) < 2:
            return _error("Two-way ANOVA requires 1 numeric column and exactly 2 categorical factors.")

        factor1 = _resolve_column(cat_cols[0])
        factor2 = _resolve_column(cat_cols[1])
        if not factor1 or not factor2:
            return _error("Two-way ANOVA factor mapping references unknown columns.")

        dep_vals = _numeric_series(numeric_col)
        f1_vals = _factor_series(factor1)
        f2_vals = _factor_series(factor2)
        mask = dep_vals.notna() & f1_vals.notna() & f2_vals.notna() & (f1_vals.str.strip() != "") & (f2_vals.str.strip() != "")
        dep_vals = dep_vals[mask]
        f1_vals = f1_vals[mask]
        f2_vals = f2_vals[mask]

        if len(dep_vals) == 0:
            return _error("No valid data after removing missing values. Check selected columns.")
        if len(dep_vals) < 6:
            return _error(
                f"Insufficient sample size: {len(dep_vals)} observations. Two-Way ANOVA requires sufficient observations per cell."
            )

        factor1_levels = sorted(f1_vals.unique().tolist())
        factor2_levels = sorted(f2_vals.unique().tolist())

        if len(factor1_levels) < 2 or len(factor2_levels) < 2:
            return _error("Two-way ANOVA requires each factor to have at least 2 levels.")

        observed_cells = set(zip(f1_vals.tolist(), f2_vals.tolist()))
        expected_cells = [(a, b) for a in factor1_levels for b in factor2_levels]
        empty_cells = [f"{a} x {b}" for a, b in expected_cells if (a, b) not in observed_cells]

        if empty_cells:
            preview = ", ".join(empty_cells[:3])
            suffix = "..." if len(empty_cells) > 3 else ""
            return _error(
                f"Design has {len(empty_cells)} empty cell(s) out of {len(expected_cells)} total: {preview}{suffix}"
            )

        factor1_index = {value: idx for idx, value in enumerate(factor1_levels)}
        factor2_index = {value: idx for idx, value in enumerate(factor2_levels)}
        factor1_encoded = [factor1_index[value] for value in f1_vals.tolist()]
        factor2_encoded = [factor2_index[value] for value in f2_vals.tolist()]

        result_data['dependent'] = dep_vals.tolist()
        result_data['factor1'] = factor1_encoded
        result_data['factor2'] = factor2_encoded
        result_data['factor1_name'] = display_name(factor1)
        result_data['factor2_name'] = display_name(factor2)
        result_data['factor_levels'] = {
            display_name(factor1): factor1_levels,
            display_name(factor2): factor2_levels,
        }

    # -------------------------------------------------------------------------
    # Scheirer-Ray-Hare: 1 numeric + 2 categorical (nonparametric two-way ANOVA)
    # -------------------------------------------------------------------------
    elif test_name == 'scheirer_ray_hare':
        numeric_col = None
        cat_cols = []
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype) and numeric_col is None:
                numeric_col = name
            elif _is_categorical(dtype):
                cat_cols.append(name)

        mapping = params.get("factor_role_mapping") or {}
        mapped_a = _resolve_column(mapping.get("factorA") or mapping.get("primary"))
        mapped_b = _resolve_column(mapping.get("factorB") or mapping.get("secondary"))
        if mapped_a and mapped_b:
            cat_cols = [mapped_a, mapped_b]

        if not numeric_col or len(cat_cols) < 2:
            return _error("Scheirer-Ray-Hare requires 1 numeric column and exactly 2 categorical factors.")

        factor1 = _resolve_column(cat_cols[0])
        factor2 = _resolve_column(cat_cols[1])
        if not factor1 or not factor2:
            return _error("Scheirer-Ray-Hare factor mapping references unknown columns.")

        dep_vals = _numeric_series(numeric_col)
        f1_vals = _factor_series(factor1)
        f2_vals = _factor_series(factor2)
        mask = dep_vals.notna() & f1_vals.notna() & f2_vals.notna() & (f1_vals.str.strip() != "") & (f2_vals.str.strip() != "")
        dep_vals = dep_vals[mask]
        f1_vals = f1_vals[mask]
        f2_vals = f2_vals[mask]

        if len(dep_vals) == 0:
            return _error("No valid data after removing missing values. Check selected columns.")
        if len(dep_vals) < 6:
            return _error(
                f"Insufficient sample size: {len(dep_vals)} observations. Scheirer-Ray-Hare requires sufficient observations per cell."
            )

        f1_levels = sorted(f1_vals.unique().tolist())
        f2_levels = sorted(f2_vals.unique().tolist())
        if len(f1_levels) < 2 or len(f2_levels) < 2:
            return _error("Scheirer-Ray-Hare requires at least two levels for each factor.")

        # Validate minimum observations per cell (>=2) for reliable test
        cell_counts = (
            df.loc[mask, [factor1, factor2]]
            .astype(str)
            .groupby([factor1, factor2])
            .size()
        )
        if (cell_counts < 2).any():
            return _error(
                "Empty or underpowered cells detected in factorial design. Each cell requires at least 2 observations."
            )

        f1_map = {level: idx for idx, level in enumerate(f1_levels)}
        f2_map = {level: idx for idx, level in enumerate(f2_levels)}
        f1_encoded = f1_vals.map(f1_map).astype(int)
        f2_encoded = f2_vals.map(f2_map).astype(int)

        result_data['values'] = dep_vals.astype(float).tolist()
        result_data['factor1'] = f1_encoded.tolist()
        result_data['factor2'] = f2_encoded.tolist()
        result_data['factor1_name'] = display_name(factor1)
        result_data['factor2_name'] = display_name(factor2)
        result_data['factor_levels'] = {
            display_name(factor1): f1_levels,
            display_name(factor2): f2_levels,
        }
        result_data['dependent_name'] = display_name(numeric_col)
        result_data['value_name'] = display_name(numeric_col)

    # -------------------------------------------------------------------------
    # Multi-Factorial ANOVA: 1 numeric + 3+ categorical factors
    # -------------------------------------------------------------------------
    elif test_name == 'multifactorial_anova':
        from itertools import product

        numeric_col = None
        factor_cols = []
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype) and numeric_col is None:
                numeric_col = name
            elif _is_categorical(dtype):
                factor_cols.append(name)

        mapping = params.get("factor_role_mapping") or {}
        mapped_primary = _resolve_column(mapping.get("primary"))
        mapped_secondary = _resolve_column(mapping.get("secondary"))
        mapped_facets = []
        if isinstance(mapping.get("facets"), list):
            for facet in mapping.get("facets"):
                mapped_facets.append(_resolve_column(facet))

        if mapped_primary and mapped_secondary and mapped_facets and all(mapped_facets):
            factor_cols = [mapped_primary, mapped_secondary, *mapped_facets]

        if not numeric_col or len(factor_cols) < 3:
            return _error("Multi-Factorial ANOVA requires 1 numeric column and at least 3 categorical factors.")

        resolved_factors = []
        for factor in factor_cols:
            resolved = _resolve_column(factor)
            if not resolved:
                return _error("Multi-Factorial ANOVA factor mapping references unknown columns.")
            resolved_factors.append(resolved)

        dep_vals = _numeric_series(numeric_col)
        factor_series = [_factor_series(factor) for factor in resolved_factors]
        mask = dep_vals.notna()
        for series in factor_series:
            mask = mask & series.notna() & (series.str.strip() != "")

        dep_vals = dep_vals[mask]
        factor_series = [series[mask] for series in factor_series]

        if len(dep_vals) == 0:
            return _error("No valid data after removing missing values. Check selected columns.")

        factor_levels = [sorted(series.unique().tolist()) for series in factor_series]
        cell_count = 1
        for levels in factor_levels:
            cell_count *= len(levels)

        if len(dep_vals) < cell_count:
            return _error(
                f"Insufficient sample size: {len(dep_vals)} observations. Design has {cell_count} cells, "
                f"requiring at least {cell_count} observations (1 per cell)."
            )

        observed_cells = set(zip(*[series.tolist() for series in factor_series]))
        expected_cells = list(product(*factor_levels))
        empty_cells = [
            " x ".join(str(value) for value in cell)
            for cell in expected_cells
            if cell not in observed_cells
        ]

        if empty_cells:
            preview = ", ".join(empty_cells[:3])
            suffix = "..." if len(empty_cells) > 3 else ""
            return _error(
                f"Empty cells detected in factorial design. Design has {len(empty_cells)} empty cell(s) "
                f"out of {len(expected_cells)} total: {preview}{suffix}"
            )

        factor_names = [display_name(factor) for factor in resolved_factors]
        encoded_factors = {}
        factor_level_labels = {}
        for name, series, levels in zip(factor_names, factor_series, factor_levels):
            level_index = {value: idx for idx, value in enumerate(levels)}
            encoded_factors[name] = [level_index[value] for value in series.tolist()]
            factor_level_labels[name] = levels

        control_levels = params.get("control_levels")
        if isinstance(control_levels, dict):
            encoded_controls = {}
            for factor_name, level_label in control_levels.items():
                if level_label is None:
                    continue
                level_str = str(level_label)
                levels = factor_level_labels.get(factor_name, [])
                if level_str in levels:
                    encoded_controls[factor_name] = str(levels.index(level_str))
                else:
                    encoded_controls[factor_name] = level_str
            params["control_levels"] = encoded_controls

        result_data['dependent'] = dep_vals.astype(float).tolist()
        result_data['factors'] = encoded_factors
        result_data['dependent_name'] = display_name(numeric_col)
        result_data['factor_names'] = factor_names
        result_data['factor_levels'] = factor_level_labels

    # -------------------------------------------------------------------------
    # Dose-response (3PL/4PL/5PL/Compare): 2 numeric columns (dose, response)
    # -------------------------------------------------------------------------
    elif test_name in ('dose_response_3pl', 'dose_response_4pl', 'dose_response_5pl', 'dose_response_compare'):
        if len(column_ids) < 2:
            return _error("Dose-response requires exactly 2 numeric columns (dose, response).")

        dose_col = column_ids[0]
        response_col = column_ids[1]

        dose_dtype = column_types[0] if len(column_types) > 0 else None
        response_dtype = column_types[1] if len(column_types) > 1 else None
        if not _is_numeric(dose_dtype) or not _is_numeric(response_dtype):
            return _error("Dose-response requires numeric dose and response columns.")

        dose_vals = _numeric_series(dose_col)
        response_vals = _numeric_series(response_col)
        mask = dose_vals.notna() & response_vals.notna()
        dose_vals = dose_vals[mask]
        response_vals = response_vals[mask]

        if len(dose_vals) == 0:
            return _error("No valid data after removing missing values.")

        if test_name == 'dose_response_5pl':
            min_points = 6
        elif test_name == 'dose_response_compare':
            min_points = 4
        else:
            min_points = 3
        if len(dose_vals) < min_points:
            if test_name == 'dose_response_5pl':
                return _error(
                    f"Insufficient sample size: {len(dose_vals)} points. 5PL requires minimum 6 data points."
                )
            if test_name == 'dose_response_compare':
                return _error(
                    f"Insufficient sample size: {len(dose_vals)} points. Minimum 4 required."
                )
            return _error(
                f"Insufficient sample size: {len(dose_vals)} points. Minimum 3 required."
            )

        negative_count = int((dose_vals < 0).sum())
        if negative_count > 0:
            return _error(f"Dose values must be ≥ 0. Found {negative_count} negative values.")

        if test_name in ('dose_response_3pl', 'dose_response_4pl', 'dose_response_5pl'):
            ZERO_DOSE_TOLERANCE = 1e-15
            positive_doses = dose_vals[dose_vals >= ZERO_DOSE_TOLERANCE]
            control_doses = dose_vals[dose_vals < ZERO_DOSE_TOLERANCE]
            min_positive = 6 if test_name == 'dose_response_5pl' else 3

            if len(positive_doses) < min_positive:
                if test_name == 'dose_response_5pl':
                    return _error(
                        f"Need at least {min_positive} positive-dose observations (dose > 0). "
                        f"Found {len(positive_doses)}. Controls (dose=0) don't count toward minimum. "
                        "Use 4PL (requires 3) or 3PL (requires 3) for fewer points."
                        + (f" You have {len(control_doses)} control point(s)." if len(control_doses) > 0 else "")
                    )
                return _error(
                    f"Need at least {min_positive} positive-dose observations (dose > 0). "
                    f"Found {len(positive_doses)}. Controls (dose=0) don't count toward minimum."
                    + (f" You have {len(control_doses)} control point(s)." if len(control_doses) > 0 else "")
                )

        result_data['doses'] = dose_vals.astype(float).tolist()
        result_data['responses'] = response_vals.astype(float).tolist()
        result_data['dose_column'] = display_name(dose_col)
        result_data['response_column'] = display_name(response_col)

    # -------------------------------------------------------------------------
    # Synergy tests: dose_a + dose_b + response (+ optional single-agent columns)
    # -------------------------------------------------------------------------
    elif test_name in ('synergy_bliss', 'synergy_hsa', 'synergy_loewe', 'synergy_zip', 'synergy_all'):
        if len(column_ids) < 3:
            return _error(
                "Synergy requires at least 3 columns: Drug A Dose, Drug B Dose, Combined Response."
            )

        dose_a_col = column_ids[0]
        dose_b_col = column_ids[1]
        response_col = column_ids[2]
        response_a_col = column_ids[3] if len(column_ids) >= 5 else None
        response_b_col = column_ids[4] if len(column_ids) >= 5 else None

        if not _is_numeric(column_types[0]) or not _is_numeric(column_types[1]) or not _is_numeric(column_types[2]):
            return _error("Synergy requires numeric dose/response columns.")

        dose_a_series = _numeric_series(dose_a_col)
        dose_b_series = _numeric_series(dose_b_col)
        response_series = _numeric_series(response_col)
        response_a_series = _numeric_series(response_a_col) if response_a_col else None
        response_b_series = _numeric_series(response_b_col) if response_b_col else None

        mask = dose_a_series.notna() & dose_b_series.notna()
        dose_a_vals = dose_a_series[mask].astype(float).tolist()
        dose_b_vals = dose_b_series[mask].astype(float).tolist()

        if len(dose_a_vals) < 5:
            return _error(
                f"Insufficient data: {len(dose_a_vals)} rows. "
                "Synergy requires at least 5 data points (2 single-agent + combination)."
            )

        def _to_optional_float(val):
            if val is None:
                return None
            try:
                if np.isnan(val):
                    return None
            except TypeError:
                pass
            try:
                return float(val)
            except (TypeError, ValueError):
                return None

        response_vals = [_to_optional_float(val) for val in response_series[mask].tolist()]

        response_a_vals = None
        response_b_vals = None
        if response_a_series is not None:
            response_a_vals = [_to_optional_float(val) for val in response_a_series[mask].tolist()]
        if response_b_series is not None:
            response_b_vals = [_to_optional_float(val) for val in response_b_series[mask].tolist()]

        DOSE_TOLERANCE = 1e-9

        def _doses_equal(a: float, b: float) -> bool:
            return abs(a - b) < DOSE_TOLERANCE

        def _unique_sorted_with_tolerance(values: list[float]) -> list[float]:
            values_sorted = sorted(values)
            unique_vals: list[float] = []
            for value in values_sorted:
                if not unique_vals or not _doses_equal(value, unique_vals[-1]):
                    unique_vals.append(value)
            return unique_vals

        def _get_response_with_replicates(target_a: float, target_b: float):
            matching = []
            for i in range(len(dose_a_vals)):
                if _doses_equal(dose_a_vals[i], target_a) and _doses_equal(dose_b_vals[i], target_b):
                    val = response_vals[i]
                    if val is None:
                        continue
                    matching.append(val)
            if not matching:
                return None
            if len(matching) == 1:
                return matching[0], 1
            return sum(matching) / len(matching), len(matching)

        all_doses_a = _unique_sorted_with_tolerance(dose_a_vals)
        all_doses_b = _unique_sorted_with_tolerance(dose_b_vals)
        non_zero_doses_a = [d for d in all_doses_a if d > 0]
        non_zero_doses_b = [d for d in all_doses_b if d > 0]

        if len(non_zero_doses_a) < 2:
            return _error(
                f"Insufficient Drug A doses: {len(non_zero_doses_a)}. Need at least 2 non-zero dose levels."
            )
        if len(non_zero_doses_b) < 2:
            return _error(
                f"Insufficient Drug B doses: {len(non_zero_doses_b)}. Need at least 2 non-zero dose levels."
            )

        has_dose_a_zero = any(_doses_equal(d, 0) for d in all_doses_a)
        has_dose_b_zero = any(_doses_equal(d, 0) for d in all_doses_b)
        has_explicit_single_agents = response_a_vals is not None and response_b_vals is not None

        if not has_explicit_single_agents and (not has_dose_a_zero or not has_dose_b_zero):
            return _error(
                "Missing single-agent data. Provide boundary rows (dose_a=0 and dose_b=0) "
                "OR select optional response_a/response_b columns."
            )

        warnings = []
        total_replicate_cells = 0

        def _get_single_agent_a(da: float):
            boundary = _get_response_with_replicates(da, 0) if has_dose_b_zero else None
            if boundary:
                return boundary
            if response_a_vals is None:
                return None
            matching = []
            for i in range(len(dose_a_vals)):
                if _doses_equal(dose_a_vals[i], da):
                    val = response_a_vals[i]
                    if val is None:
                        continue
                    matching.append(val)
            if not matching:
                return None
            if len(matching) == 1:
                return matching[0], 1
            return sum(matching) / len(matching), len(matching)

        def _get_single_agent_b(db: float):
            boundary = _get_response_with_replicates(0, db) if has_dose_a_zero else None
            if boundary:
                return boundary
            if response_b_vals is None:
                return None
            matching = []
            for i in range(len(dose_b_vals)):
                if _doses_equal(dose_b_vals[i], db):
                    val = response_b_vals[i]
                    if val is None:
                        continue
                    matching.append(val)
            if not matching:
                return None
            if len(matching) == 1:
                return matching[0], 1
            return sum(matching) / len(matching), len(matching)

        doses_a = [0] + non_zero_doses_a
        doses_b = [0] + non_zero_doses_b

        responses_a = []
        for da in doses_a:
            if _doses_equal(da, 0):
                base = _get_response_with_replicates(0, 0)
                if not base:
                    warnings.append("Missing control response at dose_a=0, dose_b=0; assumed 0 for baseline")
                    responses_a.append(0.0)
                else:
                    responses_a.append(base[0])
                    if base[1] > 1:
                        total_replicate_cells += 1
                continue
            r = _get_single_agent_a(da)
            if not r:
                return _error(
                    f"Missing Drug A single-agent response for dose_a={da}. "
                    "Provide a boundary row (dose_b=0) or use explicit single-agent columns (responseA/responseB)."
                )
            responses_a.append(r[0])
            if r[1] > 1:
                total_replicate_cells += 1

        responses_b = []
        for db in doses_b:
            if _doses_equal(db, 0):
                base = _get_response_with_replicates(0, 0)
                if not base:
                    warnings.append("Missing control response at dose_a=0, dose_b=0; assumed 0 for baseline")
                    responses_b.append(0.0)
                else:
                    responses_b.append(base[0])
                    if base[1] > 1:
                        total_replicate_cells += 1
                continue
            r = _get_single_agent_b(db)
            if not r:
                return _error(
                    f"Missing Drug B single-agent response for dose_b={db}. "
                    "Provide a boundary row (dose_a=0) or use explicit single-agent columns (responseA/responseB)."
                )
            responses_b.append(r[0])
            if r[1] > 1:
                total_replicate_cells += 1

        combo_matrix = []
        for da in doses_a:
            row = []
            for db in doses_b:
                if _doses_equal(da, 0) and _doses_equal(db, 0):
                    row.append(responses_a[0])
                    continue
                if _doses_equal(db, 0):
                    idx = next(i for i, v in enumerate(doses_a) if _doses_equal(v, da))
                    row.append(responses_a[idx])
                    continue
                if _doses_equal(da, 0):
                    idx = next(i for i, v in enumerate(doses_b) if _doses_equal(v, db))
                    row.append(responses_b[idx])
                    continue

                cell = _get_response_with_replicates(da, db)
                if not cell:
                    return _error(f"Missing response for dose_a={da}, dose_b={db} (combination)")
                row.append(cell[0])
                if cell[1] > 1:
                    total_replicate_cells += 1
            combo_matrix.append(row)

        if total_replicate_cells > 0:
            warnings.append(
                f"Replicates detected at {total_replicate_cells} dose combinations; aggregated using mean"
            )

        def _to_inhibition(value: float) -> float:
            return 100.0 - value

        def _to_inhibition_array(values: list[float]) -> list[float]:
            return [_to_inhibition(v) for v in values]

        def _to_inhibition_matrix(matrix: list[list[float]]) -> list[list[float]]:
            return [[_to_inhibition(v) for v in row] for row in matrix]

        if test_name in ('synergy_bliss', 'synergy_hsa'):
            result_data['responses_a'] = _to_inhibition_array(responses_a)
            result_data['responses_b'] = _to_inhibition_array(responses_b)
            result_data['combo_matrix'] = _to_inhibition_matrix(combo_matrix)
            result_data['doses_a'] = doses_a
            result_data['doses_b'] = doses_b
            result_data['drug_a_name'] = display_name(dose_a_col)
            result_data['drug_b_name'] = display_name(dose_b_col)
            if warnings:
                result_data['warnings'] = warnings

        elif test_name in ('synergy_loewe', 'synergy_zip'):
            result_data['doses_a'] = doses_a
            result_data['doses_b'] = doses_b
            result_data['responses_a'] = responses_a
            result_data['responses_b'] = responses_b
            result_data['combo_matrix'] = combo_matrix
            result_data['drug_a_name'] = display_name(dose_a_col)
            result_data['drug_b_name'] = display_name(dose_b_col)
            if test_name == 'synergy_loewe':
                result_data['data_type'] = params.get('data_type', 'viability')
                result_data['fitting_method'] = params.get('fitting_method', 'log_dose')
            if warnings:
                result_data['warnings'] = warnings

        else:  # synergy_all
            result_data['analysis_type'] = 'all'
            result_data['hsa'] = {
                'responses_a': _to_inhibition_array(responses_a),
                'responses_b': _to_inhibition_array(responses_b),
                'combo_matrix': _to_inhibition_matrix(combo_matrix),
                'doses_a': doses_a,
                'doses_b': doses_b,
            }
            result_data['bliss'] = {
                'responses_a': _to_inhibition_array(responses_a),
                'responses_b': _to_inhibition_array(responses_b),
                'combo_matrix': _to_inhibition_matrix(combo_matrix),
                'doses_a': doses_a,
                'doses_b': doses_b,
            }
            result_data['loewe'] = {
                'doses_a': doses_a,
                'doses_b': doses_b,
                'responses_a': responses_a,
                'responses_b': responses_b,
                'combo_matrix': combo_matrix,
                'data_type': params.get('data_type', 'viability'),
                'fitting_method': params.get('fitting_method', 'log_dose'),
            }
            result_data['zip'] = {
                'doses_a': doses_a,
                'doses_b': doses_b,
                'responses_a': responses_a,
                'responses_b': responses_b,
                'combo_matrix': combo_matrix,
            }
            if warnings:
                result_data['warnings'] = warnings

    # -------------------------------------------------------------------------
    # Correlation tests: 2 numeric columns (pairwise deletion)
    # -------------------------------------------------------------------------
    elif test_name in ('correlation_pearson', 'correlation_spearman', 'correlation_kendall'):
        allow_binary = test_name in ('correlation_spearman', 'correlation_kendall')
        id_to_type = {cid: ctype for cid, ctype in zip(column_ids, column_types)}
        selected_cols = []
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype) or (allow_binary and _is_binary(dtype)):
                selected_cols.append(name)

        if len(selected_cols) < 2:
            return _error("Correlation requires at least 2 numeric columns.")

        import pandas as pd
        work_df = df[selected_cols].copy()
        for col in selected_cols:
            numeric_series = pd.to_numeric(work_df[col], errors='coerce')
            if allow_binary and _is_binary(id_to_type.get(col)):
                if numeric_series.notna().sum() == 0:
                    raw = work_df[col]
                    raw = raw.where(raw.notna(), pd.NA)
                    raw = raw.astype(str).str.strip()
                    raw = raw.replace({"": pd.NA, "nan": pd.NA, "NaN": pd.NA})
                    levels = sorted([v for v in raw.dropna().unique()])
                    if len(levels) >= 2:
                        mapping = {level: idx for idx, level in enumerate(levels)}
                        numeric_series = raw.map(mapping)
            work_df[col] = numeric_series

        mask = work_df.notna().all(axis=1)
        aligned = work_df.loc[mask]

        if aligned.shape[0] < 3:
            return _error(
                f"Insufficient sample size: {aligned.shape[0]} observations. Correlation requires at least 3 observations."
            )

        x_col = selected_cols[0]
        y_col = selected_cols[1]
        result_data['x'] = aligned[x_col].tolist()
        result_data['y'] = aligned[y_col].tolist()
        result_data['x_name'] = display_name(x_col)
        result_data['y_name'] = display_name(y_col)
        result_data['n_total'] = len(df)
        result_data['n_used'] = int(mask.sum())

        if len(selected_cols) >= 3:
            result_data['matrix'] = [aligned[col].tolist() for col in selected_cols]
            result_data['matrix_labels'] = [display_name(col) for col in selected_cols]

    # -------------------------------------------------------------------------
    # Linear regression: 1+ predictors (numeric or encoded categorical)
    # -------------------------------------------------------------------------
    elif test_name in ('linear_regression', 'multiple_linear_regression'):
        import pandas as pd

        factor_encodings = params.get('factorEncodings') or {}
        dep_var = params.get('dependentVariable')
        dep_var_id = _resolve_column(dep_var) if dep_var else None

        if dep_var_id is None:
            numeric_cols = [name for name, dtype in zip(column_ids, column_types)
                           if _is_numeric(dtype)]
            if not numeric_cols:
                return _error("Linear regression requires a numeric dependent variable.")
            dep_var_id = numeric_cols[0]

        predictor_ids = [cid for cid in column_ids if cid != dep_var_id]
        if not predictor_ids:
            return _error("Linear regression requires at least one predictor.")

        id_to_type = {cid: ctype for cid, ctype in zip(column_ids, column_types)}
        work_df = df[[dep_var_id] + predictor_ids].copy()
        work_df['_y'] = pd.to_numeric(work_df[dep_var_id], errors='coerce')

        predictor_names = []
        predictor_encodings = {}
        predictors = {}
        dummy_variable_info = {}
        warnings = []
        warnings = []
        mask = work_df['_y'].notna()

        def _normalize_key(value):
            return str(value).strip().lower()

        def _build_categorical_encoding(series, user_encoding=None):
            if user_encoding:
                encoding = {}
                reverse = {}
                for level, code in user_encoding.items():
                    encoding[_normalize_key(level)] = code
                    reverse[code] = level
                baseline_entry = next((level for level, code in user_encoding.items() if code == 0), None)
                baseline_label = baseline_entry or reverse.get(0) or list(reverse.values())[0]
                dummy_levels = [
                    level for level, code in sorted(user_encoding.items(), key=lambda item: item[1]) if code != 0
                ]
                return encoding, reverse, baseline_label, dummy_levels

            normalized_to_display = {}
            for val in series.dropna().astype(str):
                display_val = val.strip()
                if display_val == "":
                    continue
                normalized_to_display.setdefault(display_val.lower(), display_val)

            sorted_keys = sorted(normalized_to_display.keys())
            if len(sorted_keys) < 2:
                return None, None, None, None

            encoding = {}
            reverse = {}
            for idx, key in enumerate(sorted_keys):
                encoding[key] = idx
                reverse[idx] = normalized_to_display[key]

            baseline_label = reverse[0]
            dummy_levels = [reverse[idx] for idx in range(1, len(sorted_keys))]
            return encoding, reverse, baseline_label, dummy_levels

        for pid in predictor_ids:
            display = display_name(pid)
            col_type = id_to_type.get(pid)
            series = work_df[pid]

            if _is_categorical(col_type):
                encoding_override = None
                if isinstance(factor_encodings, dict):
                    encoding_override = factor_encodings.get(display) or factor_encodings.get(pid)

                encoding, reverse, baseline_label, dummy_levels = _build_categorical_encoding(series, encoding_override)
                if encoding is None:
                    return _error(f"Predictor '{display}' must have at least 2 unique values.")

                predictor_encodings[display] = encoding
                dummy_variable_info[display] = {
                    "baselineLevel": baseline_label,
                    "dummyLevels": dummy_levels,
                }

                codes = series.astype(str).map(lambda v: encoding.get(_normalize_key(v)))
                mask &= codes.notna()

                for level in dummy_levels:
                    dummy_name = f"{display}_{level}"
                    predictor_names.append(dummy_name)
                    predictors[dummy_name] = (codes == encoding.get(_normalize_key(level))).astype(int)
            else:
                numeric_series = pd.to_numeric(series, errors='coerce')
                mask &= numeric_series.notna()
                predictor_names.append(display)
                predictors[display] = numeric_series

        valid_rows = int(mask.sum())
        if valid_rows == 0:
            return _error("No valid data after removing missing values. Check selected columns.")

        min_sample_size = max(10, len(predictor_ids) + 2)
        if valid_rows < min_sample_size:
            return _error(
                f"Insufficient sample size: {valid_rows} observations. With {len(predictor_ids)} predictors, "
                f"need at least {min_sample_size} observations."
            )

        y_values = work_df.loc[mask, '_y'].tolist()

        force_multiple = test_name == 'linear_regression' and len(predictor_names) > 1
        if force_multiple:
            warnings.append(
                "Simple Linear Regression requires a single predictor. The selected predictor expands into "
                "multiple dummy variables; running Multiple Linear Regression."
            )

        if test_name == 'linear_regression' and not force_multiple:
            predictor_name = predictor_names[0] if predictor_names else None
            if predictor_name is None:
                return _error("Linear regression requires at least one predictor.")
            result_data['x'] = predictors[predictor_name].loc[mask].tolist()
            result_data['y'] = y_values
            result_data['predictor_name'] = predictor_name
        else:
            X = []
            for _, row in work_df.loc[mask].iterrows():
                X.append([predictors[name].loc[row.name] for name in predictor_names])
            result_data['X'] = X
            result_data['y'] = y_values
            result_data['predictor_names'] = predictor_names
            if predictor_encodings:
                result_data['categorical_mappings'] = predictor_encodings

        result_data['dependent_name'] = display_name(dep_var_id)
        if dummy_variable_info:
            result_data['dummy_variable_info'] = dummy_variable_info
        if warnings:
            result_data['warnings'] = warnings

    # -------------------------------------------------------------------------
    # Logistic regression: categorical outcome + predictors
    # -------------------------------------------------------------------------
    elif test_name in ('logistic_regression', 'logistic_multinomial'):
        import pandas as pd

        factor_encodings = params.get('factorEncodings') or {}
        outcome_encoding = params.get('outcomeEncoding') or {}

        dep_var = params.get('dependentVariable')
        dep_var_id = _resolve_column(dep_var) if dep_var else None

        if dep_var_id is None:
            cat_candidates = [name for name, dtype in zip(column_ids, column_types)
                              if _is_categorical(dtype)]
            dep_var_id = cat_candidates[0] if cat_candidates else column_ids[0]

        predictor_ids = [cid for cid in column_ids if cid != dep_var_id]
        if not predictor_ids:
            return _error("Logistic regression requires at least one predictor.")

        if not (isinstance(outcome_encoding, dict) and outcome_encoding):
            return _error(
                "Logistic regression requires outcome encoding to be specified. "
                "Please select a baseline level for the dependent variable."
            )

        id_to_type = {cid: ctype for cid, ctype in zip(column_ids, column_types)}
        work_df = df[[dep_var_id] + predictor_ids].copy()

        def _normalize_key(value):
            return str(value).strip().lower()

        dependent_mapping = {}
        dependent_reverse = {}
        for level, code in outcome_encoding.items():
            dependent_mapping[_normalize_key(level)] = code
            dependent_reverse[code] = level

        work_df['_y'] = work_df[dep_var_id].astype(str).map(lambda v: dependent_mapping.get(_normalize_key(v)))
        mask = work_df['_y'].notna()

        predictor_names = []
        predictor_encodings = {}
        predictors = {}
        dummy_variable_info = {}

        def _build_categorical_encoding(series, user_encoding=None):
            if user_encoding:
                encoding = {}
                reverse = {}
                for level, code in user_encoding.items():
                    encoding[_normalize_key(level)] = code
                    reverse[code] = level
                baseline_entry = next((level for level, code in user_encoding.items() if code == 0), None)
                baseline_label = baseline_entry or reverse.get(0) or list(reverse.values())[0]
                dummy_levels = [
                    level for level, code in sorted(user_encoding.items(), key=lambda item: item[1]) if code != 0
                ]
                return encoding, reverse, baseline_label, dummy_levels

            normalized_to_display = {}
            for val in series.dropna().astype(str):
                display_val = val.strip()
                if display_val == "":
                    continue
                normalized_to_display.setdefault(display_val.lower(), display_val)

            sorted_keys = sorted(normalized_to_display.keys())
            if len(sorted_keys) < 2:
                return None, None, None, None

            encoding = {}
            reverse = {}
            for idx, key in enumerate(sorted_keys):
                encoding[key] = idx
                reverse[idx] = normalized_to_display[key]

            baseline_label = reverse[0]
            dummy_levels = [reverse[idx] for idx in range(1, len(sorted_keys))]
            return encoding, reverse, baseline_label, dummy_levels

        for pid in predictor_ids:
            display = display_name(pid)
            col_type = id_to_type.get(pid)
            series = work_df[pid]

            if _is_categorical(col_type):
                encoding_override = None
                if isinstance(factor_encodings, dict):
                    encoding_override = factor_encodings.get(display) or factor_encodings.get(pid)

                encoding, reverse, baseline_label, dummy_levels = _build_categorical_encoding(series, encoding_override)
                if encoding is None:
                    return _error(f"Predictor '{display}' must have at least 2 unique values.")

                predictor_encodings[display] = encoding
                dummy_variable_info[display] = {
                    "baselineLevel": baseline_label,
                    "dummyLevels": dummy_levels,
                }

                codes = series.astype(str).map(lambda v: encoding.get(_normalize_key(v)))
                mask &= codes.notna()

                for level in dummy_levels:
                    dummy_name = f"{display}_{level}"
                    predictor_names.append(dummy_name)
                    predictors[dummy_name] = (codes == encoding.get(_normalize_key(level))).astype(int)
            else:
                numeric_series = pd.to_numeric(series, errors='coerce')
                mask &= numeric_series.notna()
                predictor_names.append(display)
                predictors[display] = numeric_series

        valid_rows = int(mask.sum())
        if valid_rows == 0:
            return _error("No valid data after removing missing values. Check selected columns.")

        min_sample_size = max(10, len(predictor_ids) + 2)
        if valid_rows < min_sample_size:
            return _error(
                f"Insufficient sample size: {valid_rows} observations. With {len(predictor_ids)} predictors, "
                f"need at least {min_sample_size} observations."
            )

        X = []
        for _, row in work_df.loc[mask].iterrows():
            X.append([predictors[name].loc[row.name] for name in predictor_names])

        y_values = work_df.loc[mask, '_y'].astype(int).tolist()
        result_data['y'] = y_values
        result_data['X'] = X
        result_data['predictor_names'] = predictor_names
        result_data['dependent_name'] = display_name(dep_var_id)

        if predictor_names and y_values:
            event_counts = {}
            for val in y_values:
                event_counts[val] = event_counts.get(val, 0) + 1
            min_event_count = min(event_counts.values())
            required_min_events = len(predictor_names) * 10
            if min_event_count < required_min_events:
                if test_name == 'logistic_regression':
                    warnings.append(
                        f"Low event count: minority class has {min_event_count} observations for "
                        f"{len(predictor_names)} predictors (recommended ≥ {required_min_events}). "
                        "Estimates/p-values may be unstable; consider fewer predictors or more data."
                    )
                else:
                    warnings.append(
                        f"Low event count: smallest outcome class has {min_event_count} observations for "
                        f"{len(predictor_names)} predictors (recommended ≥ {required_min_events} per class). "
                        "Estimates/p-values may be unstable; consider fewer predictors or more data."
                    )

        if predictor_encodings:
            result_data['categorical_mappings'] = predictor_encodings
        result_data['dependent_mapping'] = dependent_mapping
        result_data['dependent_reverse'] = dependent_reverse
        if dummy_variable_info:
            result_data['dummy_variable_info'] = dummy_variable_info
        if warnings:
            result_data['warnings'] = warnings

    # -------------------------------------------------------------------------
    # Categorical tests: Chi-Square, Fisher, McNemar, GOF
    # -------------------------------------------------------------------------
    elif test_name in ('chi_square', 'fishers_exact', 'mcnemar'):
        cat_cols = [name for name, dtype in zip(column_ids, column_types)
                    if _is_categorical(dtype)]

        def _resolve_column(value):
            if not value:
                return None
            if value in column_ids:
                return value
            if value in name_to_id:
                return name_to_id[value]
            return None

        row_col_ids = None
        if test_name == 'chi_square':
            chi_square_mapping = params.get('chi_square_mapping') or params.get('chiSquareMapping') or {}
            group_id = _resolve_column(chi_square_mapping.get('group'))
            outcome_id = _resolve_column(chi_square_mapping.get('outcome'))
            if group_id and outcome_id:
                row_col_ids = (group_id, outcome_id)
        elif test_name == 'fishers_exact':
            fisher_mapping = params.get('fisher_mapping') or params.get('fisherMapping') or {}
            group_id = _resolve_column(fisher_mapping.get('group'))
            outcome_id = _resolve_column(fisher_mapping.get('outcome'))
            if group_id and outcome_id:
                row_col_ids = (group_id, outcome_id)
        elif test_name == 'mcnemar':
            mcnemar_mapping = params.get('mcnemar_mapping') or params.get('mcnemarMapping') or {}
            before_id = _resolve_column(mcnemar_mapping.get('before'))
            after_id = _resolve_column(mcnemar_mapping.get('after'))
            if before_id and after_id:
                row_col_ids = (before_id, after_id)

        if len(cat_cols) >= 2:
            row_id, col_id = row_col_ids or (cat_cols[0], cat_cols[1])
            counts = data_provider.get_contingency_counts(row_id, col_id)
            row_labels = counts.get('row_labels', [])
            col_labels = counts.get('col_labels', [])
            observed = counts.get('observed', [])

            if len(row_labels) < 2 or len(col_labels) < 2:
                return _error("Contingency table requires at least 2 categories per variable.")

            if test_name == 'fishers_exact' and (len(row_labels) != 2 or len(col_labels) != 2):
                return _error(
                    "Fisher's Exact Test requires a 2×2 contingency table. "
                    f"Got {len(row_labels)}×{len(col_labels)}."
                )

            if test_name == 'mcnemar':
                if len(row_labels) != 2 or len(col_labels) != 2:
                    return _error(
                        "McNemar's Test requires a 2×2 contingency table with identical row/column labels."
                    )
                row_labels_lower = [str(label).strip().lower() for label in row_labels]
                col_labels_lower = [str(label).strip().lower() for label in col_labels]
                if row_labels_lower != col_labels_lower:
                    return _error(
                        "McNemar's Test requires identical category labels for before/after columns."
                    )

            if test_name == 'chi_square':
                result_data['observed'] = observed
            else:
                result_data['table'] = observed
            result_data['row_labels'] = row_labels
            result_data['col_labels'] = col_labels
            result_data['row_variable'] = display_name(row_id)
            result_data['col_variable'] = display_name(col_id)

    elif test_name == 'chi_square_gof':
        import pandas as pd

        GOF_CATEGORY_COUNTS_SENTINEL = "__CATEGORY_COUNTS__"
        gof_mapping = params.get("gof_mapping") or params.get("gofMapping") or {}

        def _resolve_column(value):
            if not value:
                return None
            if value in column_ids:
                return value
            if value in name_to_id:
                return name_to_id[value]
            return None

        observed_key = gof_mapping.get("observed")
        category_key = gof_mapping.get("category")
        expected_key = gof_mapping.get("expected")

        if observed_key == GOF_CATEGORY_COUNTS_SENTINEL:
            category_id = _resolve_column(category_key)
            if category_id:
                values = pd.Series(data_provider.get_column(category_id)).dropna().astype(str)
                if not values.empty:
                    categories = pd.unique(values)
                    observed = [int((values == cat).sum()) for cat in categories]
                    expected = params.get('expected') or None
                    if expected is not None:
                        if not isinstance(expected, list):
                            return _error("Expected frequencies must be an array of numbers.")
                        if len(expected) != len(observed):
                            return _error(
                                f"Expected frequencies length ({len(expected)}) must match observed categories ({len(observed)})."
                            )
                        if any((not isinstance(e, (int, float)) or e <= 0) for e in expected):
                            return _error("All expected frequencies must be positive numbers.")
                    result_data['observed'] = observed
                    result_data['expected'] = expected
                    result_data['category_labels'] = [str(cat) for cat in categories]
                    result_data['value_column'] = display_name(category_id)
                    result_data['column_name'] = display_name(category_id)
        elif observed_key:
            observed_id = _resolve_column(observed_key)
            if observed_id:
                expected_id = _resolve_column(expected_key)
                category_id = _resolve_column(category_key)

                observed_series = pd.to_numeric(df[observed_id], errors='coerce')
                mask = observed_series.notna() & (observed_series >= 0)

                expected_series = None
                if expected_id:
                    expected_series = pd.to_numeric(df[expected_id], errors='coerce')
                    mask &= expected_series.notna() & (expected_series > 0)

                observed = observed_series[mask].astype(float).tolist()
                if expected_series is not None:
                    expected = expected_series[mask].astype(float).tolist()
                else:
                    expected = params.get('expected') or None

                if expected is not None:
                    if not isinstance(expected, list):
                        return _error("Expected frequencies must be an array of numbers.")
                    if len(expected) != len(observed):
                        return _error(
                            f"Expected frequencies length ({len(expected)}) must match observed categories ({len(observed)})."
                        )
                    if any((not isinstance(e, (int, float)) or e <= 0) for e in expected):
                        return _error("All expected frequencies must be positive numbers.")

                if category_id:
                    category_labels = df[category_id].astype(str)[mask].tolist()
                else:
                    category_labels = [f"Category {idx + 1}" for idx in range(len(observed))]

                result_data['observed'] = observed
                result_data['expected'] = expected
                result_data['category_labels'] = category_labels
                result_data['value_column'] = display_name(category_id) if category_id else display_name(observed_id)
                result_data['column_name'] = result_data['value_column']
        else:
            cat_cols = [name for name, dtype in zip(column_ids, column_types)
                        if _is_categorical(dtype)]
            if cat_cols:
                values = pd.Series(data_provider.get_column(cat_cols[0])).dropna().astype(str)
                if not values.empty:
                    categories = pd.unique(values)
                    observed = [int((values == cat).sum()) for cat in categories]
                    result_data['observed'] = observed
                    result_data['expected'] = params.get('expected') or None
                    result_data['category_labels'] = [str(cat) for cat in categories]
                    result_data['value_column'] = display_name(cat_cols[0])
                    result_data['column_name'] = display_name(cat_cols[0])

    # -------------------------------------------------------------------------
    # Descriptive stats: single or multiple numeric columns
    # -------------------------------------------------------------------------
    elif test_name == 'descriptive_stats':
        numeric_cols = [name for name, dtype in zip(column_ids, column_types)
                       if _is_numeric(dtype)]
        if not numeric_cols:
            return _error("Descriptive statistics requires a numeric column.")
        values = df[numeric_cols[0]].dropna().tolist()
        if len(values) < 2:
            return _error(
                f"Insufficient sample size: {len(values)} observation(s). Minimum 2 observations required."
            )
        result_data['values'] = values
        result_data['column_name'] = display_name(numeric_cols[0])
        result_data['variable_name'] = display_name(numeric_cols[0])

    # -------------------------------------------------------------------------
    # Normality tests: single numeric column
    # -------------------------------------------------------------------------
    elif test_name in ('normality_shapiro', 'normality_ks', 'normality_ad', 'normality_cvm', 'normality_jb', 'normality_all', 'normality_tests', 'outlier_detection'):
        numeric_col = None
        for name, dtype in zip(column_ids, column_types):
            if _is_numeric(dtype):
                numeric_col = name
                break
        if not numeric_col:
            return _error("Normality/outlier tests require a numeric column.")

        values = df[numeric_col].dropna().tolist()

        min_required = 3
        if test_name in ('normality_ad', 'normality_all', 'normality_tests'):
            min_required = 8
        elif test_name == 'normality_jb':
            min_required = 4
        elif test_name == 'outlier_detection':
            min_required = 4

        if len(values) < min_required:
            if test_name == 'normality_ad':
                return _error(
                    f"Insufficient sample size: {len(values)} observations. Anderson-Darling requires at least 8 observations."
                )
            if test_name in ('normality_all', 'normality_tests'):
                return _error(
                    f"Insufficient sample size: {len(values)} observations. Combined normality tests require at least 8 observations."
                )
            if test_name == 'normality_jb':
                return _error(
                    f"Insufficient sample size: {len(values)} observations. Jarque-Bera requires at least 4 observations."
                )
            if test_name == 'outlier_detection':
                return _error(
                    f"Insufficient sample size: {len(values)} observations. Outlier detection requires at least 4 observations."
                )
            return _error(
                f"Insufficient sample size: {len(values)} observations. Normality tests require at least 3 observations."
            )

        result_data['values'] = values
        result_data['column_name'] = display_name(numeric_col)
        result_data['variable_name'] = display_name(numeric_col)

    # -------------------------------------------------------------------------
    # Survival analysis: time + event + (group OR covariates)
    # -------------------------------------------------------------------------
    elif test_name in ['kaplan_meier', 'cox_regression', 'nelson_aalen']:
        import numpy as np
        import pandas as pd

        # Survival analysis: mirror small-dataset row-level validation.
        time_col_id = column_ids[0]
        event_col_id = column_ids[1]
        extra_cols = column_ids[2:]
        cols = [time_col_id, event_col_id] + extra_cols

        df_sub = df[cols].copy()

        def _js_string(value):
            if value is True:
                return "true"
            if value is False:
                return "false"
            if isinstance(value, (int, np.integer)):
                return str(int(value))
            if isinstance(value, (float, np.floating)):
                if np.isnan(value):
                    return ""
                if float(value).is_integer():
                    return str(int(value))
            return str(value)

        def _normalize_cell(value):
            if value is None:
                return np.nan
            if isinstance(value, float) and pd.isna(value):
                return np.nan
            if isinstance(value, (np.floating,)) and np.isnan(value):
                return np.nan
            if isinstance(value, str):
                stripped = value.strip()
                return np.nan if stripped == "" else stripped
            return value

        for col in cols:
            if df_sub[col].dtype == object or pd.api.types.is_string_dtype(df_sub[col]):
                df_sub[col] = df_sub[col].apply(_normalize_cell)

        # Optional manual event encoding from parameters (for custom binary labels)
        event_encoding = normalize_event_encoding(params.get('event_encoding'))
        def normalize_event_value(v):
            if v is None or (isinstance(v, float) and pd.isna(v)):
                return np.nan
            if event_encoding:
                key = str(v).strip().lower()
                if key == str(event_encoding.get('event_value', '')).strip().lower():
                    return 1
                if key == str(event_encoding.get('censored_value', '')).strip().lower():
                    return 0
            if isinstance(v, bool):
                return 1 if v else 0
            if isinstance(v, (int, np.integer)) and v in (0, 1):
                return int(v)
            if isinstance(v, (float, np.floating)) and v in (0.0, 1.0):
                return int(v)
            key = str(v).strip().lower()
            if key in ('1', 'true'):
                return 1
            if key in ('0', 'false'):
                return 0
            try:
                numeric = float(key)
            except Exception:
                return np.nan
            if numeric in (0.0, 1.0):
                return int(numeric)
            return np.nan

        time_series = pd.to_numeric(df_sub[time_col_id], errors='coerce')
        events_series = df_sub[event_col_id].apply(normalize_event_value)
        valid_mask = time_series.notna() & (time_series >= 0) & events_series.isin([0, 1])

        group_series = None
        group_col_id = None
        if test_name in ['kaplan_meier', 'nelson_aalen'] and len(extra_cols) > 0:
            group_col_id = extra_cols[0]
            group_series = df_sub[group_col_id].apply(
                lambda v: np.nan if v is None or (isinstance(v, float) and pd.isna(v)) else _js_string(v).strip()
            )
            group_series = group_series.replace('', np.nan)
            valid_mask &= group_series.notna()

        covariate_specs = []
        if test_name == 'cox_regression' and len(extra_cols) > 0:
            id_to_type = {column_ids[i]: column_types[i] for i in range(len(column_ids))}

            def _col_type(column_id: str):
                return id_to_type.get(column_id)

            def _is_categorical_col(column_id: str) -> bool:
                return _is_categorical(_col_type(column_id))

            covariate_encodings = params.get("covariate_encodings") or {}

            for col_id in extra_cols:
                cov_name = display_name(col_id)
                raw_series = df_sub[col_id]
                encoding = covariate_encodings.get(cov_name) or covariate_encodings.get(col_id)

                if encoding:
                    def _normalize_covariate_value(v):
                        true_val = encoding.get("trueValue") or encoding.get("eventValue")
                        false_val = encoding.get("falseValue") or encoding.get("censoredValue")
                        if v is None or (isinstance(v, float) and pd.isna(v)):
                            return np.nan
                        if true_val is None or false_val is None:
                            return v
                        key = str(v).strip().lower()
                        if key == str(true_val).strip().lower():
                            return 1
                        if key == str(false_val).strip().lower():
                            return 0
                        if isinstance(v, bool):
                            return 1 if v else 0
                        if key in ('1', 'true'):
                            return 1
                        if key in ('0', 'false'):
                            return 0
                        try:
                            numeric = float(key)
                        except Exception:
                            return np.nan
                        if numeric in (0.0, 1.0):
                            return int(numeric)
                        return np.nan

                    mapped_series = raw_series.apply(_normalize_covariate_value)
                    valid_mask &= mapped_series.isin([0, 1])
                    covariate_specs.append(("binary", cov_name, mapped_series))
                    continue

                if _is_categorical_col(col_id):
                    cat_series = raw_series.apply(
                        lambda v: np.nan if v is None or (isinstance(v, float) and pd.isna(v)) else _js_string(v).strip()
                    )
                    cat_series = cat_series.replace('', np.nan)
                    levels = sorted(set(cat_series.dropna().tolist()))
                    if len(levels) < 2:
                        return _error(
                            f"Covariate '{cov_name}' has only {len(levels)} level. Need at least 2 for regression."
                        )
                    valid_mask &= cat_series.notna()
                    covariate_specs.append(("categorical", cov_name, cat_series, levels))
                else:
                    num_series = pd.to_numeric(raw_series, errors='coerce')
                    valid_mask &= num_series.notna()
                    covariate_specs.append(("numeric", cov_name, num_series))

        if not valid_mask.any():
            return _error("No valid data after removing missing values. Check selected columns.")

        time_series = time_series.loc[valid_mask]
        events_series = events_series.loc[valid_mask].astype(int)

        result_data = {
            'times': time_series.tolist(),
            'events': events_series.tolist(),
            'time_name': display_name(time_col_id),
            'event_name': display_name(event_col_id),
        }

        if group_series is not None and group_col_id is not None:
            groups = group_series.loc[valid_mask].tolist()
            result_data['groups'] = groups
            result_data['group_name'] = display_name(group_col_id)
            group_levels = sorted({str(v) for v in groups if str(v).strip() != ""})
            result_data['group_levels'] = group_levels
            if len(group_levels) < 2:
                return _error("Group column must have at least 2 levels for comparison.")
            if len(group_levels) > 10:
                return _error(
                    f"Group column has too many levels ({len(group_levels)}). Maximum 10 groups allowed."
                )

        if test_name == 'cox_regression' and covariate_specs:
            covariates = {}
            covariate_names = []

            for spec in covariate_specs:
                if spec[0] == "numeric":
                    _, cov_name, series = spec
                    covariates[cov_name] = series.loc[valid_mask].astype(float).tolist()
                    covariate_names.append(cov_name)
                elif spec[0] == "binary":
                    _, cov_name, series = spec
                    covariates[cov_name] = series.loc[valid_mask].astype(int).tolist()
                    covariate_names.append(cov_name)
                else:
                    _, cov_name, series, levels = spec
                    series = series.loc[valid_mask]
                    baseline = levels[0]
                    dummy_levels = levels[1:]
                    for level in dummy_levels:
                        dummy_name = f"{cov_name}_{level}"
                        covariates[dummy_name] = (series == level).astype(int).tolist()
                        covariate_names.append(dummy_name)

            result_data['covariates'] = covariates
            result_data['covariate_names'] = covariate_names

        if test_name == 'nelson_aalen':
            result_data['custom_time_points'] = params.get('custom_time_points') or []

        # Enforce minimum sample sizes and event counts (match TS modules)
        valid_rows = len(result_data.get('times', []))
        n_events = int(sum(result_data.get('events', [])))

        if test_name in ['kaplan_meier', 'nelson_aalen']:
            if valid_rows < 10:
                return _error(
                    f"Insufficient sample size: {valid_rows} observations. {test_name.replace('_', ' ').title()} requires at least 10 observations."
                )
            if n_events == 0:
                return _error("No events observed in data. All observations are censored.")

        elif test_name == 'cox_regression':
            covariate_names = result_data.get('covariate_names') or []
            param_count = len(covariate_names)
            if valid_rows < param_count * 10:
                return _error(
                    f"Insufficient sample size: {valid_rows} observations. With {param_count} model parameters, need at least {param_count * 10} observations."
                )
            if n_events == 0:
                return _error("No events observed in data. All observations are censored.")
            if n_events < param_count * 5:
                return _error(
                    f"Insufficient events: {n_events} events observed. With {param_count} model parameters, need at least {param_count * 5} events."
                )

    # -------------------------------------------------------------------------
    # Mediation/Moderation (Models 4, 1, 7): listwise deletion + encoding parity
    # -------------------------------------------------------------------------
    elif test_name in ('mediation_model4', 'moderation_model1', 'moderated_mediation_model7'):
        import pandas as pd

        def _resolve_local_index(value, fallback):
            if not value:
                return fallback
            if value in column_ids:
                return column_ids.index(value)
            if value in name_to_id:
                return column_ids.index(name_to_id[value])
            for idx, name in enumerate(column_names):
                if name == value:
                    return idx
            return fallback

        def _normalize_value(value, encoding=None):
            if value is None:
                return None
            if isinstance(value, float) and pd.isna(value):
                return None
            if isinstance(value, str) and value.strip() == "":
                return None
            if encoding:
                key = str(value)
                if key in encoding:
                    return encoding[key]
                return None
            if isinstance(value, bool):
                return 1 if value else 0
            num = pd.to_numeric(value, errors='coerce')
            if pd.isna(num):
                return None
            return float(num)

        # Resolve core columns by order (or by provided names for Model 7)
        if test_name == 'moderated_mediation_model7':
            predictor_name = params.get('predictor_name')
            moderator_name = params.get('moderator_name')
            mediator_name = params.get('mediator_name')
            outcome_name = params.get('outcome_name')

            iv_idx = _resolve_local_index(predictor_name, 0)
            moderator_idx = _resolve_local_index(moderator_name, 1)
            mediator_idx = _resolve_local_index(mediator_name, 2)
            dv_idx = _resolve_local_index(outcome_name, 3)
            core_indices = [iv_idx, moderator_idx, mediator_idx, dv_idx]
            covariate_indices = [idx for idx in range(len(column_ids)) if idx not in core_indices]
        else:
            iv_idx = 0
            mediator_idx = 1 if test_name == 'mediation_model4' else None
            moderator_idx = 1 if test_name == 'moderation_model1' else None
            dv_idx = 2
            core_indices = [iv_idx, dv_idx]
            if mediator_idx is not None:
                core_indices.insert(1, mediator_idx)
            if moderator_idx is not None:
                core_indices.insert(1, moderator_idx)
            covariate_indices = list(range(3, len(column_ids)))

        if max(core_indices, default=0) >= len(column_ids):
            return _error("Selected mediation/moderation columns could not be mapped.")

        iv_col = column_ids[iv_idx]
        dv_col = column_ids[dv_idx]
        iv_name = display_name(iv_col)
        dv_name = display_name(dv_col)
        mediator_col = column_ids[mediator_idx] if mediator_idx is not None else None
        moderator_col = column_ids[moderator_idx] if moderator_idx is not None else None

        categorical_encodings = {}

        # Binary encodings for core variables
        def _build_binary_encoding(param_key, col_name):
            encoding = params.get(param_key)
            if isinstance(encoding, dict):
                event_value = encoding.get('eventValue') or encoding.get('event_value')
                censored_value = encoding.get('censoredValue') or encoding.get('censored_value')
                if event_value is not None and censored_value is not None:
                    categorical_encodings[col_name] = {
                        str(censored_value): 0,
                        str(event_value): 1,
                    }
            return categorical_encodings.get(col_name)

        iv_encoding = _build_binary_encoding('iv_encoding', iv_name)
        mediator_encoding = None
        if mediator_col is not None:
            mediator_encoding = _build_binary_encoding('mediator_encoding', display_name(mediator_col))
        moderator_encoding = None
        if moderator_col is not None:
            moderator_encoding = _build_binary_encoding('moderator_encoding', display_name(moderator_col))
        dv_encoding = _build_binary_encoding('dv_encoding', dv_name)

        # Covariate encodings (binary only; multi-level dummy encoded later)
        covariate_meta = []
        for idx, cov_idx in enumerate(covariate_indices):
            cov_col_id = column_ids[cov_idx]
            cov_col_name = display_name(cov_col_id)
            encoding = params.get(f'covariate_{idx}_encoding')
            cov_encoding = None
            if isinstance(encoding, dict):
                event_value = encoding.get('eventValue') or encoding.get('event_value')
                censored_value = encoding.get('censoredValue') or encoding.get('censored_value')
                if event_value is not None and censored_value is not None:
                    cov_encoding = {
                        str(censored_value): 0,
                        str(event_value): 1,
                    }
                    categorical_encodings[cov_col_name] = cov_encoding
            covariate_meta.append({
                "idx": cov_idx,
                "name": cov_col_name,
                "type": column_types[cov_idx] if cov_idx < len(column_types) else None,
                "encoding": cov_encoding,
                "param_index": idx,
            })

        # Listwise deletion
        valid_indices = []
        for row_idx, row in df.iterrows():
            x_val = _normalize_value(row[iv_col], iv_encoding)
            y_val = _normalize_value(row[dv_col], dv_encoding)

            if x_val is None or y_val is None:
                continue

            if mediator_col is not None:
                m_val = _normalize_value(row[mediator_col], mediator_encoding)
                if m_val is None:
                    continue
            if moderator_col is not None:
                w_val = _normalize_value(row[moderator_col], moderator_encoding)
                if w_val is None:
                    continue

            cov_ok = True
            for cov in covariate_meta:
                cov_val = row[column_ids[cov["idx"]]]
                if _is_categorical(cov["type"]) and cov.get("encoding") is None:
                    # Multi-level categorical: require non-missing string
                    if cov_val is None or (isinstance(cov_val, str) and cov_val.strip() == ""):
                        cov_ok = False
                        break
                    continue
                if _normalize_value(cov_val, cov.get("encoding")) is None:
                    cov_ok = False
                    break
            if not cov_ok:
                continue

            valid_indices.append(row_idx)

        if len(valid_indices) == 0:
            return _error("No valid data after removing missing values. Check selected columns.")
        if len(valid_indices) < 20:
            return _error(
                f"Insufficient sample size: {len(valid_indices)} observations. Minimum required: 20."
            )

        # Extract core data
        X = [_normalize_value(df.at[i, iv_col], iv_encoding) for i in valid_indices]
        Y = [_normalize_value(df.at[i, dv_col], dv_encoding) for i in valid_indices]
        M = None
        W = None
        if mediator_col is not None:
            M = [_normalize_value(df.at[i, mediator_col], mediator_encoding) for i in valid_indices]
        if moderator_col is not None:
            W = [_normalize_value(df.at[i, moderator_col], moderator_encoding) for i in valid_indices]

        # Determine binary DV for logit
        is_binary_dv = False
        if _is_categorical(column_types[dv_idx] if dv_idx < len(column_types) else None):
            unique_vals = pd.Series([df.at[i, dv_col] for i in valid_indices]).dropna().unique()
            if len(unique_vals) == 2:
                is_binary_dv = True

        # Encode covariates
        control_data = []
        control_names = []
        for cov in covariate_meta:
            cov_col_id = column_ids[cov["idx"]]
            cov_name = cov["name"]
            cov_type = cov["type"]
            cov_param_index = cov["param_index"]

            if _is_categorical(cov_type) and cov.get("encoding") is None:
                # Multi-level categorical: dummy encode (k-1)
                unique_vals = sorted({str(df.at[i, cov_col_id]) for i in valid_indices})
                if len(unique_vals) < 2:
                    return _error(f"Covariate '{cov_name}' must have at least 2 unique values.")

                baseline = params.get(f'covariate_{cov_param_index}_baseline') or unique_vals[0]
                for level in unique_vals:
                    if level == baseline:
                        continue
                    dummy = [1 if str(df.at[i, cov_col_id]) == level else 0 for i in valid_indices]
                    control_data.append(dummy)
                    control_names.append(f"{cov_name}_{level}")

                categorical_encodings[cov_name] = {val: idx for idx, val in enumerate(unique_vals)}
            elif cov.get("encoding"):
                encoded = [_normalize_value(df.at[i, cov_col_id], cov["encoding"]) for i in valid_indices]
                control_data.append(encoded)
                control_names.append(cov_name)
            else:
                numeric = [_normalize_value(df.at[i, cov_col_id]) for i in valid_indices]
                control_data.append(numeric)
                control_names.append(cov_name)

        # Build payload structure expected by Python mediation/moderation modules
        if test_name == 'mediation_model4':
            result_data = {
                "outcome_data": Y,
                "predictor_data": X,
                "mediator_data": M,
                "outcome_name": dv_name,
                "predictor_name": iv_name,
                "mediator_name": display_name(mediator_col) if mediator_col else "Mediator",
                "control_data": control_data if control_data else None,
                "control_names": control_names if control_names else None,
                "categorical_encodings": categorical_encodings if categorical_encodings else None,
                "logit": False,
            }
        elif test_name == 'moderation_model1':
            result_data = {
                "outcome_data": Y,
                "predictor_data": X,
                "moderator_data": W,
                "outcome_name": dv_name,
                "predictor_name": iv_name,
                "moderator_name": display_name(moderator_col) if moderator_col else "Moderator",
                "control_data": control_data if control_data else None,
                "control_names": control_names if control_names else None,
                "categorical_encodings": categorical_encodings if categorical_encodings else None,
                "logit": is_binary_dv,
            }
        else:
            result_data = {
                "outcome_data": Y,
                "predictor_data": X,
                "moderator_data": W,
                "mediator_data": M,
                "outcome_name": dv_name,
                "predictor_name": iv_name,
                "moderator_name": display_name(moderator_col) if moderator_col else "Moderator",
                "mediator_name": display_name(mediator_col) if mediator_col else "Mediator",
                "control_data": control_data if control_data else None,
                "control_names": control_names if control_names else None,
                "categorical_encodings": categorical_encodings if categorical_encodings else None,
                "logit": is_binary_dv,
            }

    return result_data


def _normalize_dtype(value):
    if value is None:
        return ""
    if isinstance(value, str):
        normalized = value.strip().lower()
    else:
        normalized = str(value).strip().lower()
    return normalized.replace("_", " ").replace("-", " ")


def _is_numeric(dtype):
    normalized = _normalize_dtype(dtype)
    return normalized in ("numeric", "ordinal", "0", "3")


def _is_categorical(dtype):
    normalized = _normalize_dtype(dtype)
    return normalized in ("categorical", "binary", "1", "2")


def try_aggregate_result(test_name: str, params: dict, data_provider):
    try:
        import numpy as np
        if data_provider is None:
            return None
        source = getattr(data_provider, 'source', '')
        if not source:
            return None

        column_ids = params.get('column_ids') or params.get('column_names') or []
        column_names = params.get('column_names') or []
        column_types = params.get('column_types') or []
        if len(column_types) < len(column_ids):
            column_types = column_types + [None] * (len(column_ids) - len(column_types))

        if not column_ids:
            return None

        if not column_names or len(column_names) != len(column_ids):
            column_names = list(column_ids)

        id_to_name = {column_ids[i]: column_names[i] for i in range(len(column_ids))}
        name_to_id = {column_names[i]: column_ids[i] for i in range(len(column_ids))}

        def _resolve_column(value):
            if not value:
                return None
            if value in column_ids:
                return value
            if value in name_to_id:
                return name_to_id[value]
            return None

        if test_name == 'descriptive_stats':
            numeric_col = None
            for name, dtype in zip(column_ids, column_types):
                if _is_numeric(dtype):
                    numeric_col = name
                    break
            if not numeric_col:
                return None
            alpha = params.get('alpha', 0.05)
            stats_row = data_provider.get_descriptive_stats(numeric_col)
            mode_stats = data_provider.get_mode_stats(numeric_col) if hasattr(data_provider, 'get_mode_stats') else {}
            results = descriptive.descriptive_statistics_from_aggregates(
                stats_row,
                mode_stats,
                alpha
            )
            return {"success": True, "results": results} if results.get('success') else {"success": False, "error": results.get('error')}

        if test_name == 'independent_ttest':
            numeric_col = None
            cat_col = None
            for name, dtype in zip(column_ids, column_types):
                if numeric_col is None and _is_numeric(dtype):
                    numeric_col = name
                elif cat_col is None and _is_categorical(dtype):
                    cat_col = name

            if not numeric_col or not cat_col:
                return None

            group_stats = data_provider.get_ttest_aggregates(numeric_col, cat_col)
            groups = list(group_stats.keys())
            if len(groups) < 2:
                return None

            group1 = groups[0]
            group2 = groups[1]
            alpha = params.get('alpha', 0.05)
            equal_var = params.get('equal_var', True)
            results = parametric.t_test_two_sample_from_aggregates(
                group_stats[group1],
                group_stats[group2],
                equal_var,
                alpha,
                str(group1),
                str(group2)
            )
            return {"success": True, "results": results} if results.get('success') else {"success": False, "error": results.get('error')}

        if test_name == 'one_sample_ttest':
            numeric_col = None
            for name, dtype in zip(column_ids, column_types):
                if _is_numeric(dtype):
                    numeric_col = name
                    break
            if not numeric_col:
                return None

            stats_row = data_provider.get_descriptive_stats(numeric_col)
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Insufficient data: at least 2 observations are required."}
            n = int(n)

            mean = stats_row.get('mean')
            std = stats_row.get('std')
            if mean is None or std is None or std == 0 or np.isnan(std):
                return {"success": False, "error": "Insufficient variance for one-sample t-test."}

            alpha = params.get('alpha', 0.05)
            population_mean = params.get('population_mean', params.get('populationMean', 0))

            from scipy import stats as scipy_stats
            df = int(n - 1)
            sem = std / np.sqrt(n)
            t_stat = (mean - population_mean) / sem if sem != 0 else float('inf')
            p_value = 2 * (1 - scipy_stats.t.cdf(abs(t_stat), df))

            t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)
            lower_t_critical = scipy_stats.t.ppf(alpha / 2, df)
            upper_t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)

            ci_margin = t_critical * sem
            ci_lower = mean - ci_margin
            ci_upper = mean + ci_margin

            results = {
                'success': True,
                'test_type': 'one_sample',
                't_statistic': format_number(t_stat),
                'p_value': format_number(p_value),
                'degrees_of_freedom': df,
                'is_significant': bool(p_value < alpha),
                'alpha': format_number(alpha),
                't_critical': format_number(t_critical),
                'lower_t_critical': format_number(lower_t_critical),
                'upper_t_critical': format_number(upper_t_critical),
                'n': int(n),
                'sample_mean': format_number(mean),
                'sample_std': format_number(std),
                'sample_sem': format_number(sem),
                'sample_min': format_number(stats_row.get('min')),
                'sample_max': format_number(stats_row.get('max')),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper),
                'population_mean': format_number(population_mean),
            }
            return {"success": True, "results": results}

        if test_name == 'paired_ttest':
            paired_mapping = params.get("paired_ttest_mapping") or params.get("pairedTtestMapping") or {}

            numeric_cols = [name for name, dtype in zip(column_ids, column_types) if _is_numeric(dtype)]
            categorical_cols = [name for name, dtype in zip(column_ids, column_types) if _is_categorical(dtype)]

            mapped_group = _resolve_column(paired_mapping.get("group"))
            mapped_outcome = _resolve_column(paired_mapping.get("outcome"))

            wide_col1 = None
            wide_col2 = None

            if mapped_group and mapped_outcome:
                if _is_numeric(column_types[column_ids.index(mapped_group)]) and _is_numeric(column_types[column_ids.index(mapped_outcome)]):
                    wide_col1 = mapped_group
                    wide_col2 = mapped_outcome
                else:
                    return None
            elif len(numeric_cols) == 2 and len(categorical_cols) == 0:
                wide_col1 = numeric_cols[0]
                wide_col2 = numeric_cols[1]
            else:
                return None

            stats_row = data_provider.get_paired_ttest_aggregates(wide_col1, wide_col2)
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Insufficient data: at least 2 paired observations are required."}

            mean = stats_row.get('mean')
            std = stats_row.get('std')
            if mean is None or std is None or std == 0 or np.isnan(std):
                return {"success": False, "error": "Insufficient variance for paired t-test."}

            alpha = params.get('alpha', 0.05)
            from scipy import stats as scipy_stats
            df = int(n - 1)
            sem = std / np.sqrt(n)
            t_stat = mean / sem if sem != 0 else float('inf')
            p_value = 2 * (1 - scipy_stats.t.cdf(abs(t_stat), df))

            t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)
            lower_t_critical = scipy_stats.t.ppf(alpha / 2, df)
            upper_t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)

            ci_margin = t_critical * sem
            ci_lower = mean - ci_margin
            ci_upper = mean + ci_margin

            results = {
                'success': True,
                'test_type': 'paired',
                't_statistic': format_number(t_stat),
                'p_value': format_number(p_value),
                'degrees_of_freedom': df,
                'is_significant': bool(p_value < alpha),
                'alpha': format_number(alpha),
                't_critical': format_number(t_critical),
                'lower_t_critical': format_number(lower_t_critical),
                'upper_t_critical': format_number(upper_t_critical),
                'n': int(n),
                'mean_difference': format_number(mean),
                'std_difference': format_number(std),
                'sem_difference': format_number(sem),
                'min_difference': format_number(stats_row.get('min')),
                'max_difference': format_number(stats_row.get('max')),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper),
            }
            return {"success": True, "results": results}

        if test_name == 'correlation_pearson':
            if len(column_ids) < 2:
                return None
            x_col = column_ids[0]
            y_col = column_ids[1]
            aggregates = data_provider.get_correlation_aggregates(x_col, y_col)
            n = aggregates.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Need at least 2 paired observations for correlation"}
            n = int(n)

            sum_x = aggregates.get('sum_x', 0.0)
            sum_y = aggregates.get('sum_y', 0.0)
            sum_xy = aggregates.get('sum_xy', 0.0)
            sum_x2 = aggregates.get('sum_x2', 0.0)
            sum_y2 = aggregates.get('sum_y2', 0.0)

            denom = (n * sum_x2 - sum_x ** 2) * (n * sum_y2 - sum_y ** 2)
            if denom <= 0:
                return {"success": False, "error": "Insufficient variance for correlation."}
            r = (n * sum_xy - sum_x * sum_y) / np.sqrt(denom)

            from scipy.stats import t as t_dist, norm
            df = int(n - 2)
            if abs(r) < 1.0:
                t_stat = r * np.sqrt(df / (1 - r ** 2))
                p_value = 2 * (1 - t_dist.cdf(abs(t_stat), df))
            else:
                t_stat = float('inf') if r > 0 else float('-inf')
                p_value = 0.0

            alpha = params.get('alpha', 0.05)
            if n > 3:
                z_r = np.arctanh(r)
                se_z = 1 / np.sqrt(n - 3)
                z_crit = norm.ppf(1 - alpha / 2)
                ci_lower = np.tanh(z_r - z_crit * se_z)
                ci_upper = np.tanh(z_r + z_crit * se_z)
            else:
                ci_lower = None
                ci_upper = None

            results = {
                'success': True,
                'alpha': format_number(alpha),
                'n': int(n),
                'pearson': {
                    'correlation': format_number(r),
                    'p_value': format_number(p_value),
                    't_statistic': format_number(t_stat),
                    'degrees_of_freedom': df,
                    'ci_95_lower': format_number(ci_lower),
                    'ci_95_upper': format_number(ci_upper),
                    'is_significant': bool(p_value < alpha),
                    'interpretation': 'Measures linear relationship',
                    'type': 'parametric',
                    'assumptions': 'Assumes bivariate normality (both X and Y normally distributed)',
                },
                'correlation_matrices': {
                    'pearson': [[1.0, float(r)], [float(r), 1.0]]
                },
                'correlation_matrix_labels': ['x', 'y'],
            }
            return {"success": True, "results": results}

        if test_name == 'one_way_anova':
            anova_mapping = params.get("one_way_anova_mapping") or params.get("oneWayAnovaMapping") or {}
            numeric_col = None
            cat_col = None

            if anova_mapping.get("group") and anova_mapping.get("outcome"):
                cat_col = _resolve_column(anova_mapping.get("group"))
                numeric_col = _resolve_column(anova_mapping.get("outcome"))
            else:
                for name, dtype in zip(column_ids, column_types):
                    if _is_numeric(dtype) and numeric_col is None:
                        numeric_col = name
                    elif _is_categorical(dtype) and cat_col is None:
                        cat_col = name

            if not numeric_col or not cat_col:
                return None

            aggregates = data_provider.get_anova_aggregates(numeric_col, cat_col)
            groups = aggregates.get('groups', {})
            group_labels = list(groups.keys())
            k = len(group_labels)
            grand_n = aggregates.get('grand_n', 0)
            if k < 2 or grand_n is None or grand_n < 2:
                return {"success": False, "error": "Insufficient data for one-way ANOVA."}

            grand_mean = aggregates.get('grand_mean')
            if grand_mean is None or np.isnan(grand_mean):
                return {"success": False, "error": "Insufficient data for one-way ANOVA."}

            ss_within = 0.0
            ss_between = 0.0
            for group_name in group_labels:
                stats = groups.get(group_name, {})
                n = stats.get('n', 0)
                mean = stats.get('mean')
                ss = stats.get('ss')
                if mean is None or np.isnan(mean):
                    continue
                if ss is not None and not np.isnan(ss):
                    ss_within += float(ss)
                if n:
                    ss_between += float(n) * (float(mean) - float(grand_mean)) ** 2

            ss_total = float(aggregates.get('grand_ss') or (ss_within + ss_between))
            df_between = k - 1
            df_within = max(int(grand_n - k), 0)
            ms_between = ss_between / df_between if df_between > 0 else float('nan')
            ms_within = ss_within / df_within if df_within > 0 else float('nan')

            if ms_within == 0 or np.isnan(ms_within):
                return {"success": False, "error": "Insufficient variance for one-way ANOVA."}

            f_stat = ms_between / ms_within
            from scipy import stats as scipy_stats
            p_value = scipy_stats.f.sf(f_stat, df_between, df_within) if df_between > 0 and df_within > 0 else float('nan')

            eta_squared = ss_between / ss_total if ss_total > 0 else 0
            omega_squared = (ss_between - df_between * ms_within) / (ss_total + ms_within) if (ss_total + ms_within) > 0 else 0
            omega_squared = max(0, omega_squared)

            if eta_squared < 0.01:
                eta_interpretation = "negligible"
            elif eta_squared < 0.06:
                eta_interpretation = "small"
            elif eta_squared < 0.14:
                eta_interpretation = "medium"
            else:
                eta_interpretation = "large"

            results = {
                'success': True,
                'test_type': 'one_way_anova',
                'f_statistic': format_number(f_stat),
                'p_value': format_number(p_value),
                'df_between': int(df_between),
                'df_within': int(df_within),
                'is_significant': bool(p_value < params.get('alpha', 0.05)),
                'alpha': format_number(params.get('alpha', 0.05)),
                'num_groups': int(k),
                'total_n': int(grand_n),
                'ss_between': format_number(ss_between),
                'ss_within': format_number(ss_within),
                'ss_total': format_number(ss_total),
                'ms_between': format_number(ms_between),
                'ms_within': format_number(ms_within),
                'eta_squared': format_number(eta_squared),
                'omega_squared': format_number(omega_squared),
                'effect_size_interpretation': eta_interpretation,
                'group_labels': group_labels,
                'source_format': 'long',
                'assumptions': {
                    'homogeneity_of_variance': {
                        'levene_statistic': None,
                        'levene_p_value': None,
                        'equal_variances': None,
                        'note': 'Assumption checks not computed in aggregate mode.',
                    },
                    'normality': {
                        'all_groups_normal': None,
                        'note': 'Normality checks not computed in aggregate mode.',
                    }
                },
            }

            return {"success": True, "results": results}

        return None
    except Exception as e:
        import sys
        import traceback
        print(f"[AggregateResult] {test_name} failed: {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        return {"success": False, "error": f"Aggregate fast-path failed: {e}"}


def try_aggregate_result_from_payload(test_name: str, params: dict, aggregate_input: dict):
    try:
        import numpy as np
        if not aggregate_input:
            return None

        normalized = str(test_name).strip().lower()
        agg_type = str(aggregate_input.get('type') or normalized).strip().lower()

        if normalized == 'descriptive_stats' or agg_type == 'descriptive_stats':
            stats_row = aggregate_input.get('stats') or {}
            mode_stats = aggregate_input.get('mode') or {}
            alpha = params.get('alpha', 0.05)
            results = descriptive.descriptive_statistics_from_aggregates(
                stats_row,
                mode_stats,
                alpha
            )
            return {"success": True, "results": results} if results.get('success') else {"success": False, "error": results.get('error')}

        if normalized == 'one_sample_ttest' or agg_type == 'one_sample_ttest':
            stats_row = aggregate_input.get('stats') or {}
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Insufficient data: at least 2 observations are required."}
            n = int(n)

            mean = stats_row.get('mean')
            std = stats_row.get('std')
            if mean is None or std is None or std == 0 or np.isnan(std):
                return {"success": False, "error": "Insufficient variance for one-sample t-test."}

            alpha = params.get('alpha', 0.05)
            population_mean = params.get('population_mean', params.get('populationMean', 0))

            from scipy import stats as scipy_stats
            df = int(n - 1)
            sem = std / np.sqrt(n)
            t_stat = (mean - population_mean) / sem if sem != 0 else float('inf')
            p_value = 2 * (1 - scipy_stats.t.cdf(abs(t_stat), df))

            t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)
            lower_t_critical = scipy_stats.t.ppf(alpha / 2, df)
            upper_t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)

            ci_margin = t_critical * sem
            ci_lower = mean - ci_margin
            ci_upper = mean + ci_margin

            results = {
                'success': True,
                'test_type': 'one_sample',
                't_statistic': format_number(t_stat),
                'p_value': format_number(p_value),
                'degrees_of_freedom': df,
                'is_significant': bool(p_value < alpha),
                'alpha': format_number(alpha),
                't_critical': format_number(t_critical),
                'lower_t_critical': format_number(lower_t_critical),
                'upper_t_critical': format_number(upper_t_critical),
                'n': int(n),
                'sample_mean': format_number(mean),
                'sample_std': format_number(std),
                'sample_sem': format_number(sem),
                'sample_min': format_number(stats_row.get('min')),
                'sample_max': format_number(stats_row.get('max')),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper),
                'population_mean': format_number(population_mean),
            }
            return {"success": True, "results": results}

        if normalized in ('paired_ttest', 't_test_paired') or agg_type in ('paired_ttest', 't_test_paired'):
            stats_row = aggregate_input.get('stats') or {}
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Insufficient data: at least 2 paired observations are required."}

            mean = stats_row.get('mean')
            std = stats_row.get('std')
            if mean is None or std is None or std == 0 or np.isnan(std):
                return {"success": False, "error": "Insufficient variance for paired t-test."}

            alpha = params.get('alpha', 0.05)
            from scipy import stats as scipy_stats
            df = int(n - 1)
            sem = std / np.sqrt(n)
            t_stat = mean / sem if sem != 0 else float('inf')
            p_value = 2 * (1 - scipy_stats.t.cdf(abs(t_stat), df))

            t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)
            lower_t_critical = scipy_stats.t.ppf(alpha / 2, df)
            upper_t_critical = scipy_stats.t.ppf(1 - alpha / 2, df)

            ci_margin = t_critical * sem
            ci_lower = mean - ci_margin
            ci_upper = mean + ci_margin

            results = {
                'success': True,
                'test_type': 'paired',
                't_statistic': format_number(t_stat),
                'p_value': format_number(p_value),
                'degrees_of_freedom': df,
                'is_significant': bool(p_value < alpha),
                'alpha': format_number(alpha),
                't_critical': format_number(t_critical),
                'lower_t_critical': format_number(lower_t_critical),
                'upper_t_critical': format_number(upper_t_critical),
                'n': int(n),
                'mean_difference': format_number(mean),
                'std_difference': format_number(std),
                'sem_difference': format_number(sem),
                'min_difference': format_number(stats_row.get('min')),
                'max_difference': format_number(stats_row.get('max')),
                'ci_95_lower': format_number(ci_lower),
                'ci_95_upper': format_number(ci_upper),
            }
            return {"success": True, "results": results}

        if normalized in ('independent_ttest', 't_test_two_sample') or agg_type in ('independent_ttest', 't_test_two_sample'):
            group_stats = aggregate_input.get('groups') or {}
            group_order = aggregate_input.get('group_order') or list(group_stats.keys())
            if len(group_order) < 2:
                return {"success": False, "error": "Insufficient groups for independent t-test."}

            group1_key = str(group_order[0])
            group2_key = str(group_order[1])
            group1 = group_stats.get(group1_key)
            group2 = group_stats.get(group2_key)
            if group1 is None or group2 is None:
                return {"success": False, "error": "Missing group aggregates for independent t-test."}

            alpha = params.get('alpha', 0.05)
            equal_var = params.get('equal_var', True)
            results = parametric.t_test_two_sample_from_aggregates(
                group1,
                group2,
                equal_var,
                alpha,
                group1_key,
                group2_key
            )
            return {"success": True, "results": results} if results.get('success') else {"success": False, "error": results.get('error')}

        if normalized == 'correlation_pearson' or agg_type == 'correlation_pearson':
            stats_row = aggregate_input.get('stats') or {}
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Need at least 2 paired observations for correlation"}
            n = int(n)

            sum_x = stats_row.get('sum_x', 0.0)
            sum_y = stats_row.get('sum_y', 0.0)
            sum_xy = stats_row.get('sum_xy', 0.0)
            sum_x2 = stats_row.get('sum_x2', 0.0)
            sum_y2 = stats_row.get('sum_y2', 0.0)

            denom = (n * sum_x2 - sum_x ** 2) * (n * sum_y2 - sum_y ** 2)
            if denom <= 0:
                return {"success": False, "error": "Insufficient variance for correlation."}
            r = (n * sum_xy - sum_x * sum_y) / np.sqrt(denom)

            from scipy.stats import t as t_dist, norm
            df = int(n - 2)
            if abs(r) < 1.0:
                t_stat = r * np.sqrt(df / (1 - r ** 2))
                p_value = 2 * (1 - t_dist.cdf(abs(t_stat), df))
            else:
                t_stat = float('inf') if r > 0 else float('-inf')
                p_value = 0.0

            alpha = params.get('alpha', 0.05)
            if n > 3:
                z_r = np.arctanh(r)
                se_z = 1 / np.sqrt(n - 3)
                z_crit = norm.ppf(1 - alpha / 2)
                ci_lower = np.tanh(z_r - z_crit * se_z)
                ci_upper = np.tanh(z_r + z_crit * se_z)
            else:
                ci_lower = None
                ci_upper = None

            results = {
                'success': True,
                'alpha': format_number(alpha),
                'n': int(n),
                'pearson': {
                    'correlation': format_number(r),
                    'p_value': format_number(p_value),
                    't_statistic': format_number(t_stat),
                    'degrees_of_freedom': df,
                    'ci_95_lower': format_number(ci_lower),
                    'ci_95_upper': format_number(ci_upper),
                },
                'correlation_matrices': {
                    'pearson': [[1.0, float(r)], [float(r), 1.0]]
                },
                'correlation_matrix_labels': ['x', 'y'],
            }
            return {"success": True, "results": results}

        if normalized == 'correlation_spearman' or agg_type == 'correlation_spearman':
            stats_row = aggregate_input.get('stats') or {}
            n = stats_row.get('n')
            if n is None or (isinstance(n, float) and np.isnan(n)) or n < 2:
                return {"success": False, "error": "Need at least 2 paired observations for correlation"}
            n = int(n)

            sum_x = stats_row.get('sum_x', 0.0)
            sum_y = stats_row.get('sum_y', 0.0)
            sum_xy = stats_row.get('sum_xy', 0.0)
            sum_x2 = stats_row.get('sum_x2', 0.0)
            sum_y2 = stats_row.get('sum_y2', 0.0)

            denom = (n * sum_x2 - sum_x ** 2) * (n * sum_y2 - sum_y ** 2)
            if denom <= 0:
                return {"success": False, "error": "Insufficient variance for correlation."}
            r = (n * sum_xy - sum_x * sum_y) / np.sqrt(denom)

            # Spearman p-value approximation via t distribution on rank correlation
            from scipy.stats import t as t_dist, norm
            df = int(n - 2)
            if abs(r) < 1.0:
                t_stat = r * np.sqrt(df / (1 - r ** 2))
                p_value = 2 * (1 - t_dist.cdf(abs(t_stat), df))
            else:
                t_stat = float('inf') if r > 0 else float('-inf')
                p_value = 0.0

            s_statistic = (sum_x2 + sum_y2 - 2 * sum_xy) if sum_x2 is not None and sum_y2 is not None and sum_xy is not None else None

            alpha = params.get('alpha', 0.05)

            results = {
                'success': True,
                'alpha': format_number(alpha),
                'n': int(n),
                'spearman': {
                    'correlation': format_number(r),
                    'p_value': format_number(p_value),
                    's_statistic': format_number(s_statistic),
                    'is_significant': bool(p_value < alpha),
                    'interpretation': 'Measures monotonic relationship (rank-based)',
                    'type': 'non-parametric',
                    'assumptions': 'No distributional assumptions (distribution-free)'
                },
                'correlation_matrices': {
                    'spearman': [[1.0, float(r)], [float(r), 1.0]]
                },
                'correlation_matrix_labels': ['x', 'y'],
            }
            return {"success": True, "results": results}

        if normalized == 'one_way_anova' or agg_type == 'one_way_anova':
            aggregates = aggregate_input
            groups = aggregates.get('groups', {})
            group_labels = list(groups.keys())
            k = len(group_labels)
            grand_n = aggregates.get('grand_n', 0)
            if k < 2 or grand_n is None or grand_n < 2:
                return {"success": False, "error": "Insufficient data for one-way ANOVA."}

            grand_mean = aggregates.get('grand_mean')
            if grand_mean is None or np.isnan(grand_mean):
                return {"success": False, "error": "Insufficient data for one-way ANOVA."}

            ss_within = 0.0
            ss_between = 0.0
            for group_name in group_labels:
                stats = groups.get(group_name, {})
                n = stats.get('n', 0)
                mean = stats.get('mean')
                ss = stats.get('ss')
                if mean is None or np.isnan(mean):
                    continue
                if ss is not None and not np.isnan(ss):
                    ss_within += float(ss)
                if n:
                    ss_between += float(n) * (float(mean) - float(grand_mean)) ** 2

            ss_total = float(aggregates.get('grand_ss') or (ss_within + ss_between))
            df_between = k - 1
            df_within = max(int(grand_n - k), 0)
            ms_between = ss_between / df_between if df_between > 0 else float('nan')
            ms_within = ss_within / df_within if df_within > 0 else float('nan')

            if ms_within == 0 or np.isnan(ms_within):
                return {"success": False, "error": "Insufficient variance for one-way ANOVA."}

            f_stat = ms_between / ms_within
            from scipy import stats as scipy_stats
            p_value = scipy_stats.f.sf(f_stat, df_between, df_within) if df_between > 0 and df_within > 0 else float('nan')

            eta_squared = ss_between / ss_total if ss_total > 0 else 0
            omega_squared = (ss_between - df_between * ms_within) / (ss_total + ms_within) if (ss_total + ms_within) > 0 else 0
            omega_squared = max(0, omega_squared)

            if eta_squared < 0.01:
                eta_interpretation = "negligible"
            elif eta_squared < 0.06:
                eta_interpretation = "small"
            elif eta_squared < 0.14:
                eta_interpretation = "medium"
            else:
                eta_interpretation = "large"

            results = {
                'success': True,
                'test_type': 'one_way_anova',
                'f_statistic': format_number(f_stat),
                'p_value': format_number(p_value),
                'df_between': int(df_between),
                'df_within': int(df_within),
                'is_significant': bool(p_value < params.get('alpha', 0.05)),
                'alpha': format_number(params.get('alpha', 0.05)),
                'num_groups': int(k),
                'total_n': int(grand_n),
                'ss_between': format_number(ss_between),
                'ss_within': format_number(ss_within),
                'ss_total': format_number(ss_total),
                'ms_between': format_number(ms_between),
                'ms_within': format_number(ms_within),
                'eta_squared': format_number(eta_squared),
                'omega_squared': format_number(omega_squared),
                'effect_size_interpretation': eta_interpretation,
                'group_labels': group_labels,
                'source_format': 'long',
                'assumptions': {
                    'homogeneity_of_variance': {
                        'levene_statistic': None,
                        'levene_p_value': None,
                        'equal_variances': None,
                        'note': 'Assumption checks not computed in aggregate mode.',
                    },
                    'normality': {
                        'all_groups_normal': None,
                        'note': 'Normality checks not computed in aggregate mode.',
                    }
                },
            }
            return {"success": True, "results": results}

        return {"success": False, "error": f"Unsupported aggregate payload for test '{test_name}'"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_sampling_metadata(total_rows: int, sample_size: int, method: str = 'random') -> dict:
    """
    Phase 7: Generate sampling metadata for sampled large-dataset results.

    Args:
        total_rows: Total number of rows in the dataset
        sample_size: Number of rows actually analyzed
        method: Sampling method used ('random' or 'stratified')

    Returns:
        Dict with sampling metadata to attach to results
    """
    return {
        'is_sampled': True,
        'sample_size': sample_size,
        'total_rows': total_rows,
        'sampling_method': method,
        'random_seed': TIER_3_RANDOM_SEED,
        'sample_percentage': round(100.0 * sample_size / total_rows, 2) if total_rows > 0 else 0,
        'confidence_note': f"Results based on {sample_size:,} of {total_rows:,} rows ({round(100.0 * sample_size / total_rows, 2)}% sample). Full analysis available for datasets <1M rows."
    }


def should_sample_for_test(
    test_name: str,
    data_provider,
    execution_mode: str = "exact",
    total_rows: int = None
) -> tuple:
    """
    Phase 7: Determine if a test should use sampling.

    Args:
        test_name: Name of the statistical test
        data_provider: DataProvider instance (None for small datasets)
        execution_mode: 'exact' or 'large' (sampling allowed in large mode)
        total_rows: Total row count (optional, will query if not provided)

    Returns:
        Tuple of (should_sample: bool, sampled_provider: DataProvider or None,
                  total_rows: int, sample_size: int or None)
    """
    if data_provider is None:
        return False, None, total_rows or 0, None

    if test_name in TIER_3_TESTS:
        sample_threshold = TIER_3_SAMPLE_THRESHOLD
        sample_size = TIER_3_SAMPLE_SIZE

        # Respect execution_mode for Tier-3 tests
        # If user explicitly requested exact mode, don't sample
        if execution_mode == "exact":
            if total_rows is None:
                try:
                    total_rows = data_provider.get_row_count()
                except Exception:
                    total_rows = 0
            return False, None, total_rows, None

    elif test_name in TIER_2_TESTS:
        if execution_mode != "large":
            return False, None, total_rows or 0, None
        sample_threshold = TIER_2_SAMPLE_THRESHOLD
        sample_size = TIER_2_SAMPLE_SIZE
    else:
        return False, None, total_rows or 0, None

    # Get total row count if not provided
    if total_rows is None:
        try:
            total_rows = data_provider.get_row_count()
        except Exception:
            return False, None, 0, None

    # Only sample if dataset is large (>= threshold)
    if total_rows < sample_threshold:
        return False, None, total_rows, None

    # Sample the data
    try:
        actual_n = min(sample_size, total_rows)
        sampled_provider = data_provider.sample(
            n=actual_n,
            seed=TIER_3_RANDOM_SEED
        )
        return True, sampled_provider, total_rows, actual_n
    except Exception:
        # If sampling fails, return original provider
        return False, None, total_rows, None


def run_statistical_test(payload: dict) -> dict:
    """
    Route test execution to appropriate module.

    Payload structure:
    {
        "test": "test_name",
        "data": {...},           # Small datasets (embedded JSON)
        "arrow_data_path": "...", # Large datasets (Arrow file path)
        "parameters": {...},
        "parameters.duckdb_path": "..." # Phase 5: Large dataset DuckDB path
    }

    Supported Tests (45 total):

    GROUP 1 - Hypothesis Testing (11):
      - independent_ttest, paired_ttest, one_sample_ttest
      - one_way_anova, two_way_anova, multifactorial_anova
      - mann_whitney, wilcoxon, kruskal_wallis, friedman, scheirer_ray_hare

    GROUP 2 - Pharmacology (9):
      - dose_response_3pl, dose_response_4pl, dose_response_5pl, dose_response_compare
      - synergy_bliss, synergy_hsa, synergy_loewe, synergy_zip, synergy_all

    GROUP 3 - Regression & Correlation (7):
      - linear_regression, multiple_linear_regression
      - logistic_regression, logistic_multinomial
      - correlation_pearson, correlation_spearman, correlation_kendall

    GROUP 4 - Categorical (4):
      - chi_square, chi_square_gof, fishers_exact, mcnemar

    GROUP 5 - Distribution & Descriptive (4):
      - descriptive_stats, normality_shapiro, normality_ks, outlier_detection

    GROUP 6 - Survival (3):
      - kaplan_meier, cox_regression, nelson_aalen

    GROUP 7 - Mediation & Moderation (3):
      - mediation_model4, moderation_model1, moderated_mediation_model7

    GROUP 8 - RNA-seq (4):
      - rnaseq_deseq2, rnaseq_annotate, rnaseq_pca, rnaseq_validate

    Phase 1 Fix #1: DataProvider connections are now properly closed after each run.
    """
    test_name = payload.get("test")
    if not test_name:
        raise ValueError("Missing 'test' field in payload")
    if test_name == "__warmup__":
        params = payload.get("parameters", {}) or {}
        warmup_families = params.get("warmup_families", []) or []
        _ensure_utils_loaded()
        loaded_families = []
        for family in warmup_families:
            loader = _FAMILY_LOADERS.get(str(family))
            if loader is None:
                continue
            if globals().get(str(family)) is None:
                globals()[str(family)] = loader()
            loaded_families.append(str(family))
        return {
            "success": True,
            "results": {
                "warmed": True,
                "families": loaded_families,
            },
        }
    if not test_name.startswith("rnaseq_"):
        _ensure_utils_loaded()
    _ensure_stats_family_loaded(test_name)

    data = payload.get("data", {})
    arrow_path = payload.get("arrow_data_path")
    params = payload.get("parameters", {})

    # Phase 5: Check for DuckDB path and analysis mode (large dataset support)
    duckdb_path = params.get("duckdb_path")
    analysis_mode = params.get("analysis_mode", "small")
    aggregate_input = params.get("aggregate_input")
    # Phase 2: User-selected execution mode (exact = full materialization, large = streaming)
    execution_mode = params.get("execution_mode", "exact")
    data_provider = None
    original_provider = None  # Phase 1 Fix #1: Track original provider for cleanup
    sampling_metadata = None  # Phase 7: Track if sampling was used
    oom_fallback_warning = None  # Phase 2: Track if we fell back due to OOM
    aggregate_result = None  # Phase 5: Optional aggregate fast-path result

    if aggregate_input:
        aggregate_result = try_aggregate_result_from_payload(test_name, params, aggregate_input)

    if aggregate_input is None and arrow_path and DATAPROVIDER_AVAILABLE and not duckdb_path:
        # Arrow-only path: use DataProvider over Arrow IPC to avoid DuckDB file locks
        try:
            column_ids = params.get("column_ids") or params.get("column_names") or []
            data_provider = DataProvider(
                arrow_path,
                mode='auto',
                columns=column_ids if column_ids else None
            )
            original_provider = data_provider

            try:
                import sys
                print(
                    f"[ArrowMode] Using Arrow source for {test_name} "
                    f"(columns={len(column_ids)}, analysis_mode={analysis_mode}, execution_mode={execution_mode})",
                    file=sys.stderr
                )
            except Exception:
                pass

            # Phase 7: Check if this is a Tier 2/3 test that needs sampling
            should_sample, sampled_provider, total_rows, sample_size = should_sample_for_test(
                test_name, data_provider, execution_mode=execution_mode
            )
            if should_sample and sampled_provider is not None:
                # Use sampled data for this test
                data_provider = sampled_provider
                sampling_metadata = get_sampling_metadata(
                    total_rows=total_rows,
                    sample_size=sample_size if sample_size is not None else min(TIER_3_SAMPLE_SIZE, total_rows),
                    method='random'
                )
                try:
                    import sys
                    print(
                        f"[ArrowMode] Sampling enabled: {sampling_metadata.get('sample_size')} "
                        f"of {sampling_metadata.get('total_rows')} rows",
                        file=sys.stderr
                    )
                except Exception:
                    pass

            # Phase 5: Aggregate fast-path for large-mode tests (no full materialization)
            if analysis_mode == "large":
                aggregate_result = try_aggregate_result(test_name, params, data_provider)
                try:
                    import sys
                    print(
                        f"[ArrowMode] Aggregate fast-path {'HIT' if aggregate_result else 'MISS'} for {test_name}",
                        file=sys.stderr
                    )
                except Exception:
                    pass

            # Phase 5: For large datasets, fetch and transform data from Arrow
            if aggregate_result is None and analysis_mode == "large" and (not data or len(data) == 0):
                fetched_data = fetch_data_for_large_dataset(data_provider, params, test_name)
                if fetched_data and isinstance(fetched_data, dict) and fetched_data.get("__error__"):
                    return {"success": False, "error": fetched_data.get("__error__")}
                if fetched_data:
                    data = fetched_data
                    try:
                        import sys
                        print(f"[ArrowMode] Fetched data for {test_name}: {list(data.keys())}", file=sys.stderr)
                    except Exception:
                        pass
        except Exception as e:
            return {"success": False, "error": f"Arrow DataProvider initialization failed: {e}"}

    if aggregate_input is None and duckdb_path and DATAPROVIDER_AVAILABLE:
        # Large dataset path: use DataProvider for lazy data access
        # The DataProvider will query DuckDB on-demand instead of loading all data
        try:
            column_ids = params.get("column_ids") or params.get("column_names") or []
            data_provider = get_data_provider(duckdb_path, columns=column_ids if column_ids else None)
            original_provider = data_provider  # Phase 1 Fix #1: Keep reference for cleanup

            # Phase 7: Check if this is a Tier 2/3 test that needs sampling
            should_sample, sampled_provider, total_rows, sample_size = should_sample_for_test(
                test_name, data_provider, execution_mode=execution_mode
            )
            if should_sample and sampled_provider is not None:
                # Use sampled data for this test
                data_provider = sampled_provider
                sampling_metadata = get_sampling_metadata(
                    total_rows=total_rows,
                    sample_size=sample_size if sample_size is not None else min(TIER_3_SAMPLE_SIZE, total_rows),
                    method='random'
                )

            # Phase 5: Aggregate fast-path for large-mode tests (no full materialization)
            # Use aggregates for large datasets regardless of execution_mode when exact results are possible.
            if analysis_mode == "large":
                aggregate_result = try_aggregate_result(test_name, params, data_provider)

            # Phase 5: For large datasets, fetch and transform data from DuckDB
            # This replaces the empty data dict with properly formatted test data
            if aggregate_result is None and analysis_mode == "large" and (not data or len(data) == 0):
                fetched_data = fetch_data_for_large_dataset(data_provider, params, test_name)
                if fetched_data and isinstance(fetched_data, dict) and fetched_data.get("__error__"):
                    return {"success": False, "error": fetched_data.get("__error__")}
                if fetched_data:
                    data = fetched_data
                    # Log for debugging
                    import sys
                    print(f"[DataProvider] Fetched data for {test_name}: {list(data.keys())}", file=sys.stderr)

        except Exception as e:
            # Fall back to embedded data if DataProvider fails
            import warnings
            warnings.warn(f"DataProvider initialization failed: {e}. Using embedded data.")
            # Phase 1 Fix #1: Clean up on failure
            if original_provider is not None:
                try:
                    original_provider.close()
                except Exception:
                    pass
            data_provider = None
            original_provider = None

    # Load Arrow data if provided
    arrow_table = load_arrow_data(arrow_path) if arrow_path and data_provider is None else None

    # Result variable to capture output (allows post-processing for sampling metadata)
    result = None

    # Phase 1 Fix #1: Wrap test execution in try/finally to ensure provider cleanup
    # Phase 2: Add OOM retry logic for exact mode
    try:
        if aggregate_result is not None:
            result = add_sampling_metadata_to_result(aggregate_result, sampling_metadata)
        else:
            try:
                result = _execute_statistical_test(
                    test_name, data, params, arrow_table, data_provider, sampling_metadata
                )
            except MemoryError as oom_error:
                # Phase 2: If exact mode caused OOM, retry with large mode (sampling)
                if execution_mode == "exact" and duckdb_path and DATAPROVIDER_AVAILABLE:
                    import sys
                    print(f"[OOM Fallback] MemoryError in exact mode for {test_name}, retrying with sampling...", file=sys.stderr)

                    # Create fresh provider with sampling
                    fallback_provider = None
                    sampled_provider = None
                    try:
                        column_ids = params.get("column_ids") or params.get("column_names") or []
                        fallback_provider = get_data_provider(duckdb_path, columns=column_ids if column_ids else None)

                        # Force sampling for fallback
                        total_rows = fallback_provider.row_count
                        sample_size = min(TIER_3_SAMPLE_SIZE, total_rows)

                        # Get sampled data
                        sampled_provider = fallback_provider.sample(sample_size)
                        if sampled_provider is not None:
                            # Re-fetch data with sampling
                            params_copy = dict(params)
                            params_copy['execution_mode'] = 'large'  # Force large mode
                            fetched_data = fetch_data_for_large_dataset(sampled_provider, params_copy, test_name)
                            if fetched_data:
                                data = fetched_data

                            sampling_metadata = get_sampling_metadata(
                                total_rows=total_rows,
                                sample_size=sample_size,
                                method='random_oom_fallback'
                            )
                            oom_fallback_warning = (
                                f"Memory limit exceeded during exact analysis. "
                                f"Results computed using {sample_size:,} row sample from {total_rows:,} total rows."
                            )

                            # Retry with sampled data
                            result = _execute_statistical_test(
                                test_name, data, params, arrow_table, sampled_provider, sampling_metadata
                            )
                    finally:
                        if sampled_provider is not None:
                            try:
                                sampled_provider.close()
                            except Exception:
                                pass
                        if fallback_provider is not None:
                            try:
                                fallback_provider.close()
                            except Exception:
                                pass
                else:
                    # Re-raise OOM if not in exact mode or no fallback possible
                    raise oom_error
    finally:
        # Phase 1 Fix #1: Always close DataProvider to prevent file handle leaks
        if original_provider is not None:
            try:
                original_provider.close()
            except Exception as e:
                import sys
                print(f"[DataProvider] Warning: Failed to close provider: {e}", file=sys.stderr)

    # Phase 2: Add OOM fallback warning to result if applicable
    if result and oom_fallback_warning:
        if isinstance(result, dict):
            warnings_list = result.get("warnings", [])
            if not isinstance(warnings_list, list):
                warnings_list = []
            warnings_list.append(oom_fallback_warning)
            result["warnings"] = warnings_list
            result["oom_fallback"] = True

    if result is not None and sampling_metadata is not None:
        result = add_sampling_metadata_to_result(result, sampling_metadata)

    return result


def _execute_statistical_test(
    test_name: str,
    data: dict,
    params: dict,
    arrow_table,
    data_provider,
    sampling_metadata: dict
) -> dict:
    """
    Internal function to execute statistical tests.

    Separated from run_statistical_test to enable proper cleanup via try/finally.
    """

    # =========================================================================
    # GROUP 1: HYPOTHESIS TESTING (12 tests)
    # =========================================================================

    # --- Parametric Tests ---
    if test_name == "independent_ttest":
        group1 = data.get("group1", [])
        group2 = data.get("group2", [])
        group1_name = data.get("group1_name", None)
        group2_name = data.get("group2_name", None)
        alpha = params.get("alpha", 0.05)
        posthoc_adjustment = params.get("posthoc_adjustment", "tukey")
        control_levels = params.get("control_levels", None)
        equal_var = params.get("equal_var", True)
        results = parametric.t_test_two_sample(
            group1, group2,
            equal_var=equal_var,
            alpha=alpha,
            group1_name=group1_name,
            group2_name=group2_name
        )
        if data.get("warnings"):
            results['warnings'] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "paired_ttest":
        group1 = data.get("group1", [])
        group2 = data.get("group2", [])
        group1_name = data.get("group1_name", None)
        group2_name = data.get("group2_name", None)
        alpha = params.get("alpha", 0.05)

        # Note: t_test_paired doesn't accept group names (frozen), but we store them in data
        # for potential future use or frontend display
        results = parametric.t_test_paired(group1, group2, alpha=alpha)

        # Add group names to results if provided
        if group1_name and group2_name:
            results['group1_name'] = group1_name
            results['group2_name'] = group2_name

        if data.get("warnings"):
            results['warnings'] = data.get("warnings")

        return {"success": True, "results": results}

    elif test_name == "one_sample_ttest":
        values = data.get("values", [])
        population_mean = params.get("population_mean", 0)
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": parametric.t_test_one_sample(values, population_mean, alpha=alpha)}

    # --- ANOVA Tests ---
    elif test_name == "one_way_anova":
        groups = data.get("groups", [])
        alpha = params.get("alpha", 0.05)
        posthoc_q = params.get("posthoc_q", None)

        # Extract group labels (optional, for display in results)
        # Matches two-way ANOVA pattern for metadata forwarding
        group_labels = params.get("group_labels", None)

        # Post-hoc adjustment method (Phase 2)
        posthoc_adjustment = params.get("posthoc_adjustment", "tukey")
        control_level = params.get("control_level", None)

        return {"success": True, "results": parametric.anova_one_way(
            *groups, alpha=alpha, group_labels=group_labels,
            posthoc_adjustment=posthoc_adjustment, control_level=control_level, posthoc_q=posthoc_q
        )}

    elif test_name == "two_way_anova":
        dependent = data.get("dependent", [])
        factor1 = data.get("factor1", [])
        factor2 = data.get("factor2", [])
        alpha = params.get("alpha", 0.05)
        posthoc_adjustment = params.get("posthoc_adjustment", "tukey")
        posthoc_q = params.get("posthoc_q", None)
        control_levels = params.get("control_levels", None)

        # Extract factor names and labels
        factor1_name = data.get("factor1_name", "factor1")
        factor2_name = data.get("factor2_name", "factor2")
        factor_names = [factor1_name, factor2_name]

        # Extract simple effects configuration (optional)
        simple_effects = params.get("simple_effects", None)

        # Extract factor level labels (optional)
        factor_level_labels = data.get("factor_levels", None)

        return {"success": True, "results": anova.anova_two_way(
            dependent, factor1, factor2,
            alpha=alpha,
            factor_names=factor_names,
            simple_effects=simple_effects,
            factor_level_labels=factor_level_labels,
            posthoc_adjustment=posthoc_adjustment,
            control_levels=control_levels,
            posthoc_q=posthoc_q
        )}

    elif test_name == "multifactorial_anova":
        # Multifactorial ANOVA for 3+ factors
        dependent = data.get("dependent", [])
        factors = data.get("factors", {})  # Dict of factor_name: values
        factor_names = data.get("factor_names", list(factors.keys()))
        alpha = params.get("alpha", 0.05)
        max_depth = params.get("max_depth", None)
        simple_effects_config = params.get("simple_effects", None)
        posthoc_adjustment = params.get("posthoc_adjustment", "tukey")
        posthoc_q = params.get("posthoc_q", None)
        control_levels = params.get("control_levels", None)
        factor_level_labels = data.get("factor_levels", None)

        return {"success": True, "results": mf_anova(
            dependent, factors,
            factor_names=factor_names,
            alpha=alpha,
            max_interaction_depth=max_depth,
            simple_effects_config=simple_effects_config,
            factor_level_labels=factor_level_labels,
            posthoc_adjustment=posthoc_adjustment,
            control_levels=control_levels,
            posthoc_q=posthoc_q
        )}

    elif test_name == "lmm_anova":
        dependent = data.get("dependent", [])
        subject = data.get("subject", [])
        predictors = data.get("predictors", {})
        predictor_types = data.get("predictor_types", {})
        factor_level_labels = data.get("factor_level_labels", data.get("factor_levels", {}))
        alpha = params.get("alpha", 0.05)
        reml = params.get("reml", False)
        random_effects_config = params.get("random_effects_config", {})
        simple_effects_config = params.get("simple_effects", params.get("simple_effects_config", None))
        continuous_effects_config = params.get("continuous_effects_config", None)
        posthoc_adjustment = params.get("posthoc_adjustment", "tukey")
        posthoc_q = params.get("posthoc_q", None)
        control_levels = params.get("control_levels", None)
        interaction_depth = params.get("interaction_depth", 2)
        df_method = params.get("df_method", "satterthwaite")
        stratify_by = params.get("stratify_by", None)
        trajectory_roles = params.get("trajectory_roles", None)

        return {"success": True, "results": lmm.lmm_anova(
            dependent=dependent,
            subject=subject,
            predictors=predictors,
            predictor_types=predictor_types,
            alpha=alpha,
            reml=reml,
            random_effects_config=random_effects_config,
            simple_effects_config=simple_effects_config,
            factor_level_labels=factor_level_labels,
            posthoc_adjustment=posthoc_adjustment,
            control_levels=control_levels,
            posthoc_q=posthoc_q,
            interaction_depth=interaction_depth,
            df_method=df_method,
            stratify_by=stratify_by,
            continuous_effects_config=continuous_effects_config,
            trajectory_roles=trajectory_roles,
        )}

    # --- Nonparametric Tests ---
    elif test_name == "mann_whitney":
        data1 = data.get("data1", [])
        data2 = data.get("data2", [])
        group_name1 = data.get("group_name1", None)
        group_name2 = data.get("group_name2", None)
        alpha = params.get("alpha", 0.05)
        results = nonparametric.mann_whitney_u(data1, data2, alpha=alpha, group_name1=group_name1, group_name2=group_name2)
        if data.get("warnings"):
            results['warnings'] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "wilcoxon":
        group1 = data.get("group1", [])
        group2 = data.get("group2", [])
        group1_name = data.get("group1_name", None)
        group2_name = data.get("group2_name", None)
        alpha = params.get("alpha", 0.05)

        # Note: wilcoxon_signed_rank doesn't accept group names (frozen), but we store them in data
        results = nonparametric.wilcoxon_signed_rank(group1, group2, alpha=alpha)

        # Add group names to results if provided
        if group1_name and group2_name:
            results['group1_name'] = group1_name
            results['group2_name'] = group2_name
        if data.get("warnings"):
            results['warnings'] = data.get("warnings")

        return {"success": True, "results": results}

    elif test_name == "kruskal_wallis":
        groups = data.get("groups", [])
        alpha = params.get("alpha", 0.05)
        posthoc_adjustment = params.get("posthoc_adjustment", "bonferroni")
        posthoc_q = params.get("posthoc_q", None)

        # Extract group labels (optional, for display in results)
        # Matches one-way ANOVA pattern for metadata forwarding
        group_labels = params.get("group_labels", None)

        return {"success": True, "results": nonparametric.kruskal_wallis(
            *groups, alpha=alpha, group_labels=group_labels,
            posthoc_adjustment=posthoc_adjustment, posthoc_q=posthoc_q
        )}

    elif test_name == "friedman":
        groups = data.get("groups", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": nonparametric.friedman_test(*groups, alpha=alpha)}

    elif test_name == "scheirer_ray_hare":
        values = data.get("values", [])
        factor1 = data.get("factor1", [])
        factor2 = data.get("factor2", [])
        alpha = params.get("alpha", 0.05)

        # Build metadata dictionary
        metadata = {
            "factor_names": [data.get("factor1_name", "Factor 1"), data.get("factor2_name", "Factor 2")],
            "dependent_variable": data.get("dependent_name") or data.get("value_name", "Value"),
            "factor_level_labels": data.get("factor_levels", {}),
            "simple_effects": params.get("simple_effects", None),
        }

        return {"success": True, "results": nonparametric.scheirer_ray_hare(
            values, factor1, factor2, alpha=alpha, **metadata
        )}

    # =========================================================================
    # GROUP 2: PHARMACOLOGY & DOSE-RESPONSE (9 tests)
    # =========================================================================

    elif test_name == "dose_response_3pl":
        doses = data.get("doses", [])
        responses = data.get("responses", [])
        suitability = _evaluate_dose_response_suitability(
            doses,
            responses,
            min_positive_observations=3,
            require_all_positive_doses=False,
        )
        if not suitability.get("success", False):
            return suitability
        # bottom_fixed defaults to None: Python will use control_mean if controls present, else 0.0
        bottom_fixed = params.get("bottom_fixed", None)
        fitting_method = data.get("fitting_method", "log_dose")
        fit_result = dose_response.fit_3pl_dose_response(
            doses,
            responses,
            bottom_fixed=bottom_fixed,
            fitting_method=fitting_method,
        )
        if not isinstance(fit_result, dict):
            return _dose_response_error(
                "Dose-response backend returned an invalid 3PL result.",
                "DoseResponseFitInvalid",
            )
        if not fit_result.get("success", False):
            return _dose_response_error(
                str(fit_result.get("error", "3PL fitting failed.")),
                "DoseResponseFitFailed",
                warnings=suitability.get("warnings", []),
            )
        _merge_warnings(fit_result, suitability.get("warnings", []))
        result = {
            "success": True,
            "results": fit_result,
        }
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "dose_response_4pl":
        doses = data.get("doses", [])
        responses = data.get("responses", [])
        suitability = _evaluate_dose_response_suitability(
            doses,
            responses,
            min_positive_observations=3,
            require_all_positive_doses=False,
        )
        if not suitability.get("success", False):
            return suitability
        fitting_method = data.get("fitting_method", "log_dose")
        fit_result = dose_response.fit_4pl_dose_response(
            doses,
            responses,
            fitting_method=fitting_method,
        )
        if not isinstance(fit_result, dict):
            return _dose_response_error(
                "Dose-response backend returned an invalid 4PL result.",
                "DoseResponseFitInvalid",
            )
        if not fit_result.get("success", False):
            return _dose_response_error(
                str(fit_result.get("error", "4PL fitting failed.")),
                "DoseResponseFitFailed",
                warnings=suitability.get("warnings", []),
            )
        _merge_warnings(fit_result, suitability.get("warnings", []))
        result = {
            "success": True,
            "results": fit_result,
        }
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "dose_response_5pl":
        doses = data.get("doses", [])
        responses = data.get("responses", [])
        suitability = _evaluate_dose_response_suitability(
            doses,
            responses,
            min_positive_observations=6,
            require_all_positive_doses=False,
            warn_if_unique_positive_below=6,
        )
        if not suitability.get("success", False):
            return suitability
        fit_result = dose_response.fit_5pl_dose_response(doses, responses)
        if not isinstance(fit_result, dict):
            return _dose_response_error(
                "Dose-response backend returned an invalid 5PL result.",
                "DoseResponseFitInvalid",
            )
        if not fit_result.get("success", False):
            return _dose_response_error(
                str(fit_result.get("error", "5PL fitting failed.")),
                "DoseResponseFitFailed",
                warnings=suitability.get("warnings", []),
            )
        _merge_warnings(fit_result, suitability.get("warnings", []))
        result = {"success": True, "results": fit_result}
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "dose_response_compare":
        doses = data.get("doses", [])
        responses = data.get("responses", [])
        suitability = _evaluate_dose_response_suitability(
            doses,
            responses,
            min_positive_observations=4,
            require_all_positive_doses=True,
        )
        if not suitability.get("success", False):
            return suitability
        bottom_fixed = params.get("bottom_fixed", 0.0)
        fitting_method = data.get("fitting_method", "log_dose")
        fit_result = dose_response.compare_dose_response_models(
            doses,
            responses,
            bottom_fixed=bottom_fixed,
            fitting_method=fitting_method,
        )
        if not isinstance(fit_result, dict):
            return _dose_response_error(
                "Dose-response backend returned an invalid comparison result.",
                "DoseResponseFitInvalid",
            )
        if not fit_result.get("success", False):
            return _dose_response_error(
                str(fit_result.get("error", "Dose-response comparison failed.")),
                "DoseResponseFitFailed",
                warnings=suitability.get("warnings", []),
            )
        _merge_warnings(fit_result, suitability.get("warnings", []))
        result = {
            "success": True,
            "results": fit_result,
        }
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "synergy_bliss":
        # Check for sparse mode (real-life sparse combo data)
        if data.get("sparse_mode", False):
            dose_a = data.get("dose_a", [])
            dose_b = data.get("dose_b", [])
            response_a = data.get("response_a", [])
            response_b = data.get("response_b", [])
            combo_response = data.get("combo_response", [])
            result = {"success": True, "results": drug_combo.calculate_bliss_synergy_sparse(
                dose_a, dose_b, response_a, response_b, combo_response
            )}
        else:
            # Dense mode (full grid)
            responses_a = data.get("responses_a", [])
            responses_b = data.get("responses_b", [])
            combo_matrix = data.get("combo_matrix", [])
            result = {"success": True, "results": drug_combo.calculate_bliss_synergy(responses_a, responses_b, combo_matrix)}
        if data.get("warnings"):
            result["warnings"] = data.get("warnings")
        return result

    elif test_name == "synergy_hsa":
        # Check for sparse mode (real-life sparse combo data)
        if data.get("sparse_mode", False):
            dose_a = data.get("dose_a", [])
            dose_b = data.get("dose_b", [])
            response_a = data.get("response_a", [])
            response_b = data.get("response_b", [])
            combo_response = data.get("combo_response", [])
            result = {"success": True, "results": drug_combo.calculate_hsa_synergy_sparse(
                dose_a, dose_b, response_a, response_b, combo_response
            )}
        else:
            # Dense mode (full grid)
            responses_a = data.get("responses_a", [])
            responses_b = data.get("responses_b", [])
            combo_matrix = data.get("combo_matrix", [])
            result = {"success": True, "results": drug_combo.calculate_hsa_synergy(responses_a, responses_b, combo_matrix)}
        if data.get("warnings"):
            result["warnings"] = data.get("warnings")
        return result

    elif test_name == "synergy_loewe":
        doses_a = data.get("doses_a", [])
        doses_b = data.get("doses_b", [])
        responses_a = data.get("responses_a", [])
        responses_b = data.get("responses_b", [])
        combo_matrix = data.get("combo_matrix", [])
        data_type = data.get("data_type", "viability")
        fitting_method = data.get("fitting_method", "log_dose")
        result = {"success": True, "results": drug_combo.calculate_loewe_synergy(
            doses_a, doses_b, responses_a, responses_b, combo_matrix,
            data_type=data_type, fitting_method=fitting_method
        )}
        if data.get("warnings"):
            result["warnings"] = data.get("warnings")
        return result

    elif test_name == "synergy_zip":
        doses_a = data.get("doses_a", [])
        doses_b = data.get("doses_b", [])
        responses_a = data.get("responses_a", [])
        responses_b = data.get("responses_b", [])
        combo_matrix = data.get("combo_matrix", [])
        result = {"success": True, "results": drug_combo.calculate_zip_synergy(
            doses_a, doses_b, responses_a, responses_b, combo_matrix
        )}
        if data.get("warnings"):
            result["warnings"] = data.get("warnings")
        return result

    elif test_name == "synergy_all":
        # Comprehensive synergy analysis using JSON input
        json_input = json.dumps(data)
        result_json = drug_combo.synergy_analysis_json(json_input)
        result = {"success": True, "results": json.loads(result_json)}
        if data.get("warnings"):
            result["warnings"] = data.get("warnings")
        return result

    # =========================================================================
    # GROUP 3: REGRESSION & CORRELATION (8 tests)
    # =========================================================================

    elif test_name == "linear_regression":
        x = data.get("x", [])
        y = data.get("y", [])
        X = data.get("X", None)
        alpha = params.get("alpha", 0.05)
        # Simple linear regression (single predictor)
        import numpy as np
        if X is not None and len(X) > 0:
            feature_names = data.get("predictor_names")
            predictor_encodings = data.get("categorical_mappings")
            if feature_names or predictor_encodings:
                set_context_metadata(
                    "multiple_linear_regression",
                    {
                        "feature_names": feature_names,
                        "predictor_encodings": predictor_encodings,
                    },
                )
            results = regression.multiple_linear_regression(np.array(X), np.array(y), alpha=alpha)
        else:
            X = np.array(x).reshape(-1, 1)
            Y = np.array(y)
            # Provide feature names to the regression module for readable outputs.
            predictor_name = data.get("predictor_name")
            if predictor_name:
                set_context_metadata("multiple_linear_regression", {"feature_names": [predictor_name]})
            results = regression.multiple_linear_regression(X, Y, alpha=alpha)
        if data.get("warnings"):
            results["warnings"] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "multiple_linear_regression":
        X = data.get("X", [])  # 2D array of predictors
        y = data.get("y", [])
        alpha = params.get("alpha", 0.05)
        feature_names = data.get("predictor_names")
        predictor_encodings = data.get("categorical_mappings")
        if feature_names or predictor_encodings:
            set_context_metadata(
                "multiple_linear_regression",
                {
                    "feature_names": feature_names,
                    "predictor_encodings": predictor_encodings,
                },
            )
        import numpy as np
        results = regression.multiple_linear_regression(np.array(X), np.array(y), alpha=alpha)
        if data.get("warnings"):
            results["warnings"] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "logistic_regression":
        X = data.get("X", [])
        y = data.get("y", [])
        alpha = params.get("alpha", 0.05)
        feature_names = data.get("predictor_names")
        category_mapping = data.get("dependent_reverse") or data.get("dependent_mapping")
        import numpy as np
        results = regression.logistic_regression_binary_statsmodels(
            np.array(X),
            np.array(y),
            alpha=alpha,
            category_mapping=category_mapping,
            feature_names=feature_names
        )
        if data.get("warnings"):
            results["warnings"] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "logistic_multinomial":
        X = data.get("X", [])
        y = data.get("y", [])
        alpha = params.get("alpha", 0.05)
        feature_names = data.get("predictor_names")
        category_mapping = data.get("dependent_reverse") or data.get("dependent_mapping")
        import numpy as np
        results = regression.logistic_regression_multinomial_statsmodels(
            np.array(X),
            np.array(y),
            alpha=alpha,
            category_mapping=category_mapping,
            feature_names=feature_names
        )
        if data.get("warnings"):
            results["warnings"] = data.get("warnings")
        return {"success": True, "results": results}

    elif test_name == "correlation_pearson":
        x = data.get("x", [])
        y = data.get("y", [])
        x_name = data.get("x_name", "X")
        y_name = data.get("y_name", "Y")
        n_total = data.get("n_total", len(x))
        n_used = data.get("n_used", len(x))
        alpha = params.get("alpha", 0.05)
        method = "pearson"

        # Always compute pairwise stats (for tables)
        result = correlation.correlation_analysis(x, y, alpha=alpha, method=method)
        result['x_name'] = x_name
        result['y_name'] = y_name
        result['n_total'] = n_total
        result['n_used'] = n_used

        # If matrix is present (N >= 3 columns), compute full N x N correlation matrix (for heatmap)
        matrix = data.get("matrix")
        if matrix:
            matrix_labels = data.get("matrix_labels")
            matrix_result = correlation.correlation_matrix_analysis(matrix, matrix_labels, alpha, method=method)
            if matrix_result.get('success'):
                # Merge matrix fields into pairwise result
                result['correlation_matrices'] = matrix_result['correlation_matrices']
                result['correlation_matrix_labels'] = matrix_result['correlation_matrix_labels']
                result['n_vars'] = matrix_result.get('n_vars')
                result['matrix_stats'] = matrix_result.get('matrix_stats')

        return {"success": True, "results": result}

    elif test_name == "correlation_spearman":
        x = data.get("x", [])
        y = data.get("y", [])
        x_name = data.get("x_name", "X")
        y_name = data.get("y_name", "Y")
        n_total = data.get("n_total", len(x))
        n_used = data.get("n_used", len(x))
        alpha = params.get("alpha", 0.05)
        method = "spearman"

        # Always compute pairwise stats (for tables)
        result = correlation.correlation_analysis(x, y, alpha=alpha, method=method)
        result['x_name'] = x_name
        result['y_name'] = y_name
        result['n_total'] = n_total
        result['n_used'] = n_used

        # If matrix is present (N >= 3 columns), compute full N x N correlation matrix (for heatmap)
        matrix = data.get("matrix")
        if matrix:
            matrix_labels = data.get("matrix_labels")
            matrix_result = correlation.correlation_matrix_analysis(matrix, matrix_labels, alpha, method=method)
            if matrix_result.get('success'):
                # Merge matrix fields into pairwise result
                result['correlation_matrices'] = matrix_result['correlation_matrices']
                result['correlation_matrix_labels'] = matrix_result['correlation_matrix_labels']
                result['n_vars'] = matrix_result.get('n_vars')
                result['matrix_stats'] = matrix_result.get('matrix_stats')

        return {"success": True, "results": result}

    elif test_name == "correlation_kendall":
        x = data.get("x", [])
        y = data.get("y", [])
        x_name = data.get("x_name", "X")
        y_name = data.get("y_name", "Y")
        n_total = data.get("n_total", len(x))
        n_used = data.get("n_used", len(x))
        alpha = params.get("alpha", 0.05)
        method = "kendall"

        # Always compute pairwise stats (for tables)
        result = correlation.correlation_analysis(x, y, alpha=alpha, method=method)
        result['x_name'] = x_name
        result['y_name'] = y_name
        result['n_total'] = n_total
        result['n_used'] = n_used

        # If matrix is present (N >= 3 columns), compute full N x N correlation matrix (for heatmap)
        matrix = data.get("matrix")
        if matrix:
            matrix_labels = data.get("matrix_labels")
            matrix_result = correlation.correlation_matrix_analysis(matrix, matrix_labels, alpha, method=method)
            if matrix_result.get('success'):
                # Merge matrix fields into pairwise result
                result['correlation_matrices'] = matrix_result['correlation_matrices']
                result['correlation_matrix_labels'] = matrix_result['correlation_matrix_labels']
                result['n_vars'] = matrix_result.get('n_vars')
                result['matrix_stats'] = matrix_result.get('matrix_stats')

        return {"success": True, "results": result}

    # =========================================================================
    # GROUP 4: CATEGORICAL ANALYSIS (4 tests)
    # =========================================================================

    elif test_name == "chi_square":
        observed = data.get("observed", [])
        expected = data.get("expected", None)
        alpha = params.get("alpha", 0.05)
        set_context_metadata(
            "chi_squared_test",
            {
                "row_labels": data.get("row_labels"),
                "column_labels": data.get("col_labels"),
                "row_variable": data.get("row_variable"),
                "column_variable": data.get("col_variable"),
            },
        )
        return {"success": True, "results": contingency.chi_squared_test(observed, expected, alpha=alpha)}

    elif test_name == "chi_square_gof":
        observed = data.get("observed", [])
        expected = data.get("expected", None)
        alpha = params.get("alpha", 0.05)
        set_context_metadata(
            "chi_squared_goodness_of_fit",
            {
                "category_labels": data.get("category_labels"),
                "value_column": data.get("value_column") or data.get("column_name"),
            },
        )
        return {"success": True, "results": contingency.chi_squared_goodness_of_fit(observed, expected, alpha=alpha)}

    elif test_name == "fishers_exact":
        table = data.get("table", [[]])
        alpha = params.get("alpha", 0.05)
        set_context_metadata(
            "fisher_exact_test",
            {
                "row_labels": data.get("row_labels"),
                "column_labels": data.get("col_labels"),
                "row_variable": data.get("row_variable"),
                "column_variable": data.get("col_variable"),
            },
        )
        return {"success": True, "results": contingency.fisher_exact_test(table, alpha=alpha)}

    elif test_name == "mcnemar":
        table = data.get("table", [[]])
        alpha = params.get("alpha", 0.05)
        set_context_metadata(
            "mcnemar_test",
            {
                "row_labels": data.get("row_labels"),
                "column_labels": data.get("col_labels"),
                "row_variable": data.get("row_variable"),
                "column_variable": data.get("col_variable"),
            },
        )
        return {
            "success": True,
            "results": contingency.mcnemar_test(
                table,
                alpha=alpha,
            )
        }

    # =========================================================================
    # GROUP 5: DISTRIBUTION & DESCRIPTIVE (4 tests)
    # =========================================================================

    elif test_name == "descriptive_stats":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": descriptive.descriptive_statistics(values, alpha=alpha)}

    elif test_name == "normality_shapiro":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": distributions.shapiro_wilk_test(values, alpha=alpha)}

    elif test_name == "normality_ks":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": distributions.kolmogorov_smirnov_test(values, alpha=alpha)}

    elif test_name == "normality_ad":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": distributions.anderson_darling_test(values, alpha=alpha)}

    elif test_name == "normality_cvm":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": distributions.cramer_von_mises_test(values, alpha=alpha)}

    elif test_name == "normality_jb":
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": distributions.jarque_bera_test(values, alpha=alpha)}

    elif test_name in ("normality_all", "normality_tests"):
        values = data.get("values", [])
        alpha = params.get("alpha", 0.05)

        def _require(result, label):
            if not isinstance(result, dict):
                raise ValueError(f"{label} failed: invalid result")
            if result.get("success") is False:
                raise ValueError(f"{label} failed: {result.get('error', 'Unknown error')}")
            return result

        shapiro = _require(distributions.shapiro_wilk_test(values, alpha=alpha), "Shapiro-Wilk")
        ks = _require(distributions.kolmogorov_smirnov_test(values, alpha=alpha), "Kolmogorov-Smirnov")
        ad = _require(distributions.anderson_darling_test(values, alpha=alpha), "Anderson-Darling")
        cvm = _require(distributions.cramer_von_mises_test(values, alpha=alpha), "Cramer-von Mises")
        jb = _require(distributions.jarque_bera_test(values, alpha=alpha), "Jarque-Bera")

        tests = [
            {"test_name": "shapiro_wilk", "statistic": shapiro.get("shapiro_statistic"), "p_value": shapiro.get("p_value")},
            {"test_name": "kolmogorov_smirnov", "statistic": ks.get("ks_statistic"), "p_value": ks.get("p_value")},
            {"test_name": "anderson_darling", "statistic": ad.get("ad_statistic"), "p_value": ad.get("p_value")},
            {"test_name": "cramer_von_mises", "statistic": cvm.get("cvm_statistic"), "p_value": cvm.get("p_value")},
            {"test_name": "jarque_bera", "statistic": jb.get("jb_statistic"), "p_value": jb.get("p_value")},
        ]

        pass_count = sum(
            1 for t in tests
            if t.get("p_value") is not None and t.get("p_value") >= alpha
        )
        total_tests = len(tests)
        overall_decision = (
            "All tests suggest normality"
            if pass_count == total_tests
            else f"{pass_count} of {total_tests} tests suggest normality"
        )

        n = shapiro.get("n") or ks.get("n") or ad.get("n") or cvm.get("n") or jb.get("n")

        return {
            "success": True,
            "results": {
                "tests": tests,
                "overall_decision": overall_decision,
                "n": n,
            },
        }

    elif test_name == "outlier_detection":
        values = data.get("values", [])
        methods = params.get("methods", ['iqr', 'zscore', 'modified_zscore'])
        alpha = params.get("alpha", 0.05)
        return {"success": True, "results": descriptive.outlier_detection(values, methods=methods, alpha=alpha)}

    # =========================================================================
    # GROUP 6: SURVIVAL ANALYSIS (3 tests)
    # =========================================================================

    elif test_name == "kaplan_meier":
        times = data.get("times", [])
        events = data.get("events", [])
        groups = data.get("groups")
        alpha = params.get("alpha", 0.05)
        event_encoding = normalize_event_encoding(params.get("event_encoding"))
        time_name = data.get("time_name", "Time")
        event_name = data.get("event_name", "Event")
        group_name = data.get("group_name")

        result = survival.kaplan_meier_from_arrays(
            times=times,
            events=events,
            groups=groups,
            alpha=alpha,
            time_name=time_name,
            event_name=event_name,
            group_name=group_name,
            event_encoding=event_encoding
        )
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "cox_regression":
        times = data.get("times", [])
        events = data.get("events", [])
        covariates = data.get("covariates", {})
        alpha = params.get("alpha", 0.05)
        event_encoding = normalize_event_encoding(params.get("event_encoding"))
        time_name = data.get("time_name", "Time")
        event_name = data.get("event_name", "Event")

        def _cox_progress_callback(progress_event: dict) -> None:
            if not isinstance(progress_event, dict):
                return
            stage = progress_event.get("stage", "cox_progress")
            message = progress_event.get("message", "Running Cox regression")
            percent = progress_event.get("percent")
            emit_stats_progress(stage=stage, message=message, percent=percent, **{
                k: v for k, v in progress_event.items()
                if k not in {"stage", "message", "percent"}
            })

        emit_stats_progress(
            stage="cox_start",
            message="Starting Cox regression",
            percent=1.0,
            covariate_count=len(covariates) if isinstance(covariates, dict) else None
        )

        result = survival.cox_from_arrays(
            times=times,
            events=events,
            covariates=covariates,
            alpha=alpha,
            time_name=time_name,
            event_name=event_name,
            event_encoding=event_encoding,
            progress_callback=_cox_progress_callback
        )
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "nelson_aalen":
        times = data.get("times", [])
        events = data.get("events", [])
        groups = data.get("groups")
        custom_time_points = data.get("custom_time_points", [])
        hazard_bandwidth = params.get("hazard_bandwidth")
        alpha = params.get("alpha", 0.05)
        event_encoding = normalize_event_encoding(params.get("event_encoding"))
        time_name = data.get("time_name", "Time")
        event_name = data.get("event_name", "Event")
        group_name = data.get("group_name")

        result = survival.nelson_aalen_from_arrays(
            times=times,
            events=events,
            groups=groups,
            custom_time_points=custom_time_points,
            alpha=alpha,
            time_name=time_name,
            event_name=event_name,
            group_name=group_name,
            event_encoding=event_encoding,
            hazard_bandwidth=hazard_bandwidth
        )
        return add_sampling_metadata_to_result(result, sampling_metadata)

    # =========================================================================
    # GROUP 7: MEDIATION & MODERATION (4 tests)
    # =========================================================================

    elif test_name == "mediation_model4":
        # Model 4 - Simple mediation
        json_input = json.dumps({**data, **params})
        result = {"success": True, "results": json.loads(mediation.mediation_analysis(json_input))}
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "moderation_model1":
        # Model 1 - Simple moderation
        json_input = json.dumps({**data, **params})
        result = {"success": True, "results": json.loads(moderation.simple_moderation(json_input))}
        return add_sampling_metadata_to_result(result, sampling_metadata)

    elif test_name == "moderated_mediation_model7":
        # Model 7 - Moderated mediation
        json_input = json.dumps({**data, **params})
        result = {"success": True, "results": json.loads(moderation.moderated_mediation_model7(json_input))}
        return add_sampling_metadata_to_result(result, sampling_metadata)

    # =========================================================================
    # GROUP 8: RNA-SEQ (PyDESeq2)
    # =========================================================================

    elif test_name == "rnaseq_deseq2":
        # Full PyDESeq2 differential expression analysis
        _rnaseq_debug("[DEBUG] rnaseq_deseq2: Starting...")
        _ensure_rnaseq_module_loaded()

        _rnaseq_debug("[DEBUG] rnaseq_deseq2: RNASEQ_AVAILABLE=True")
        counts = data.get("counts", {})
        metadata_dict = data.get("metadata", {})
        design_formula = params.get("design_formula", "~treatment")
        contrast = params.get("contrast")
        interaction_contrast = params.get("interaction_contrast")
        factor_reference_levels = params.get("factor_reference_levels")
        subset_filters = params.get("subset_filters")
        covariates = params.get("covariates")
        pca_group_by = params.get("pca_group_by")
        options = params.get("options", {})

        if contrast is None and not interaction_contrast:
            normalized = str(design_formula).replace(" ", "")
            if normalized != "~1":
                contrast = ["treatment", "test", "control"]

        _rnaseq_debug(
            f"[DEBUG] rnaseq_deseq2: counts={len(counts)} genes, metadata={len(metadata_dict)} samples"
        )
        _rnaseq_debug(
            f"[DEBUG] rnaseq_deseq2: design_formula={design_formula}, contrast={contrast}"
        )
        _rnaseq_debug("[DEBUG] rnaseq_deseq2: Calling run_deseq2_analysis()...")

        result = run_deseq2_analysis(
            counts=counts,
            metadata=metadata_dict,
            design_formula=design_formula,
            contrast=contrast,
            interaction_contrast=interaction_contrast,
            factor_reference_levels=factor_reference_levels,
            subset_filters=subset_filters,
            covariates=covariates,
            apply_shrinkage=options.get("apply_shrinkage", False),
            shrinkage_method=options.get("shrinkage_method", "apeglm"),
            alpha=options.get("alpha", 0.05),
            min_count=options.get("min_count", 10),
            min_samples=options.get("min_samples", 3),
            use_padj_for_significance=options.get("use_padj_for_significance", True),
            compute_pca=options.get("compute_pca", True),
            compute_vst=options.get("compute_vst", True),
            annotate_genes=options.get("annotate_genes", True),
            organism=options.get("organism", "mmusculus"),
            pca_top_genes=options.get("pca_top_genes", 500),
            pca_gene_selection_mode=options.get("pca_gene_selection_mode", "significant_only"),
            pca_group_by=pca_group_by,
            confirm_warnings=options.get("confirm_warnings", False),
            fit_type=options.get("fit_type"),
            size_factors_fit_type=options.get("size_factors_fit_type"),
            refit_cooks=options.get("refit_cooks"),
            min_replicates=options.get("min_replicates"),
            cooks_filter=options.get("cooks_filter"),
            independent_filter=options.get("independent_filter")
        )
        _rnaseq_debug(
            f"[DEBUG] rnaseq_deseq2: run_deseq2_analysis returned, success={result.get('success')}"
        )
        return result

    elif test_name == "rnaseq_annotate":
        # Gene annotation only
        _ensure_rnaseq_module_loaded()

        gene_ids = data.get("gene_ids", [])
        organism = params.get("organism", "mmusculus")
        use_cache = params.get("use_cache", True)

        mappings = get_gene_symbols(
            ensembl_ids=gene_ids,
            organism=organism,
            use_cache=use_cache
        )
        return {
            "success": True,
            "result": {
                "mappings": mappings,
                "unmapped_count": sum(1 for k, v in mappings.items() if k == v),
                "source": "biomart_cache" if use_cache else "biomart_live"
            }
        }

    elif test_name == "rnaseq_pca":
        # PCA computation only
        _ensure_rnaseq_module_loaded()

        import pandas as pd
        counts = data.get("counts", {})
        metadata_dict = data.get("metadata", {})
        n_top_genes = params.get("n_top_genes", 500)
        gene_symbols = params.get("gene_symbols", {})

        count_df = pd.DataFrame.from_dict(counts, orient='index')
        meta_df = pd.DataFrame.from_dict(metadata_dict, orient='index')

        def _align_samples_case_insensitive(counts_frame, metadata_frame):
            count_columns = list(counts_frame.columns)
            meta_index = list(metadata_frame.index)

            def _case_collision(values, label):
                collisions = {}
                for value in values:
                    key = str(value).lower()
                    collisions.setdefault(key, []).append(value)
                duplicates = {k: v for k, v in collisions.items() if len(v) > 1}
                if duplicates:
                    examples = []
                    for key, items in sorted(duplicates.items())[:5]:
                        examples.append(f"{key} -> {', '.join(map(str, items))}")
                    suffix = "..." if len(duplicates) > len(examples) else ""
                    raise ValueError(
                        f"Duplicate {label} IDs differing only by case: {', '.join(examples)}{suffix}"
                    )

            _case_collision(meta_index, "metadata sample")
            _case_collision(count_columns, "count sample")

            meta_lower = {str(idx).lower(): idx for idx in meta_index}
            mapping = {}
            for col in count_columns:
                if col in meta_index:
                    mapping[col] = col
                else:
                    key = str(col).lower()
                    if key in meta_lower:
                        mapping[col] = meta_lower[key]

            if not mapping:
                raise ValueError("No overlapping sample IDs between counts and metadata.")

            if any(k != v for k, v in mapping.items()):
                counts_frame = counts_frame.rename(columns=mapping)

            common = list(mapping.values())
            counts_frame = counts_frame[common]
            metadata_frame = metadata_frame.loc[common]
            return counts_frame, metadata_frame

        count_df, meta_df = _align_samples_case_insensitive(count_df, meta_df)

        pca_result = compute_pca_for_biplot(
            count_matrix=count_df,
            metadata=meta_df,
            n_top_genes=n_top_genes,
            gene_symbols=gene_symbols
        )
        return {"success": True, "result": pca_result}

    elif test_name == "rnaseq_validate":
        # Data validation only
        _ensure_rnaseq_module_loaded()

        counts = data.get("counts", {})
        metadata_dict = data.get("metadata", {})
        options = params.get("options", {}) if isinstance(params, dict) else {}
        min_count = options.get("min_count") or params.get("min_count") or 10

        count_validation = validate_count_matrix(counts, min_count=min_count)
        meta_validation = validate_metadata(metadata_dict)

        # Match samples
        count_samples = list(list(counts.values())[0].keys()) if counts else []
        meta_samples = list(metadata_dict.keys()) if metadata_dict else []
        sample_match = match_samples(count_samples, meta_samples)

        return {
            "success": True,
            "result": {
                "counts_validation": count_validation,
                "metadata_validation": meta_validation,
                "sample_matching": sample_match
            }
        }

    else:
        raise ValueError(f"Unknown test: {test_name}. See docstring for supported tests.")

    # Phase 7: This point should never be reached due to direct returns above
    # but if we refactor to use 'result' variable, add sampling metadata here
    if result is not None and sampling_metadata is not None:
        result = add_sampling_metadata_to_result(result, sampling_metadata)

    return result if result is not None else {"success": False, "error": "No result generated"}


def add_sampling_metadata_to_result(result: dict, sampling_metadata: dict) -> dict:
    """
    Phase 7: Add sampling metadata to a test result.

    Adds _sampling_metadata to results when sampling was used for large datasets.
    This allows the frontend to display a badge indicating sampled analysis.
    """
    if sampling_metadata is None:
        return result

    # Add sampling metadata to the results
    if 'results' in result and isinstance(result['results'], dict):
        result['results']['_sampling_metadata'] = sampling_metadata
    elif isinstance(result, dict):
        result['_sampling_metadata'] = sampling_metadata

    return result


def main():
    """Read JSON from stdin, execute test, write JSON to stdout."""
    try:
        # Read control payload from stdin
        input_json = sys.stdin.read()

        if not input_json.strip():
            raise ValueError("Empty input received from stdin")

        payload = json.loads(input_json)

        # Execute statistical test
        result = run_statistical_test(payload)

        # Ensure result is a dictionary with 'success' field
        if not isinstance(result, dict):
            result = {"success": True, "results": result}

        if "success" not in result:
            result["success"] = True

        # Write strict JSON to stdout (no NaN/Infinity tokens).
        print(dumps_strict_json(result, indent=2))
        sys.exit(0)

    except json.JSONDecodeError as e:
        # JSON parsing error
        error_result = {
            "success": False,
            "error": f"Invalid JSON input: {str(e)}",
            "error_type": "JSONDecodeError"
        }
        print(dumps_strict_json(error_result, indent=None))
        sys.exit(0)  # Exit 0 so caller can parse JSON error

    except Exception as e:
        # Write error to stdout (Rust will parse this)
        error_result = {
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        }
        print(dumps_strict_json(error_result, indent=None))
        sys.exit(0)  # Exit 0 so caller can parse JSON error


if __name__ == "__main__":
    main()
