"""
RNA-seq Backend Entry Point
Standalone backend for RNA-seq analysis with progress streaming.

Reads JSON payload from stdin and writes JSON result to stdout.
Progress updates are emitted via rnaseq_module.utils.emit_progress (stderr).
"""

import json
import os
import re
import socket
import sys
from typing import Any, Dict, List, Optional, Tuple

def _is_offline_mode_enabled() -> bool:
    raw = str(os.environ.get("EASYCRIS_OFFLINE", "0")).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _enforce_offline_mode() -> None:
    if not _is_offline_mode_enabled():
        return

    def _blocked(*_args, **_kwargs):
        raise OSError("Outbound network is disabled by EASYCRIS_OFFLINE=1")

    socket.create_connection = _blocked  # type: ignore[assignment]
    original_socket = socket.socket

    class OfflineSocket(original_socket):  # type: ignore[misc]
        def connect(self, *_args, **_kwargs):  # type: ignore[override]
            raise OSError("Outbound network is disabled by EASYCRIS_OFFLINE=1")

        def connect_ex(self, *_args, **_kwargs):  # type: ignore[override]
            return 10013  # WSAEACCES

    socket.socket = OfflineSocket  # type: ignore[assignment]


_enforce_offline_mode()

try:
    from rnaseq_module import (
        run_deseq2_analysis,
        get_gene_symbols,
        compute_pca_for_biplot,
        render_heatmap_image,
        validate_count_matrix,
        validate_metadata,
        match_samples,
    )
    RNASEQ_AVAILABLE = True
except ImportError:
    RNASEQ_AVAILABLE = False
    run_deseq2_analysis = None
    get_gene_symbols = None
    compute_pca_for_biplot = None
    render_heatmap_image = None
    validate_count_matrix = None
    validate_metadata = None
    match_samples = None

MISSING_LABEL_BLOCK_PCT_DEFAULT = 5.0


def _build_label_quality_summary(total_rows: int, usable_rows: int) -> Dict[str, Any]:
    total = max(0, int(total_rows or 0))
    usable = max(0, int(usable_rows or 0))
    if usable > total:
        usable = total
    missing = total - usable
    missing_pct = (float(missing) / float(total) * 100.0) if total > 0 else 0.0
    return {
        "total_label_rows": total,
        "usable_label_rows": usable,
        "missing_label_rows": missing,
        "missing_label_pct": missing_pct,
    }


def _load_columnar_dataframe(path: str):
    import pyarrow as pa
    import pyarrow.ipc as ipc
    import pyarrow.parquet as pq

    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"Columnar file not found: {path}")

    ext = os.path.splitext(path)[1].lower()
    if ext in (".parquet", ".parq"):
        table = pq.read_table(path)
        return table.to_pandas()

    with pa.memory_map(path, "r") as source:
        reader = ipc.RecordBatchFileReader(source)
        table = reader.read_all()
    return table.to_pandas()


def _apply_column_mapping(df, columns: Any) -> Tuple[Any, List[str]]:
    if not isinstance(columns, list) or not columns:
        return df, list(df.columns)

    mapping: Dict[str, str] = {}
    ordered: List[str] = []
    for col in columns:
        if not isinstance(col, dict):
            continue
        col_id = col.get("id") or col.get("columnId")
        if not col_id:
            continue
        display = col.get("name") or col.get("displayName") or col_id
        mapping[col_id] = display
        ordered.append(display)

    if mapping:
        df = df.rename(columns=mapping)

    if ordered:
        existing = [name for name in ordered if name in df.columns]
        if existing:
            remainder = [name for name in df.columns if name not in existing]
            df = df[existing + remainder]
            return df, existing

    return df, list(df.columns)


def _normalize_ensembl_gene_id(raw_id: str) -> str:
    trimmed = str(raw_id).strip()
    match = re.match(r"^(.+)\.(\d+)$", trimmed)
    if not match:
        return trimmed
    base = match.group(1) or ""
    if not base.startswith("ENS"):
        return trimmed
    return base


