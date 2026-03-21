"""
RNA-seq Module for easyCris
Differential expression analysis using PyDESeq2.

VERSION: 1.0.0
DATE: January 21, 2026

This module provides:
- PyDESeq2-based differential expression analysis
- Gene annotation via bundled local cache (offline)
- PCA and visualization data preparation
- VST transformation for heatmaps

License: MIT (all dependencies are permissively licensed)
"""

__version__ = "1.0.0"

from .rnaseq import (
    run_deseq2_analysis,
    run_wald_test,
    filter_low_count_genes,
)

from .annotation import (
    get_gene_symbols,
    annotate_gene_results,
)

from .visualization import (
    compute_pca_for_biplot,
    compute_vst,
    cluster_for_heatmap,
    prepare_volcano_data,
    prepare_heatmap_data,
    render_heatmap_image,
)

from .utils import (
    emit_progress,
    validate_count_matrix,
    validate_metadata,
    match_samples,
)

__all__ = [
    # PyDESeq2
    'run_deseq2_analysis',
    'run_wald_test',
    'filter_low_count_genes',
    # Annotation
    'get_gene_symbols',
    'annotate_gene_results',
    # Visualization
    'compute_pca_for_biplot',
    'compute_vst',
    'cluster_for_heatmap',
    'prepare_volcano_data',
    'prepare_heatmap_data',
    'render_heatmap_image',
    # Utils
    'emit_progress',
    'validate_count_matrix',
    'validate_metadata',
    'match_samples',
]
