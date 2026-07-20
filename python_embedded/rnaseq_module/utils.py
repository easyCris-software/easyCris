"""
RNA-seq Module Utilities
Shared functions for validation, progress reporting, and data handling.

VERSION: 1.0.0
"""

import json
import sys
import numpy as np
from typing import Dict, List, Optional, Tuple, Any


def emit_progress(stage: str, percent: float, message: str) -> None:
    """
    Emit progress update to stdout for frontend consumption.

    Args:
        stage: Current processing stage (filtering, normalization, etc.)
        percent: Progress percentage (0-100)
        message: Human-readable status message
    """
    progress = {
        "type": "progress",
        "stage": stage,
        "percent": percent,
        "message": message
    }
    print(json.dumps(progress), file=sys.stderr, flush=True)


def validate_count_matrix(
    counts: Dict[str, Dict[str, int]],
    min_count: int = 10
) -> Dict[str, Any]:
    """
    Validate count matrix format and data integrity.

    Args:
        counts: Dict of {gene_id: {sample_id: count, ...}, ...}

    Returns:
        Dict with validation results:
        {
            "valid": bool,
            "gene_count": int,
            "sample_count": int,
            "errors": List[str],
            "warnings": List[str]
        }
    """
    errors = []
    warnings = []

    if not counts:
        errors.append("Count matrix is empty")
        return {"valid": False, "gene_count": 0, "sample_count": 0,
                "errors": errors, "warnings": warnings}

    gene_ids = list(counts.keys())
    gene_count = len(gene_ids)

    # Get sample IDs from first gene
    first_gene = gene_ids[0]
    sample_ids = list(counts[first_gene].keys())
    sample_count = len(sample_ids)

    if sample_count == 0:
        errors.append("No samples found in count matrix")
        return {"valid": False, "gene_count": gene_count, "sample_count": 0,
                "errors": errors, "warnings": warnings}

    # Validate each gene row
    low_count_genes = 0
    zero_genes = 0
    suspected_normalized = False

    for gene_id, counts_row in counts.items():
        # Check all samples are present
        if set(counts_row.keys()) != set(sample_ids):
            errors.append(f"Gene {gene_id} has inconsistent sample IDs")
            continue

        values = list(counts_row.values())

        # Check for non-integer values (indicates normalized data)
        for v in values:
            if isinstance(v, float) and not v.is_integer():
                suspected_normalized = True
                break

        # Check for negative values
        if any(v < 0 for v in values):
            errors.append(f"Gene {gene_id} has negative count values")
            continue

        # Track low-count and zero genes
        max_count = max(values) if values else 0
        if max_count < min_count:
            low_count_genes += 1
        if max_count == 0:
            zero_genes += 1

    # Add warnings
    if suspected_normalized:
        warnings.append(
            "Count matrix contains decimal values. PyDESeq2 requires raw integer counts, "
            "not normalized values (TPM/FPKM)."
        )

    if low_count_genes > gene_count * 0.5:
        warnings.append(
            f"{low_count_genes} genes ({low_count_genes/gene_count*100:.1f}%) have max count < {min_count}. "
            "Consider pre-filtering low-expression genes."
        )

    if zero_genes > 0:
        warnings.append(f"{zero_genes} genes have all zero counts")

    return {
        "valid": len(errors) == 0,
        "gene_count": gene_count,
        "sample_count": sample_count,
        "errors": errors,
        "warnings": warnings,
        "low_count_genes": low_count_genes,
        "zero_genes": zero_genes,
        "suspected_normalized": suspected_normalized
    }