def _build_merge_warnings(raw_ids: List[str], normalized_ids: List[str]) -> List[str]:
    merged_count = 0
    examples: List[str] = []
    seen = set()

    for raw_id, normalized in zip(raw_ids, normalized_ids):
        if raw_id == normalized:
            continue
        merged_count += 1
        pair = f"{raw_id} -> {normalized}"
        if pair in seen:
            continue
        seen.add(pair)
        if len(examples) < 5:
            examples.append(pair)

    if merged_count == 0:
        return []

    preview = ", ".join(examples) if examples else "N/A"
    return [
        f"{merged_count} Ensembl IDs with version suffixes were merged by base ID. "
        f"Examples: {preview}."
    ]


def _normalize_gene_label_source(raw_value: Any) -> str:
    value = str(raw_value or "id_lookup").strip().lower()
    if value not in {"id_lookup", "user_provided"}:
        return "id_lookup"
    return value


def _normalize_duplicate_policy(raw_value: Any) -> str:
    value = str(raw_value or "sum_duplicates").strip().lower()
    if value not in {"sum_duplicates", "keep_first"}:
        return "sum_duplicates"
    return value


def _summarize_duplicate_labels(labels: List[str]) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    for label in labels:
        normalized = str(label).strip()
        if not normalized:
            continue
        counts[normalized] = counts.get(normalized, 0) + 1

    duplicates = [(label, count) for label, count in counts.items() if count > 1]
    duplicate_id_count = len(duplicates)
    duplicate_row_count = sum(count - 1 for _, count in duplicates)
    duplicate_examples = [label for label, _ in duplicates[:5]]
    return {
        "duplicate_id_count": duplicate_id_count,
        "duplicate_row_count": duplicate_row_count,
        "duplicate_examples": duplicate_examples,
    }


def _normalize_gene_ids_for_counts(
    gene_ids: List[str],
    *,
    gene_label_source: str,
    gene_id_type: str,
) -> List[str]:
    if gene_label_source == "user_provided":
        return [str(gid).strip() for gid in gene_ids]
    if str(gene_id_type or "").strip().lower() == "ensembl":
        return [_normalize_ensembl_gene_id(gid) for gid in gene_ids]
    return [str(gid).strip() for gid in gene_ids]


def _build_counts_from_arrow(
    path: str,
    columns: Any,
    *,
    gene_label_source: str = "id_lookup",
    gene_id_type: str = "ensembl",
    duplicate_policy: str = "sum_duplicates",
):
    import pandas as pd

    df = _load_columnar_dataframe(path)
    df, ordered = _apply_column_mapping(df, columns)
    if not ordered:
        ordered = list(df.columns)
    if not ordered:
        empty_summary = _build_label_quality_summary(0, 0)
        return pd.DataFrame(), [], {
            "duplicate_id_count": 0,
            "duplicate_row_count": 0,
            "duplicate_examples": [],
        }, empty_summary

    gene_col = ordered[0]
    keep_cols = [gene_col] + [col for col in ordered[1:] if col in df.columns]
    df = df[keep_cols]
    total_label_rows = len(df)

    gene_series = df[gene_col].fillna("").astype(str).str.strip()
    mask = gene_series != ""
    if not mask.any():
        label_quality = _build_label_quality_summary(total_label_rows, 0)
        return pd.DataFrame(), [], {
            "duplicate_id_count": 0,
            "duplicate_row_count": 0,
            "duplicate_examples": [],
        }, label_quality

    df = df.loc[mask].copy()
    label_quality = _build_label_quality_summary(total_label_rows, len(df))
    gene_series = gene_series.loc[mask]
    raw_gene_ids = gene_series.tolist()
    normalized_gene_ids = _normalize_gene_ids_for_counts(
        raw_gene_ids,
        gene_label_source=gene_label_source,
        gene_id_type=gene_id_type,
    )
    warnings = (
        _build_merge_warnings(raw_gene_ids, normalized_gene_ids)
        if gene_label_source != "user_provided" and str(gene_id_type).strip().lower() == "ensembl"
        else []
    )

    def _column_has_structural_data(series) -> bool:
        for value in series.tolist():
            if value is None:
                continue
            if isinstance(value, str):
                if value.strip() == "":
                    continue
                return True
            try:
                if pd.isna(value):
                    continue
            except Exception:
                pass
            return True
        return False

    df[gene_col] = normalized_gene_ids
    sample_cols = [col for col in df.columns if col != gene_col]
    if sample_cols:
        active_sample_cols = [col for col in sample_cols if _column_has_structural_data(df[col])]
        dropped_structurally_empty = len(sample_cols) - len(active_sample_cols)
        if dropped_structurally_empty > 0:
            warnings.append(
                f"Dropped {dropped_structurally_empty} structurally empty sample column(s) before sample matching."
            )
        sample_cols = active_sample_cols

    if not sample_cols:
        raise ValueError(
            "No usable count sample columns found after removing structurally empty columns. "
            "Re-import counts without padded empty columns or ensure sample columns contain data."
        )

    df = df[[gene_col] + sample_cols]
    if sample_cols:
        df[sample_cols] = df[sample_cols].apply(pd.to_numeric, errors="coerce").fillna(0)

    duplicate_summary = _summarize_duplicate_labels(df[gene_col].tolist())
    if duplicate_policy == "keep_first":
        dedup_df = df.drop_duplicates(subset=[gene_col], keep="first")
        if sample_cols:
            counts_df = dedup_df.set_index(gene_col)[sample_cols]
        else:
            counts_df = dedup_df.set_index(gene_col).iloc[:, 0:0]
    else:
        if sample_cols:
            counts_df = df.groupby(gene_col, sort=False)[sample_cols].sum()
        else:
            counts_df = df.groupby(gene_col, sort=False).size().to_frame().iloc[:, 0:0]

    if (
        gene_label_source == "user_provided"
        and duplicate_summary["duplicate_id_count"] > 0
    ):
        preview = ", ".join(duplicate_summary["duplicate_examples"]) or "N/A"
        warnings.append(
            f"Detected {duplicate_summary['duplicate_id_count']} duplicate user-provided gene label(s) "
            f"({duplicate_summary['duplicate_row_count']} duplicate row(s)). "
            f"Applied duplicate policy: {duplicate_policy}. Examples: {preview}."
        )

    return counts_df, warnings, duplicate_summary, label_quality


def _normalize_counts_dict(
    counts: Dict[str, Dict[str, Any]],
    *,
    gene_label_source: str = "id_lookup",
    gene_id_type: str = "ensembl",
    duplicate_policy: str = "sum_duplicates",
) -> Tuple[Dict[str, Dict[str, float]], List[str], Dict[str, Any], Dict[str, Any]]:
    if not counts:
        empty_summary = _build_label_quality_summary(0, 0)
        return counts, [], {
            "duplicate_id_count": 0,
            "duplicate_row_count": 0,
            "duplicate_examples": [],
        }, empty_summary

    raw_ids = list(counts.keys())
    normalized_ids = _normalize_gene_ids_for_counts(
        raw_ids,
        gene_label_source=gene_label_source,
        gene_id_type=gene_id_type,
    )
    warnings = (
        _build_merge_warnings(raw_ids, normalized_ids)
        if gene_label_source != "user_provided" and str(gene_id_type).strip().lower() == "ensembl"
        else []
    )
    filtered_raw_ids: List[str] = []
    filtered_normalized_ids: List[str] = []
    for raw_id, normalized_id in zip(raw_ids, normalized_ids):
        normalized = str(normalized_id).strip()
        if not normalized:
            continue
        filtered_raw_ids.append(raw_id)
        filtered_normalized_ids.append(normalized)

    label_quality = _build_label_quality_summary(len(raw_ids), len(filtered_normalized_ids))
    duplicate_summary = _summarize_duplicate_labels(filtered_normalized_ids)

    merged: Dict[str, Dict[str, float]] = {}
    seen_ids: set = set()
    for raw_id, normalized_id in zip(filtered_raw_ids, filtered_normalized_ids):
        if duplicate_policy == "keep_first" and normalized_id in seen_ids:
            continue
        seen_ids.add(normalized_id)
        row = counts.get(raw_id, {}) or {}
        target = merged.setdefault(normalized_id, {})
        for sample_id, value in row.items():
            try:
                numeric = float(value)
            except Exception:
                numeric = 0.0
            if duplicate_policy == "keep_first":
                target[sample_id] = numeric
            else:
                target[sample_id] = target.get(sample_id, 0.0) + numeric

    if (
        gene_label_source == "user_provided"
        and duplicate_summary["duplicate_id_count"] > 0
    ):
        preview = ", ".join(duplicate_summary["duplicate_examples"]) or "N/A"
        warnings.append(
            f"Detected {duplicate_summary['duplicate_id_count']} duplicate user-provided gene label(s) "
            f"({duplicate_summary['duplicate_row_count']} duplicate row(s)). "
            f"Applied duplicate policy: {duplicate_policy}. Examples: {preview}."
        )

    return merged, warnings, duplicate_summary, label_quality