def validate_metadata(
    metadata: Dict[str, Dict[str, Any]],
    required_columns: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Validate sample metadata format and completeness.

    Args:
        metadata: Dict of {sample_id: {factor: value, ...}, ...}
        required_columns: Optional list of required column names

    Returns:
        Dict with validation results
    """
    errors = []
    warnings = []

    if not metadata:
        errors.append("Metadata is empty")
        return {"valid": False, "sample_count": 0, "columns": [],
                "errors": errors, "warnings": warnings}

    sample_ids = list(metadata.keys())
    sample_count = len(sample_ids)

    # Get all columns from first sample
    first_sample = sample_ids[0]
    columns = list(metadata[first_sample].keys())

    # Analyze column types
    column_analysis = []
    for col in columns:
        values = [metadata[s].get(col) for s in sample_ids if metadata[s].get(col) is not None]
        unique_values = list(set(values))

        # Determine type
        try:
            numeric_count = sum(1 for v in values if isinstance(v, (int, float)) or
                               (isinstance(v, str) and v.replace('.', '').replace('-', '').isdigit()))
            is_numeric = numeric_count == len(values)
        except:
            is_numeric = False

        col_type = 'numeric' if is_numeric else 'factor'
        suggested_role = 'covariate' if is_numeric and len(unique_values) > 10 else 'factor'

        if col.lower() in ('sample', 'sample_id', 'sampleid', 'id'):
            suggested_role = 'identifier'

        column_analysis.append({
            "name": col,
            "type": col_type,
            "unique_values": len(unique_values),
            "missing_count": sample_count - len(values),
            "suggested_role": suggested_role
        })

    # Check required columns
    if required_columns:
        missing = [c for c in required_columns if c not in columns]
        if missing:
            errors.append(f"Missing required columns: {', '.join(missing)}")

    # Check for consistent columns across samples
    for sample_id in sample_ids:
        sample_cols = set(metadata[sample_id].keys())
        if sample_cols != set(columns):
            missing_cols = set(columns) - sample_cols
            if missing_cols:
                warnings.append(f"Sample {sample_id} missing columns: {missing_cols}")

    return {
        "valid": len(errors) == 0,
        "sample_count": sample_count,
        "columns": column_analysis,
        "errors": errors,
        "warnings": warnings
    }


def match_samples(
    count_samples: List[str],
    metadata_samples: List[str]
) -> Dict[str, Any]:
    """
    Match sample IDs between count matrix and metadata.

    Args:
        count_samples: Sample IDs from count matrix columns
        metadata_samples: Sample IDs from metadata rows

    Returns:
        Dict with matching results and any mismatches
    """
    count_set = set(count_samples)
    meta_set = set(metadata_samples)

    matched = count_set & meta_set
    only_in_counts = count_set - meta_set
    only_in_metadata = meta_set - count_set

    # Determine status
    if only_in_counts:
        status = 'error'
        message = f"Samples in counts but not in metadata: {list(only_in_counts)}"
    elif only_in_metadata:
        status = 'warning'
        message = f"Samples in metadata but not in counts (will be ignored): {list(only_in_metadata)}"
    else:
        status = 'ok'
        message = "All samples matched"

    return {
        "status": status,
        "message": message,
        "matched_samples": list(matched),
        "only_in_counts": list(only_in_counts),
        "only_in_metadata": list(only_in_metadata),
        "match_count": len(matched),
        "total_count_samples": len(count_samples),
        "total_meta_samples": len(metadata_samples)
    }


def estimate_memory_usage(gene_count: int, sample_count: int) -> Dict[str, Any]:
    """
    Estimate memory requirements for PyDESeq2 analysis.

    Args:
        gene_count: Number of genes
        sample_count: Number of samples

    Returns:
        Dict with memory estimates and recommendation
    """
    # Note: This is a rough heuristic; actual memory can be higher
    # for dispersion fitting, VST, and large intermediate matrices.
    # Raw count matrix: genes × samples × 8 bytes (int64)
    raw_mb = (gene_count * sample_count * 8) / (1024 * 1024)

    # Analysis overhead: ~3x for PyDESeq2 internals
    analysis_mb = raw_mb * 3

    # Total estimate
    total_mb = raw_mb + analysis_mb

    # Recommendation based on 8GB system assumption
    if total_mb < 500:
        recommendation = 'ok'
    elif total_mb < 2000:
        recommendation = 'warning'
    else:
        recommendation = 'error'

    return {
        "raw_mb": round(raw_mb, 2),
        "analysis_mb": round(analysis_mb, 2),
        "total_mb": round(total_mb, 2),
        "recommendation": recommendation
    }


def dict_to_dataframe(data: Dict[str, Dict[str, Any]], orient: str = 'index'):
    """
    Convert nested dict to pandas DataFrame.

    Args:
        data: Nested dictionary
        orient: 'index' (rows are outer keys) or 'columns' (columns are outer keys)

    Returns:
        pandas DataFrame
    """
    import pandas as pd
    return pd.DataFrame.from_dict(data, orient=orient)


def dataframe_to_dict(df, orient: str = 'index') -> Dict:
    """
    Convert pandas DataFrame to nested dict.

    Args:
        df: pandas DataFrame
        orient: 'index' (rows become outer keys) or 'dict' (columns become outer keys)

    Returns:
        Nested dictionary
    """
    return df.to_dict(orient=orient)