def _coerce_metadata_value(value: Any):
    import pandas as pd

    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        return value
    return str(value)


def _build_metadata_from_arrow(path: str, columns: Any):
    df = _load_columnar_dataframe(path)
    df, ordered = _apply_column_mapping(df, columns)
    if not ordered:
        ordered = list(df.columns)
    if not ordered:
        return df

    sample_col = ordered[0]
    keep_cols = [sample_col] + [col for col in ordered[1:] if col in df.columns]
    df = df[keep_cols]

    sample_series = df[sample_col].fillna("").astype(str).str.strip()
    mask = sample_series != ""
    df = df.loc[mask].copy()
    df[sample_col] = sample_series.loc[mask].values
    df = df.set_index(sample_col)

    for col in df.columns:
        df[col] = df[col].map(_coerce_metadata_value)

    return df


def _resolve_counts_metadata(data: Dict[str, Any], params: Optional[Dict[str, Any]] = None):
    params = params or {}
    options = params.get("options", {}) if isinstance(params, dict) else {}
    gene_id_type = options.get("gene_id_type") or params.get("gene_id_type") or "ensembl"
    gene_label_source = _normalize_gene_label_source(
        options.get("gene_label_source") or params.get("gene_label_source")
    )
    duplicate_policy = _normalize_duplicate_policy(
        options.get("duplicate_policy") or params.get("duplicate_policy")
    )

    counts_arrow_path = data.get("counts_arrow_path") or data.get("countsArrowPath")
    metadata_arrow_path = data.get("metadata_arrow_path") or data.get("metadataArrowPath")
    counts_columns = data.get("counts_columns") or data.get("countsColumns")
    metadata_columns = data.get("metadata_columns") or data.get("metadataColumns")

    if counts_arrow_path and metadata_arrow_path:
        counts_df, warnings, duplicate_summary, label_quality = _build_counts_from_arrow(
            counts_arrow_path,
            counts_columns,
            gene_label_source=gene_label_source,
            gene_id_type=gene_id_type,
            duplicate_policy=duplicate_policy,
        )
        metadata_df = _build_metadata_from_arrow(metadata_arrow_path, metadata_columns)
        return counts_df, metadata_df, warnings, duplicate_summary, label_quality

    counts = data.get("counts", {}) or {}
    metadata = data.get("metadata", {}) or {}
    normalized_counts, warnings, duplicate_summary, label_quality = (
        _normalize_counts_dict(
            counts,
            gene_label_source=gene_label_source,
            gene_id_type=gene_id_type,
            duplicate_policy=duplicate_policy,
        )
        if isinstance(counts, dict)
        else (
            counts,
            [],
            {"duplicate_id_count": 0, "duplicate_row_count": 0, "duplicate_examples": []},
            _build_label_quality_summary(0, 0),
        )
    )
    hint_missing = options.get("missing_label_rows_hint")
    hint_usable = options.get("usable_label_rows_hint")
    if isinstance(hint_missing, (int, float)) or isinstance(hint_usable, (int, float)):
        missing_hint = int(hint_missing or 0)
        usable_hint = int(hint_usable or 0)
        if missing_hint < 0:
            missing_hint = 0
        if usable_hint < 0:
            usable_hint = 0
        total_hint = missing_hint + usable_hint
        if total_hint > 0:
            label_quality = _build_label_quality_summary(total_hint, usable_hint)
    return normalized_counts, metadata, warnings, duplicate_summary, label_quality


def _normalize_sample_id(raw: Any) -> str:
    if raw is None:
        return ""
    return str(raw).strip()


def _summarize_sample_ids(samples: List[Any]) -> Dict[str, Any]:
    missing_count = 0
    counts: Dict[str, int] = {}
    examples: Dict[str, str] = {}

    for raw in samples:
        normalized = _normalize_sample_id(raw)
        if not normalized:
            missing_count += 1
            continue
        key = normalized.lower()
        counts[key] = counts.get(key, 0) + 1
        if key not in examples:
            examples[key] = normalized

    duplicate_keys = [key for key, count in counts.items() if count > 1]
    duplicate_id_count = len(duplicate_keys)
    duplicate_row_count = sum(counts[key] - 1 for key in duplicate_keys)
    duplicate_examples = [examples[key] for key in duplicate_keys[:5]]

    return {
        "missing_count": missing_count,
        "duplicate_id_count": duplicate_id_count,
        "duplicate_row_count": duplicate_row_count,
        "duplicate_examples": duplicate_examples,
        "unique_keys": set(counts.keys()),
        "examples_by_key": examples,
        "total_nonempty": sum(counts.values()),
    }


def _preview_ids(keys: set, samples: List[Any], max_preview: int) -> List[str]:
    preview: List[str] = []
    seen: set = set()
    for raw in samples:
        normalized = _normalize_sample_id(raw)
        if not normalized:
            continue
        key = normalized.lower()
        if key in keys and key not in seen:
            preview.append(normalized)
            seen.add(key)
            if len(preview) >= max_preview:
                break
    return preview


def _build_sample_match_summary(
    count_samples: List[Any],
    metadata_samples: List[Any],
    max_preview: int = 10,
) -> Dict[str, Any]:
    count_summary = _summarize_sample_ids(count_samples)
    meta_summary = _summarize_sample_ids(metadata_samples)

    count_keys = count_summary["unique_keys"]
    meta_keys = meta_summary["unique_keys"]

    matched_keys = count_keys & meta_keys
    only_in_counts_keys = count_keys - meta_keys
    only_in_metadata_keys = meta_keys - count_keys

    only_counts_preview = _preview_ids(only_in_counts_keys, count_samples, max_preview)
    only_meta_preview = _preview_ids(only_in_metadata_keys, metadata_samples, max_preview)

    if only_in_counts_keys:
        status = "error"
        message_parts = [f"Samples in counts but not in metadata: {only_counts_preview}"]
        if only_in_metadata_keys:
            message_parts.append(f"Samples in metadata but not in counts (will be ignored): {only_meta_preview}")
        message = "\n".join(message_parts)
    elif only_in_metadata_keys:
        status = "warning"
        message = f"Samples in metadata but not in counts (will be ignored): {only_meta_preview}"
    else:
        status = "ok"
        message = "All samples matched"

    return {
        "status": status,
        "message": message,
        "matched_samples": _preview_ids(matched_keys, count_samples, max_preview),
        "only_in_counts": only_counts_preview,
        "only_in_metadata": only_meta_preview,
        "match_count": len(matched_keys),
        "total_count_samples": count_summary["total_nonempty"],
        "total_meta_samples": meta_summary["total_nonempty"],
    }


def run_rnaseq(payload: dict) -> dict:
    test_name = (
        payload.get("test")
        or payload.get("test_name")
        or payload.get("testName")
        or "rnaseq_deseq2"
    )
    data = payload.get("data", {}) or {}
    params = payload.get("parameters", {}) or {}

    if not RNASEQ_AVAILABLE:
        raise RuntimeError(
            "RNA-seq module is not available. Install PyDESeq2: "
            "pip install pydeseq2 --target python_embedded/python_dependencies/"
        )

    if test_name == "rnaseq_deseq2":
        counts, metadata_dict, merge_warnings, duplicate_summary, label_quality_summary = _resolve_counts_metadata(data, params)
        design_formula = params.get("design_formula", "~treatment")
        contrast = params.get("contrast")
        interaction_contrast = params.get("interaction_contrast")
        factor_reference_levels = params.get("factor_reference_levels")
        subset_filters = params.get("subset_filters")
        covariates = params.get("covariates")
        pca_group_by = params.get("pca_group_by")
        options = params.get("options", {})
        gene_id_type = options.get("gene_id_type") or params.get("gene_id_type") or "ensembl"
        gene_label_source = _normalize_gene_label_source(
            options.get("gene_label_source") or params.get("gene_label_source")
        )
        duplicate_policy = _normalize_duplicate_policy(
            options.get("duplicate_policy") or params.get("duplicate_policy")
        )
        duplicate_count = int(duplicate_summary.get("duplicate_id_count")) if isinstance(duplicate_summary, dict) else 0
        try:
            duplicate_count_hint = int(options.get("duplicate_count_hint") or params.get("duplicate_count_hint") or 0)
        except Exception:
            duplicate_count_hint = 0
        duplicate_count = max(duplicate_count, duplicate_count_hint)
        missing_label_rows = int(label_quality_summary.get("missing_label_rows", 0)) if isinstance(label_quality_summary, dict) else 0
        usable_label_rows = int(label_quality_summary.get("usable_label_rows", 0)) if isinstance(label_quality_summary, dict) else 0
        missing_label_pct = float(label_quality_summary.get("missing_label_pct", 0.0)) if isinstance(label_quality_summary, dict) else 0.0
        if missing_label_rows > 0:
            merge_warnings.append(
                f"Dropped {missing_label_rows} row(s) with empty gene labels before analysis "
                f"({missing_label_pct:.2f}% of label rows; {usable_label_rows} usable row(s) remain)."
            )
            max_missing_label_pct = options.get("max_missing_label_pct", MISSING_LABEL_BLOCK_PCT_DEFAULT)
            try:
                max_missing_label_pct = float(max_missing_label_pct)
            except Exception:
                max_missing_label_pct = MISSING_LABEL_BLOCK_PCT_DEFAULT
            if max_missing_label_pct < 0:
                max_missing_label_pct = 0.0
            if missing_label_pct > max_missing_label_pct:
                raise ValueError(
                    f"Count matrix has {missing_label_rows} row(s) with empty gene labels "
                    f"({missing_label_pct:.2f}%), exceeding the allowed threshold "
                    f"({max_missing_label_pct:.2f}%). Please fill or remove blank gene labels and retry."
                )
            if not options.get("confirm_warnings", False):
                deduped = []
                seen = set()
                for warning in merge_warnings:
                    if warning in seen:
                        continue
                    seen.add(warning)
                    deduped.append(warning)
                return {
                    "success": False,
                    "requires_confirmation": True,
                    "warnings": deduped,
                    "missing_label_rows": missing_label_rows,
                    "usable_label_rows": usable_label_rows,
                    "missing_label_pct": missing_label_pct,
                }

        # Basic input validation for clearer errors
        if counts is None or (hasattr(counts, "empty") and counts.empty) or (
            isinstance(counts, dict) and len(counts) == 0
        ):
            raise ValueError("Count matrix is missing or empty.")
        if metadata_dict is None or (hasattr(metadata_dict, "empty") and metadata_dict.empty) or (
            isinstance(metadata_dict, dict) and len(metadata_dict) == 0
        ):
            raise ValueError("Metadata is missing or empty.")

        if not isinstance(design_formula, str) or not design_formula.strip():
            raise ValueError("design_formula is required and must be a non-empty string.")
        if "~" not in design_formula:
            raise ValueError("design_formula must include '~' (e.g., '~treatment').")
        if not re.match(r"^[~\sA-Za-z0-9_\.\+\*:\-\(\)`\^\/]+$", design_formula):
            raise ValueError(
                "design_formula contains invalid characters. "
                "Use letters, numbers, underscores, + * : - ( ) . ` ^ / and spaces."
            )

        if contrast is None and not interaction_contrast:
            normalized = str(design_formula).replace(" ", "")
            if normalized != "~1":
                raise ValueError(
                    "Missing contrast configuration for non-null model. "
                    "Provide either contrast=[factor, test, reference] "
                    "or interaction_contrast."
                )

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
            gene_id_type=gene_id_type,
            gene_label_source=gene_label_source,
            duplicate_policy=duplicate_policy,
            duplicate_count=duplicate_count,
            pca_top_genes=options.get("pca_top_genes", 500),
            pca_gene_selection_mode=options.get("pca_gene_selection_mode", "significant_only"),
            pca_group_by=pca_group_by,
            confirm_warnings=options.get("confirm_warnings", False),
            round_counts=options.get("round_counts", False),
            quiet=options.get("quiet", True),
            annotation_refresh=options.get("annotation_refresh", "auto"),
            annotation_refresh_days=options.get("annotation_refresh_days", 30),
            annotation_allow_online=False,
        )
        if merge_warnings:
            existing = result.get("warnings", [])
            if not isinstance(existing, list):
                existing = []
            merged = existing + merge_warnings
            deduped = []
            seen = set()
            for warning in merged:
                if warning in seen:
                    continue
                seen.add(warning)
                deduped.append(warning)
            result["warnings"] = deduped
        result["gene_label_source"] = gene_label_source
        result["duplicate_policy"] = duplicate_policy
        result["duplicate_count"] = duplicate_count
        result["missing_label_rows"] = missing_label_rows
        result["usable_label_rows"] = usable_label_rows
        result["missing_label_pct"] = missing_label_pct
        result["round_counts"] = bool(result.get("round_counts", options.get("round_counts", False)))
        result["rounding_method"] = result.get("rounding_method")
        result["non_integer_samples_detected"] = int(result.get("non_integer_samples_detected", 0))
        result["non_integer_cells_detected"] = int(result.get("non_integer_cells_detected", 0))
        if isinstance(result.get("parameters"), dict):
            result["parameters"]["gene_label_source"] = gene_label_source
            result["parameters"]["duplicate_policy"] = duplicate_policy
            result["parameters"]["duplicate_count"] = duplicate_count
            result["parameters"]["missing_label_rows"] = missing_label_rows
            result["parameters"]["usable_label_rows"] = usable_label_rows
            result["parameters"]["missing_label_pct"] = missing_label_pct
            result["parameters"]["round_counts"] = bool(
                result["parameters"].get("round_counts", options.get("round_counts", False))
            )
            result["parameters"]["rounding_method"] = result["parameters"].get("rounding_method")
            result["parameters"]["non_integer_samples_detected"] = int(
                result["parameters"].get("non_integer_samples_detected", result.get("non_integer_samples_detected", 0))
            )
            result["parameters"]["non_integer_cells_detected"] = int(
                result["parameters"].get("non_integer_cells_detected", result.get("non_integer_cells_detected", 0))
            )
        return result

    if test_name == "rnaseq_annotate":
        gene_ids = data.get("gene_ids", [])
        organism = params.get("organism", "mmusculus")
        gene_id_type = params.get("gene_id_type", "ensembl")
        use_cache = params.get("use_cache", True)
        mappings = get_gene_symbols(
            gene_ids=gene_ids,
            organism=organism,
            gene_id_type=gene_id_type,
            use_cache=use_cache
        )
        return {
            "success": True,
            "result": {
                "mappings": mappings,
                "unmapped_count": sum(1 for k, v in mappings.items() if k == v),
                "source": "local_cache",
            },
        }

    if test_name == "rnaseq_pca":
        import pandas as pd
        counts, metadata_dict, _, _, _ = _resolve_counts_metadata(data, params)
        n_top_genes = params.get("n_top_genes", 500)
        gene_symbols = params.get("gene_symbols", {})

        count_df = counts if isinstance(counts, pd.DataFrame) else pd.DataFrame.from_dict(counts, orient="index")
        meta_df = metadata_dict if isinstance(metadata_dict, pd.DataFrame) else pd.DataFrame.from_dict(metadata_dict, orient="index")

        pca_result = compute_pca_for_biplot(
            count_matrix=count_df,
            metadata=meta_df,
            n_top_genes=n_top_genes,
            gene_symbols=gene_symbols,
        )
        return {"success": True, "result": pca_result}

    if test_name == "rnaseq_heatmap":
        if render_heatmap_image is None:
            raise RuntimeError("Heatmap renderer is not available.")

        genes = data.get("genes", [])
        normalized_counts = data.get("normalized_counts") or data.get("normalizedCounts")
        sample_ids = data.get("sample_ids") or data.get("sampleIds") or []
        options = params.get("options", {}) if isinstance(params, dict) else {}

        result = render_heatmap_image(
            genes=genes,
            normalized_counts=normalized_counts or [],
            sample_ids=sample_ids,
            options=options,
        )
        return {"success": True, "result": result}

    if test_name == "rnaseq_validate":
        counts, metadata_dict, _, _, _ = _resolve_counts_metadata(data, params)

        if hasattr(counts, "to_dict"):
            counts = counts.to_dict(orient="index")
        if hasattr(metadata_dict, "to_dict"):
            metadata_dict = metadata_dict.to_dict(orient="index")

        options = params.get("options", {}) if isinstance(params, dict) else {}
        min_count = options.get("min_count") or params.get("min_count") or 10
        count_validation = validate_count_matrix(counts, min_count=min_count)
        meta_validation = validate_metadata(metadata_dict)

        count_samples = list(list(counts.values())[0].keys()) if counts else []
        meta_samples = list(metadata_dict.keys()) if metadata_dict else []
        sample_match = match_samples(count_samples, meta_samples)

        return {
            "success": True,
            "result": {
                "counts_validation": count_validation,
                "metadata_validation": meta_validation,
                "sample_matching": sample_match,
            },
        }

    if test_name == "rnaseq_validate_samples":
        max_preview = params.get("max_preview")
        if not isinstance(max_preview, int) or max_preview <= 0:
            options = params.get("options", {}) if isinstance(params, dict) else {}
            max_preview = options.get("max_preview")
        if not isinstance(max_preview, int) or max_preview <= 0:
            max_preview = 10

        count_samples = data.get("counts_sample_ids") or data.get("count_samples") or []
        metadata_samples = data.get("metadata_sample_ids") or data.get("meta_samples") or []

        if not metadata_samples:
            counts_df = None
            metadata_df = None
            metadata_arrow_path = data.get("metadata_arrow_path") or data.get("metadataArrowPath")
            metadata_columns = data.get("metadata_columns") or data.get("metadataColumns")
            if metadata_arrow_path:
                metadata_df = _build_metadata_from_arrow(metadata_arrow_path, metadata_columns)
            if metadata_df is not None and hasattr(metadata_df, "index"):
                metadata_samples = metadata_df.index.tolist()

        if not count_samples:
            counts_columns = data.get("counts_columns") or data.get("countsColumns") or []
            if isinstance(counts_columns, list) and len(counts_columns) > 1:
                count_samples = [
                    col.get("name") or col.get("displayName") or col.get("id")
                    for col in counts_columns[1:]
                    if isinstance(col, dict)
                ]

        sample_match = _build_sample_match_summary(count_samples, metadata_samples, max_preview=max_preview)
        meta_summary = _summarize_sample_ids(metadata_samples)

        return {
            "success": True,
            "result": {
                "sample_matching": sample_match,
                "metadata_sample_validation": {
                    "missing_count": meta_summary["missing_count"],
                    "duplicate_id_count": meta_summary["duplicate_id_count"],
                    "duplicate_row_count": meta_summary["duplicate_row_count"],
                    "duplicate_examples": meta_summary["duplicate_examples"],
                },
            },
        }

    raise ValueError(f"Unknown RNA-seq test: {test_name}")


def main() -> None:
    try:
        payload_raw = sys.stdin.read()
        if not payload_raw.strip():
            raise ValueError("Empty input received from stdin")

        payload = json.loads(payload_raw)
        result = run_rnaseq(payload)

        if not isinstance(result, dict):
            result = {"success": True, "results": result}
        if "success" not in result:
            result["success"] = True

        print(json.dumps(result))
        sys.exit(0)
    except json.JSONDecodeError as e:
        error_result = {
            "success": False,
            "error": f"Invalid JSON input: {str(e)}",
            "error_type": "JSONDecodeError",
        }
        print(json.dumps(error_result))
        sys.exit(0)
    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__,
        }
        print(json.dumps(error_result))
        sys.exit(0)


if __name__ == "__main__":
    main()
