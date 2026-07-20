"""
Visualization Data Preparation
PCA, VST transformation, and clustering for RNA-seq plots.

VERSION: 1.0.0
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Any, Tuple

from .utils import emit_progress


def compute_vst(
    count_matrix: pd.DataFrame,
    size_factors: Optional[Dict[str, float]] = None,
    dds: Optional[Any] = None,
    use_design: bool = False,
    fit_type: Optional[str] = None,
    return_df: bool = False,
    vst_nsub: int = 1000
) -> Any:
    """
    Variance stabilizing transformation for heatmap visualization.

    Uses PyDESeq2's VST when a fitted DeseqDataSet is provided.
    Falls back to log2(count + 1) if VST is unavailable or fails.

    Args:
        count_matrix: DataFrame with genes (rows) × samples (cols)
        size_factors: Optional dict of sample size factors
        dds: Optional PyDESeq2 DeseqDataSet instance
        use_design: Whether to use the design matrix for VST fit (PyDESeq2)
        fit_type: Optional VST fit type override ("parametric" or "mean")
        return_df: Return pandas DataFrame instead of list of lists

    Returns:
        2D list of transformed values (genes × samples) or DataFrame if return_df
    """
    vst_df: Optional[pd.DataFrame] = None
    transform = "vst"

    if dds is not None:
        try:
            from pydeseq2.dds import DeseqDataSet  # type: ignore
            from pydeseq2.utils import locfit_predict  # type: ignore
            from scipy.interpolate import splrep, splev

            def splinefun_fmm(x, y):
                x = np.asarray(x, dtype=float)
                y = np.asarray(y, dtype=float)
                tck = splrep(x, y, s=0.0, k=3)
                slope_lo = float(splev(x[0], tck, der=1))
                slope_hi = float(splev(x[-1], tck, der=1))

                def _eval(xq):
                    xq_arr = np.asarray(xq, dtype=float)
                    yq = splev(xq_arr, tck)
                    lo_mask = xq_arr < x[0]
                    hi_mask = xq_arr > x[-1]
                    if np.any(lo_mask):
                        yq = np.asarray(yq)
                        yq[lo_mask] = y[0] + slope_lo * (xq_arr[lo_mask] - x[0])
                    if np.any(hi_mask):
                        yq = np.asarray(yq)
                        yq[hi_mask] = y[-1] + slope_hi * (xq_arr[hi_mask] - x[-1])
                    if np.ndim(xq_arr) == 0:
                        return float(np.asarray(yq).reshape(()))
                    return yq

                return _eval

            if count_matrix is None:
                raise RuntimeError("Count matrix required for VST.")

            if "size_factors" not in dds.obs:
                dds.fit_size_factors(fit_type=dds.size_factors_fit_type)

            normed_counts = dds.layers.get("normed_counts")
            if normed_counts is None:
                dds.fit_size_factors(fit_type=dds.size_factors_fit_type)
                normed_counts = dds.layers.get("normed_counts")
            if normed_counts is None:
                raise RuntimeError("Normalized counts are unavailable for VST.")

            vst_fit_type = fit_type or "parametric"

            normed_df = pd.DataFrame(
                normed_counts,
                index=dds.obs_names,
                columns=dds.var_names
            )
            normed_df = normed_df.reindex(index=count_matrix.columns, columns=count_matrix.index)
            ncounts = normed_df.T.to_numpy(dtype=float)

            sf = None
            if "size_factors" in dds.obs:
                sf_series = dds.obs.reindex(count_matrix.columns)["size_factors"]
                if sf_series.isna().any():
                    sf = np.asarray(dds.obs["size_factors"].values, dtype=float)
                else:
                    sf = np.asarray(sf_series.values, dtype=float)
            if size_factors:
                sf = np.asarray([size_factors[s] for s in count_matrix.columns], dtype=float)
            if sf is None:
                sf = np.ones(ncounts.shape[1], dtype=float)

            base_mean = np.mean(ncounts, axis=1)
            use_mask = base_mean > 5
            use_subset = dds.n_vars >= vst_nsub and np.sum(use_mask) >= vst_nsub

            meta = pd.DataFrame(dds.obs).copy()
            meta = meta.drop(columns=["size_factors", "replaceable"], errors="ignore")
            meta = meta.reindex(count_matrix.columns)

            def fit_dispersion_trend(sub_counts: pd.DataFrame) -> Tuple[str, Dict[str, Any]]:
                dds_sub = DeseqDataSet(
                    counts=sub_counts.T,
                    metadata=meta,
                    design="~ 1" if not use_design else getattr(dds, "design", "~ 1"),
                    fit_type=vst_fit_type,
                    size_factors_fit_type=getattr(dds, "size_factors_fit_type", "ratio"),
                    quiet=True,
                )
                dds_sub.obs["size_factors"] = sf
                x = dds_sub.X.toarray() if not isinstance(dds_sub.X, np.ndarray) else dds_sub.X
                dds_sub.layers["normed_counts"] = np.asarray(x, dtype=float) / sf[:, None]
                dds_sub.var["_normed_means"] = dds_sub.layers["normed_counts"].mean(0)
                dds_sub.vst_fit_type = vst_fit_type
                dds_sub.fit_genewise_dispersions(vst=True)
                if vst_fit_type == "parametric":
                    dds_sub._fit_parametric_dispersion_trend(vst=True)
                elif vst_fit_type == "local":
                    dds_sub._fit_local_dispersion_trend(vst=True)
                else:
                    dds_sub._fit_mean_dispersion_trend(vst=True)

                if dds_sub.vst_fit_type == "parametric":
                    return "parametric", {
                        "vst_trend_coeffs": dds_sub.uns["vst_trend_coeffs"].copy()
                    }
                if dds_sub.vst_fit_type == "local":
                    return "local", {
                        "vst_local_smooth": dds_sub.uns["vst_local_smooth"].copy(),
                        "vst_local_fit": dds_sub.uns.get("vst_local_fit")
                    }
                return "mean", {"mean_disp": dds_sub.uns["mean_disp"]}

            if use_subset:
                base_mean_subset = base_mean[use_mask]
                order = np.argsort(base_mean_subset)
                positions = np.round(
                    np.linspace(0, len(order) - 1, vst_nsub)
                ).astype(int)
                idx = np.where(use_mask)[0][order[positions]]
                subset_genes = count_matrix.index[idx]
                fit_type_used, fit_payload = fit_dispersion_trend(
                    count_matrix.loc[subset_genes]
                )
            else:
                fit_type_used, fit_payload = fit_dispersion_trend(count_matrix)

            if fit_type_used == "parametric":
                coeffs = fit_payload["vst_trend_coeffs"]
                a0 = float(coeffs["a0"])
                a1 = float(coeffs["a1"])
                if not np.isfinite(a0) or a0 <= 0:
                    vst_values = np.log2(ncounts + 1)
                else:
                    vst_values = np.log2(
                        (
                            1
                            + a1
                            + 2 * a0 * ncounts
                            + 2 * np.sqrt(a0 * ncounts * (1 + a1 + a0 * ncounts))
                        )
                        / (4 * a0)
                    )
            elif fit_type_used == "mean":
                alpha = float(fit_payload["mean_disp"])
                if not np.isfinite(alpha) or alpha <= 0:
                    vst_values = np.log2(ncounts + 1)
                else:
                    vst_values = (
                        2 * np.arcsinh(np.sqrt(alpha * ncounts))
                        - np.log(alpha)
                        - np.log(4)
                    ) / np.log(2)
            else:
                smooth = fit_payload.get("vst_local_smooth")
                local_fit = fit_payload.get("vst_local_fit")

                def disp_func(x):
                    x = np.asarray(x, dtype=float)
                    x = np.clip(x, 1e-8, None)
                    logx = np.log(x)
                    if local_fit is not None:
                        log_means = np.asarray(local_fit.get("x"), dtype=float)
                        log_disps = np.asarray(local_fit.get("y"), dtype=float)
                        weights = np.asarray(local_fit.get("w"), dtype=float)
                        if log_means.size == 0 or log_disps.size == 0:
                            return np.full_like(x, np.nan)
                        frac = float(local_fit.get("frac", 0.7))
                        degree = int(local_fit.get("degree", 2))
                        preds = locfit_predict(
                            log_means, log_disps, weights, logx, frac=frac, degree=degree
                        )
                        return np.exp(preds)
                    if smooth is None:
                        return np.full_like(x, np.nan)
                    log_means = np.asarray(smooth["x"], dtype=float)
                    log_disps = np.asarray(smooth["y"], dtype=float)
                    y = np.interp(
                        logx, log_means, log_disps, left=log_disps[0], right=log_disps[-1]
                    )
                    return np.exp(y)

                max_count = np.max(ncounts)
                if not np.isfinite(max_count) or max_count <= 0:
                    vst_values = np.log2(ncounts + 1)
                else:
                    xg = np.sinh(
                        np.linspace(np.arcsinh(0), np.arcsinh(max_count), num=1000)
                    )[1:]
                    xim = float(np.mean(1.0 / sf))
                    base_vars = disp_func(xg) * xg**2 + xim * xg
                    base_vars = np.clip(base_vars, 1e-12, None)
                    integrand = 1.0 / np.sqrt(base_vars)
                    mid = (xg[1:] + xg[:-1]) / 2
                    if mid.size == 0:
                        vst_values = np.log2(ncounts + 1)
                    else:
                        spl_x = np.arcsinh(mid)
                        spl_y = np.cumsum(
                            (xg[1:] - xg[:-1]) * (integrand[1:] + integrand[:-1]) / 2
                        )
                        splf = splinefun_fmm(spl_x, spl_y)
                        h1 = np.quantile(base_mean, 0.95)
                        h2 = np.quantile(base_mean, 0.999)
                        denom = splf(np.arcsinh(h2)) - splf(np.arcsinh(h1))
                        if denom == 0 or not np.isfinite(denom) or h1 <= 0 or h2 <= 0:
                            vst_values = np.log2(ncounts + 1)
                        else:
                            eta = (np.log2(h2) - np.log2(h1)) / denom
                            xi = np.log2(h1) - eta * splf(np.arcsinh(h1))
                            vst_values = eta * splf(np.arcsinh(ncounts)) + xi

            vst_df = pd.DataFrame(
                vst_values,
                index=normed_df.columns,
                columns=normed_df.index
            )
            if count_matrix is not None:
                vst_df = vst_df.reindex(index=count_matrix.index, columns=count_matrix.columns)
        except Exception:
            vst_df = None

    if vst_df is None:
        # Normalize by size factors if provided
        if size_factors:
            normalized = count_matrix.copy()
            for sample, sf in size_factors.items():
                if sample in normalized.columns:
                    normalized[sample] = normalized[sample] / sf
        else:
            normalized = count_matrix

        # Log2 transformation with pseudocount
        vst_df = np.log2(normalized + 1)
        transform = "log2"

    if isinstance(vst_df, pd.DataFrame):
        vst_df.attrs["transform"] = transform

    if return_df:
        return vst_df

    return vst_df.values.tolist()


def _eigen2x2(
    m00: float,
    m01: float,
    m11: float
) -> Dict[str, np.ndarray]:
    """
    Eigen decomposition for symmetric 2x2 matrix [[m00, m01], [m01, m11]].
    Matches the TypeScript eigen2x2 helper used for cov.trob.
    """
    trace = m00 + m11
    det = m00 * m11 - m01 * m01
    discriminant = np.sqrt(max(0.0, trace * trace / 4 - det))
    l0 = trace / 2 + discriminant
    l1 = trace / 2 - discriminant

    v0x, v0y = 1.0, 0.0
    v1x, v1y = 0.0, 1.0

    if abs(m01) > 0:
        v0x = l0 - m11
        v0y = m01
        norm0 = np.hypot(v0x, v0y) or 1.0
        v0x /= norm0
        v0y /= norm0
        v1x = -v0y
        v1y = v0x
    elif m00 < m11:
        v0x, v0y = 0.0, 1.0
        v1x, v1y = 1.0, 0.0

    return {
        "values": np.array([l0, l1], dtype=float),
        "vectors": np.array([[v0x, v1x], [v0y, v1y]], dtype=float),
    }


def cov_trob(
    points: np.ndarray,
    nu: int = 5,
    maxit: int = 25,
    tol: float = 0.01
) -> Dict[str, np.ndarray]:
    """
    Port of MASS::cov.trob (robust covariance via M-estimator).
    Mirrors the TypeScript robustCovarianceEstimate implementation.
    """
    pts = np.asarray(points, dtype=float)
    n = pts.shape[0]
    p = 2

    wt = np.ones(n, dtype=float)
    sum_wt = float(n)

    center = np.sum(pts * wt[:, None], axis=0) / sum_wt
    w = wt * (1 + p / nu)

    for _ in range(maxit):
        w0 = w.copy()
        sum_w = np.sum(w)
        if not (sum_w > 0):
            break

        x0 = pts[:, 0] - center[0]
        x1 = pts[:, 1] - center[1]

        m00 = 0.0
        m01 = 0.0
        m11 = 0.0
        for i in range(n):
            scale = np.sqrt(w[i] / sum_w)
            a0 = x0[i] * scale
            a1 = x1[i] * scale
            m00 += a0 * a0
            m01 += a0 * a1
            m11 += a1 * a1

        eig = _eigen2x2(m00, m01, m11)
        d0 = np.sqrt(max(0.0, eig["values"][0]))
        d1 = np.sqrt(max(0.0, eig["values"][1]))
        v00 = eig["vectors"][0, 0]
        v10 = eig["vectors"][1, 0]
        v01 = eig["vectors"][0, 1]
        v11 = eig["vectors"][1, 1]

        inv_d0 = 1.0 / d0 if d0 > 0 else 0.0
        inv_d1 = 1.0 / d1 if d1 > 0 else 0.0

        Q = np.zeros(n, dtype=float)
        for i in range(n):
            z0 = (x0[i] * v00 + x1[i] * v10) * inv_d0
            z1 = (x0[i] * v01 + x1[i] * v11) * inv_d1
            Q[i] = z0 * z0 + z1 * z1

        w = wt * (nu + p) / (nu + Q)

        sum_w2 = np.sum(w)
        if not (sum_w2 > 0):
            break

        center = np.sum(pts * w[:, None], axis=0) / sum_w2

        if np.all(np.abs(w - w0) < tol):
            break

    c00 = 0.0
    c01 = 0.0
    c11 = 0.0
    for i in range(n):
        dx = pts[i, 0] - center[0]
        dy = pts[i, 1] - center[1]
        wi = w[i]
        c00 += wi * dx * dx
        c01 += wi * dx * dy
        c11 += wi * dy * dy
    c00 /= sum_wt
    c01 /= sum_wt
    c11 /= sum_wt

    cov = np.array([[c00, c01], [c01, c11]], dtype=float)
    return {"center": center, "cov": cov}


def compute_ellipse_metrics(
    samples: List[Dict[str, Any]],
    group_by: str,
    ellipse_type: str = 't',
    level: float = 0.95
) -> List[Dict[str, Any]]:
    """
    Compute confidence ellipse metrics for PCA visualization.

    Args:
        samples: PCA sample data with PC1, PC2, metadata
        group_by: Metadata field to group by (from model.mainFactor)
        ellipse_type: 't', 'norm', or 'euclid'
        level: Confidence level (0.95 = 95%) or radius for euclid

    Returns:
        List of ellipse metrics per group: {group, centerX, centerY, radiusX, radiusY, angle, n, path}
    """
    from scipy.stats import f as f_dist
    from scipy.linalg import cholesky

    # Group samples
    groups = {}
    for sample in samples:
        group_val = sample.get('metadata', {}).get(group_by, 'Unknown')
        if group_val not in groups:
            groups[group_val] = []
        groups[group_val].append([sample['PC1'], sample['PC2']])

    ellipse_metrics = []

    for group_name, points in groups.items():
        points = np.array(points, dtype=float)
        if points.ndim != 2 or points.shape[1] != 2:
            continue
        finite_mask = np.isfinite(points).all(axis=1)
        points = points[finite_mask]
        n = points.shape[0]

        dfn = 2
        dfd = n - 1

        if dfd < 3:
            continue

        # Covariance method selection
        if ellipse_type == 't':
            v = cov_trob(points)
            center = v['center']
            cov_matrix = v['cov']
        elif ellipse_type == 'norm':
            center = np.mean(points, axis=0)
            cov_matrix = np.cov(points.T)
        elif ellipse_type == 'euclid':
            center = np.mean(points, axis=0)
            cov_matrix = np.cov(points.T)
            min_var = np.min(np.diag(cov_matrix))
            cov_matrix = np.diag([min_var, min_var])
        else:
            continue

        # Cholesky decomposition
        try:
            chol_decomp = cholesky(cov_matrix, lower=False)
        except np.linalg.LinAlgError:
            continue

        # Calculate radius
        if ellipse_type == 'euclid':
            radius = level / np.max(chol_decomp)
        else:
            radius = np.sqrt(dfn * f_dist.ppf(level, dfn, dfd))

        # Generate ellipse path using chol decomposition
        segments = 51
        angles = np.linspace(0, 2 * np.pi, segments + 1)
        unit_circle = np.column_stack([np.cos(angles), np.sin(angles)])

        ellipse_points = center + radius * (unit_circle @ chol_decomp)

        # Generate SVG path
        path_parts = [f"M {ellipse_points[0, 0]} {ellipse_points[0, 1]}"]
        for i in range(1, len(ellipse_points)):
            path_parts.append(f"L {ellipse_points[i, 0]} {ellipse_points[i, 1]}")
        path_parts.append("Z")
        path = " ".join(path_parts)

        # Compute radii and angle via eigenvalues (for metrics reporting only)
        cov_00 = cov_matrix[0, 0]
        cov_01 = cov_matrix[0, 1]
        cov_11 = cov_matrix[1, 1]

        trace = cov_00 + cov_11
        delta = np.sqrt((cov_00 - cov_11) * (cov_00 - cov_11) + 4 * cov_01 * cov_01)
        lambda1 = (trace + delta) / 2
        lambda2 = (trace - delta) / 2

        radiusX = np.sqrt(lambda1) * radius
        radiusY = np.sqrt(lambda2) * radius

        # Angle formula matching R baseline helper
        # angle <- atan2(lambda1 - cov[1,1], cov[1,2])
        if cov_01 != 0:
            angle = np.arctan2(lambda1 - cov_00, cov_01)
        elif cov_00 < cov_11:
            angle = np.pi / 2
        else:
            angle = 0.0

        ellipse_metrics.append({
            'group': str(group_name),
            'centerX': float(center[0]),
            'centerY': float(center[1]),
            'radiusX': float(radiusX),
            'radiusY': float(radiusY),
            'angle': float(angle),
            'n': int(n),
            'path': path
        })

    return ellipse_metrics


def compute_pca_for_biplot(
    count_matrix: pd.DataFrame,
    metadata: pd.DataFrame,
    vst_matrix: Optional[pd.DataFrame] = None,
    size_factors: Optional[Dict[str, float]] = None,
    n_top_genes: int = 500,
    significant_genes: Optional[List[str]] = None,
    gene_selection_mode: str = "significant_only",
    gene_symbols: Optional[Dict[str, str]] = None,
    n_pcs: int = 10,
    group_by: str = 'treatment'
) -> Dict[str, Any]:
    """
    Compute PCA for biplot visualization.

    Args:
        count_matrix: DataFrame with genes (rows) × samples (cols)
        metadata: DataFrame with samples (rows) × factors (cols)
        vst_matrix: Optional pre-computed VST matrix
        size_factors: Optional size factors for log2 fallback normalization
        n_top_genes: Number of top variable genes for PCA
        significant_genes: Optional prioritized significant genes (already sorted).
        gene_selection_mode: One of:
            - significant_then_variable: take up to n_top_genes significant genes first, then pad
              with top-variance genes up to n_top_genes.
            - significant_only: use all significant genes; if too few are available (< 15),
              auto-switch to significant_then_variable (up to n_top_genes) for PCA stability.
            - variable_only: ignore significance and use top-variance genes only.
        gene_symbols: Optional dict mapping gene_id to gene_symbol
        n_pcs: Number of principal components to compute

    Returns:
        Dict with samples, loadings, variance_explained
    """
    from sklearn.decomposition import PCA

    # Use VST if provided, otherwise log-transform (normalize by size factors first if available)
    if vst_matrix is not None:
        data_matrix = vst_matrix
    else:
        normalized = count_matrix.copy()
        if size_factors:
            for sample, sf in size_factors.items():
                if sample in normalized.columns:
                    normalized[sample] = normalized[sample] / sf
        # Simple log2(count + 1) transformation
        data_matrix = np.log2(normalized + 1)

    # Select genes for PCA.
    # Variance ranking is always computed, then selection mode is applied.
    gene_vars = data_matrix.var(axis=1, ddof=1)
    gene_vars = gene_vars.sort_values(ascending=False, kind="mergesort")
    top_n = min(n_top_genes, len(gene_vars))
    genes_for_pca: List[str] = []
    significant_used = 0
    padded_with_variance = False
    fallback_to_variance_when_empty = False
    requested_mode = (gene_selection_mode or "significant_only").strip().lower()
    if requested_mode not in {"significant_then_variable", "significant_only", "variable_only"}:
        requested_mode = "significant_only"
    effective_mode = requested_mode
    significant_only_min_genes = 15
    effective_significant_only_min_genes = (
        min(significant_only_min_genes, len(gene_vars))
        if len(gene_vars) > 0
        else 0
    )
    effective_target_top_genes = int(top_n)

    seen = set()
    valid_significant: List[str] = []
    available_genes = set(gene_vars.index.tolist())
    if requested_mode in {"significant_then_variable", "significant_only"} and significant_genes:
        for gene_id in significant_genes:
            if gene_id in available_genes and gene_id not in seen:
                seen.add(gene_id)
                valid_significant.append(gene_id)

    if requested_mode == "significant_then_variable":
        sig_cap = top_n
        genes_for_pca = valid_significant[:sig_cap]
        significant_used = len(genes_for_pca)
        if len(genes_for_pca) < top_n:
            padded_with_variance = True
            selected_set = set(genes_for_pca)
            for gene_id in gene_vars.index.tolist():
                if gene_id in selected_set:
                    continue
                genes_for_pca.append(gene_id)
                selected_set.add(gene_id)
                if len(genes_for_pca) >= top_n:
                    break
    elif requested_mode == "significant_only":
        genes_for_pca = valid_significant.copy()
        significant_used = len(genes_for_pca)
        effective_target_top_genes = int(significant_used)
        if (
            significant_used < effective_significant_only_min_genes
            and significant_used < top_n
        ):
            # Keep strict significant-only when we have enough signal;
            # otherwise transition to a hybrid set for PCA stability.
            effective_mode = "significant_then_variable"
            effective_target_top_genes = int(top_n)
            if len(genes_for_pca) < effective_target_top_genes:
                padded_with_variance = True
                selected_set = set(genes_for_pca)
                for gene_id in gene_vars.index.tolist():
                    if gene_id in selected_set:
                        continue
                    genes_for_pca.append(gene_id)
                    selected_set.add(gene_id)
                    if len(genes_for_pca) >= effective_target_top_genes:
                        break
    else:
        genes_for_pca = gene_vars.index[:top_n].tolist()

    if not genes_for_pca:
        fallback_to_variance_when_empty = True
        genes_for_pca = gene_vars.index[:top_n].tolist()

    auto_switched_to_significant_then_variable = (
        requested_mode == "significant_only"
        and effective_mode == "significant_then_variable"
    )

    # Subset and transpose (samples × genes)
    pca_input = data_matrix.loc[genes_for_pca].T

    # Handle any remaining NaN/Inf values
    pca_input = pca_input.fillna(0)
    pca_input = pca_input.replace([np.inf, -np.inf], 0)

    # Run PCA (match R prcomp defaults: center=TRUE, scale.=FALSE)
    pca_values = pca_input.to_numpy(dtype=float)
    n_components = min(n_pcs, len(genes_for_pca), len(pca_input))
    pca = PCA(n_components=n_components, svd_solver='full')
    scores = pca.fit_transform(pca_values)
    loadings = pca.components_.T  # genes × PCs

    def _build_samples(sample_ids, score_matrix):
        built = []
        for i, sample_id in enumerate(sample_ids):
            sample_data = {
                "sampleId": str(sample_id),
                "PC1": float(score_matrix[i, 0]),
                "PC2": float(score_matrix[i, 1]) if score_matrix.shape[1] > 1 else 0.0,
                "PC3": float(score_matrix[i, 2]) if score_matrix.shape[1] > 2 else 0.0,
                "metadata": {}
            }

            if sample_id in metadata.index:
                for col in metadata.columns:
                    val = metadata.loc[sample_id, col]
                    if pd.isna(val):
                        sample_data["metadata"][col] = None
                    elif isinstance(val, (np.integer, np.floating)):
                        sample_data["metadata"][col] = float(val)
                    else:
                        sample_data["metadata"][col] = str(val)

            built.append(sample_data)
        return built

    # Build sample results for output
    samples = _build_samples(pca_input.index, scores)

    # Build loading results (for biplot arrows)
    gene_loadings = []
    for i, gene_id in enumerate(genes_for_pca):
        pc1_load = float(loadings[i, 0])
        pc2_load = float(loadings[i, 1]) if n_components > 1 else 0.0
        contribution = np.sqrt(pc1_load**2 + pc2_load**2)

        symbol = gene_symbols.get(gene_id, gene_id) if gene_symbols else gene_id

        gene_loadings.append({
            "geneId": gene_id,
            "geneSymbol": symbol,
            "PC1": pc1_load,
            "PC2": pc2_load,
            "contribution": float(contribution)
        })

    # Sort by contribution
    gene_loadings.sort(key=lambda x: x["contribution"], reverse=True)

    # Variance explained
    var_explained = (pca.explained_variance_ratio_ * 100).tolist()

    # Compute ellipse metrics for all three types
    ellipse_metrics_t = compute_ellipse_metrics(samples, group_by, 't', 0.95)
    ellipse_metrics_norm = compute_ellipse_metrics(samples, group_by, 'norm', 0.95)
    ellipse_metrics_euclid = compute_ellipse_metrics(samples, group_by, 'euclid', 2.0)

    return {
        "samples": samples,
        "loadings": gene_loadings[:100],  # Top 100 for performance
        "variance_explained": var_explained,
        "genes_used": len(genes_for_pca),
        "gene_selection": {
            "mode": requested_mode,
            "effective_mode": effective_mode,
            "significant_used": significant_used,
            "padded_with_variance": padded_with_variance,
            "fallback_to_variance_when_empty": fallback_to_variance_when_empty,
            "target_top_genes": int(effective_target_top_genes),
            "auto_switched_to_significant_then_variable": auto_switched_to_significant_then_variable,
            "significant_only_min_genes": int(effective_significant_only_min_genes),
        },
        "ellipse_metrics": {
            "t": ellipse_metrics_t,
            "norm": ellipse_metrics_norm,
            "euclid": ellipse_metrics_euclid
        }
    }


def cluster_for_heatmap(
    z_scores: np.ndarray,
    cluster_rows: bool = True,
    cluster_cols: bool = True,
    method: str = 'complete',
    metric: str = 'euclidean'
) -> Dict[str, Any]:
    """
    Perform hierarchical clustering for heatmap visualization.

    Args:
        z_scores: 2D array of genes × samples (already Z-scored)
        cluster_rows: Whether to cluster rows (genes)
        cluster_cols: Whether to cluster columns (samples)
        method: Linkage method ('ward', 'average', 'complete', 'single')
        metric: Distance metric ('euclidean', 'correlation', 'cosine')

    Returns:
        Dict with row_order, col_order
    """
    from scipy.cluster.hierarchy import linkage, leaves_list
    from scipy.spatial.distance import pdist

    result = {
        "row_order": list(range(z_scores.shape[0])),
        "col_order": list(range(z_scores.shape[1]))
    }

    # Handle edge cases
    if z_scores.shape[0] < 2 or z_scores.shape[1] < 2:
        return result

    # Replace any NaN/Inf with 0 for clustering
    z_scores_clean = np.nan_to_num(z_scores, nan=0.0, posinf=0.0, neginf=0.0)

    try:
        if cluster_rows and z_scores_clean.shape[0] > 1:
            row_dist = pdist(z_scores_clean, metric=metric)
            if not np.any(np.isnan(row_dist)) and not np.any(np.isinf(row_dist)):
                row_linkage = linkage(row_dist, method=method)
                result["row_order"] = leaves_list(row_linkage).tolist()
    except (ValueError, FloatingPointError) as e:
        import sys
        print(f"[Clustering] Row clustering failed: {e}", file=sys.stderr)

    try:
        if cluster_cols and z_scores_clean.shape[1] > 1:
            col_dist = pdist(z_scores_clean.T, metric=metric)
            if not np.any(np.isnan(col_dist)) and not np.any(np.isinf(col_dist)):
                col_linkage = linkage(col_dist, method=method)
                result["col_order"] = leaves_list(col_linkage).tolist()
    except (ValueError, FloatingPointError) as e:
        import sys
        print(f"[Clustering] Column clustering failed: {e}", file=sys.stderr)

    return result


def prepare_volcano_data(
    genes: List[Dict[str, Any]],
    pvalue_threshold: float = 0.05,
    lfc_threshold: float = 1.0,
    use_padj: bool = True
) -> Dict[str, Any]:
    """
    Prepare data for volcano plot visualization.

    Args:
        genes: List of gene result dicts
        pvalue_threshold: P-value significance threshold
        lfc_threshold: Log2 fold change threshold for effect size
        use_padj: Whether to use adjusted p-value

    Returns:
        Dict with categorized genes and thresholds
    """
    pval_col = 'padj' if use_padj else 'pvalue'

    categories = {
        'up_significant': [],      # Significant, LFC > threshold (red)
        'down_significant': [],    # Significant, LFC < -threshold (blue)
        'significant_small': [],   # Significant, |LFC| < threshold (orange)
        'not_significant': []      # Not significant (grey)
    }

    for gene in genes:
        pval = gene.get(pval_col)
        lfc = gene.get('log2_fold_change')

        if pval is None or lfc is None:
            continue

        # Categorize genes
        if pval < pvalue_threshold:
            if lfc > lfc_threshold:
                categories['up_significant'].append(gene)
            elif lfc < -lfc_threshold:
                categories['down_significant'].append(gene)
            else:
                categories['significant_small'].append(gene)
        else:
            categories['not_significant'].append(gene)

    return {
        'categories': categories,
        'counts': {k: len(v) for k, v in categories.items()},
        'thresholds': {
            'pvalue': pvalue_threshold,
            'lfc': lfc_threshold,
            'use_padj': use_padj
        }
    }


def compute_z_scores(matrix: np.ndarray, axis: int = 0) -> np.ndarray:
    """
    Compute Z-scores for matrix.

    Args:
        matrix: 2D numpy array
        axis: Axis along which to compute Z-scores (0=columns, 1=rows)

    Returns:
        Z-scored matrix
    """
    mean = np.nanmean(matrix, axis=axis, keepdims=True)
    std = np.nanstd(matrix, axis=axis, ddof=1, keepdims=True)

    # Avoid division by zero
    std = np.where((std == 0) | np.isnan(std), 1, std)

    return (matrix - mean) / std


def prepare_heatmap_data(
    count_matrix: pd.DataFrame,
    genes: List[Dict[str, Any]],
    n_top_genes: int = 50,
    cluster_rows: bool = True,
    cluster_cols: bool = True,
    size_factors: Optional[Dict[str, float]] = None,
    use_padj: bool = True,
    vst_matrix: Optional[pd.DataFrame] = None,
    dds: Optional[Any] = None,
    fit_type: Optional[str] = None,
    use_design: bool = True
) -> Dict[str, Any]:
    """
    Prepare data for expression heatmap.

    Args:
        count_matrix: DataFrame with genes (rows) × samples (cols)
        genes: List of gene results (for filtering by significance)
        n_top_genes: Number of top genes to show
        cluster_rows: Whether to cluster rows
        cluster_cols: Whether to cluster columns
        size_factors: Optional size factors for normalization
        use_padj: Whether to use adjusted p-values when ranking significant genes
        vst_matrix: Optional precomputed VST matrix (genes × samples)
        dds: Optional PyDESeq2 DeseqDataSet for VST alignment
        fit_type: Optional VST fit type override
        use_design: Whether to use the design matrix for VST fit (PyDESeq2)

    Returns:
        Dict with heatmap data ready for frontend
    """
    # Get top genes sorted by adjusted p-value (or raw p-value)
    pval_key = 'padj' if use_padj else 'pvalue'
    genes_with_pval = [g for g in genes if g.get(pval_key) is not None]
    genes_with_pval.sort(key=lambda x: x.get(pval_key, 1.0) or 1.0)
    top_genes = genes_with_pval[:n_top_genes]

    if not top_genes:
        # Fallback to top by absolute LFC
        genes_with_lfc = [g for g in genes if g.get('log2_fold_change') is not None]
        genes_with_lfc.sort(key=lambda x: abs(x.get('log2_fold_change', 0)), reverse=True)
        top_genes = genes_with_lfc[:n_top_genes]

    if not top_genes:
        return {"error": "No genes available for heatmap"}

    # Get gene IDs and symbols
    gene_ids = [g['gene_id'] for g in top_genes]
    gene_symbols = [g.get('gene_symbol', g['gene_id']) for g in top_genes]

    # Filter count matrix to selected genes
    available_genes = [g for g in gene_ids if g in count_matrix.index]
    if not available_genes:
        return {"error": "No matching genes found in count matrix"}

    subset = count_matrix.loc[available_genes]

    # VST transformation (align with analysis VST when available)
    if vst_matrix is not None:
        vst_df = vst_matrix.reindex(index=available_genes, columns=subset.columns)
    else:
        vst_df = compute_vst(
            subset,
            size_factors=size_factors,
            dds=dds,
            use_design=use_design,
            fit_type=fit_type,
            return_df=True
        )
    vst_array = np.array(vst_df)

    # Z-score by row (gene)
    z_scores = compute_z_scores(vst_array, axis=1)

    # Cluster
    cluster_result = cluster_for_heatmap(
        z_scores,
        cluster_rows=cluster_rows,
        cluster_cols=cluster_cols
    )

    # Reorder data
    row_order = cluster_result['row_order']
    col_order = cluster_result['col_order']

    clustered_z = z_scores[row_order, :][:, col_order]
    clustered_genes = [gene_symbols[i] for i in row_order if i < len(gene_symbols)]
    clustered_samples = [subset.columns[i] for i in col_order if i < len(subset.columns)]

    return {
        "z_scores": clustered_z.tolist(),
        "gene_ids": [available_genes[i] for i in row_order if i < len(available_genes)],
        "gene_symbols": clustered_genes,
        "sample_ids": clustered_samples,
        "row_order": row_order,
        "col_order": col_order,
        "n_genes": len(clustered_genes),
        "n_samples": len(clustered_samples)
    }


def render_heatmap_image(
    genes: List[Dict[str, Any]],
    normalized_counts: List[List[float]],
    sample_ids: List[str],
    options: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Render a static clustered heatmap image using seaborn/matplotlib.

    Args:
        genes: List of gene result dicts (must align with normalized_counts rows)
        normalized_counts: VST matrix (genes × samples)
        sample_ids: Sample labels in column order
        options: Optional plot options (n_top_genes, cluster_rows, cluster_cols, use_padj)

    Returns:
        Dict with base64 image data and dimensions
    """
    import base64
    import io
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn as sns

    if not normalized_counts:
        return {"error": "Normalized counts are missing."}

    opts = options or {}
    n_top_genes = int(opts.get("n_top_genes", 50))
    cluster_rows = bool(opts.get("cluster_rows", True))
    cluster_cols = bool(opts.get("cluster_cols", True))
    use_padj = bool(opts.get("use_padj", True))
    space_colorbar = float(opts.get("space_colorbar", 30))
    space_colorbar = min(100.0, max(0.0, space_colorbar))

    if n_top_genes < 1:
        n_top_genes = 50

    def get_field(record: Dict[str, Any], *keys: str):
        for key in keys:
            if key in record:
                return record[key]
        return None

    def coerce_float(value: Any) -> Optional[float]:
        try:
            if value is None:
                return None
            val = float(value)
            if np.isnan(val) or np.isinf(val):
                return None
            return val
        except Exception:
            return None

    pval_key = "padj" if use_padj else "pvalue"
    genes_with_pval = []
    for gene in genes:
        if not isinstance(gene, dict):
            continue
        pval = coerce_float(get_field(gene, pval_key))
        if pval is None:
            continue
        genes_with_pval.append((pval, gene))

    genes_with_pval.sort(key=lambda item: item[0])
    top_genes = [gene for _, gene in genes_with_pval[:n_top_genes]]

    if not top_genes:
        genes_by_lfc = []
        for gene in genes:
            if not isinstance(gene, dict):
                continue
            lfc = coerce_float(get_field(gene, "log2_fold_change", "log2FoldChange"))
            if lfc is None:
                continue
            genes_by_lfc.append((abs(lfc), gene))
        genes_by_lfc.sort(key=lambda item: item[0], reverse=True)
        top_genes = [gene for _, gene in genes_by_lfc[:n_top_genes]]

    if not top_genes:
        return {"error": "No genes available for heatmap."}

    gene_id_to_index = {}
    for idx, gene in enumerate(genes):
        if not isinstance(gene, dict):
            continue
        gene_id = get_field(gene, "gene_id", "geneId")
        if gene_id is None:
            continue
        gene_id_to_index[str(gene_id)] = idx

    selected_rows = []
    selected_labels = []
    for gene in top_genes:
        gene_id = get_field(gene, "gene_id", "geneId")
        if gene_id is None:
            continue
        idx = gene_id_to_index.get(str(gene_id))
        if idx is None or idx >= len(normalized_counts):
            continue
        row = normalized_counts[idx]
        if not isinstance(row, list) or not row:
            continue
        label = get_field(gene, "gene_symbol", "geneSymbol", "gene_id", "geneId")
        selected_rows.append(row)
        selected_labels.append(str(label) if label is not None else str(gene_id))

    if not selected_rows:
        return {"error": "Heatmap selection did not match expression matrix."}

    max_label_len = max((len(str(label)) for label in selected_labels), default=0)

    matrix = np.array(selected_rows, dtype=float)
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
    means = matrix.mean(axis=1, keepdims=True)
    std = matrix.std(axis=1, ddof=1, keepdims=True)
    std = np.where((std == 0) | np.isnan(std), 1, std)
    z_scores = (matrix - means) / std

    row_linkage = None
    col_linkage = None
    if (cluster_rows and z_scores.shape[0] > 1) or (cluster_cols and z_scores.shape[1] > 1):
        from scipy.cluster.hierarchy import linkage
        from scipy.spatial.distance import pdist

    if cluster_rows and z_scores.shape[0] > 1:
        try:
            row_dist = pdist(z_scores, metric="euclidean")
            if np.isfinite(row_dist).all():
                row_linkage = linkage(row_dist, method="complete", optimal_ordering=False)
        except (ValueError, FloatingPointError):
            row_linkage = None

    if cluster_cols and z_scores.shape[1] > 1:
        try:
            col_dist = pdist(z_scores.T, metric="euclidean")
            if np.isfinite(col_dist).all():
                col_linkage = linkage(col_dist, method="complete", optimal_ordering=False)
        except (ValueError, FloatingPointError):
            col_linkage = None

    resolved_samples = sample_ids[: z_scores.shape[1]] if sample_ids else [
        f"Sample {i + 1}" for i in range(z_scores.shape[1])
    ]

    heatmap_df = pd.DataFrame(z_scores, index=selected_labels, columns=resolved_samples)

    label_extra = min(4.0, max_label_len * 0.06)
    base_width = min(18, max(6, 0.35 * heatmap_df.shape[1] + 2 + label_extra))
    width = min(20, base_width)
    height = min(22, max(6, 0.18 * heatmap_df.shape[0] + 2))

    sns.set_theme(context="paper", style="white")
    cluster_grid = sns.clustermap(
        heatmap_df,
        cmap="RdYlBu_r",
        center=0,
        row_cluster=cluster_rows,
        col_cluster=cluster_cols,
        row_linkage=row_linkage,
        col_linkage=col_linkage,
        method="complete",
        metric="euclidean",
        linewidths=0,
        xticklabels=True,
        yticklabels=True,
        figsize=(width, height),
        cbar_kws={"label": "Z-score"},
    )

    ax = cluster_grid.ax_heatmap
    ax.set_xlabel("")
    ax.set_ylabel("")
    ax.tick_params(axis="x", labelrotation=90, labelsize=8, pad=2)
    ax.set_xticklabels(
        ax.get_xticklabels(),
        rotation=90,
        ha="center",
        va="top"
    )
    ax.tick_params(axis="y", labelsize=8)
    ax.yaxis.tick_right()
    ax.yaxis.set_label_position("right")

    if cluster_grid.cax is not None:
        from matplotlib.transforms import Bbox

        fig = cluster_grid.fig
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        heatmap_pos = ax.get_position()
        label_bboxes = [
            label.get_window_extent(renderer=renderer)
            for label in ax.get_yticklabels()
            if label.get_text()
        ]
        if label_bboxes:
            labels_bbox = Bbox.union(label_bboxes)
            labels_bbox_fig = labels_bbox.transformed(fig.transFigure.inverted())
            label_right = labels_bbox_fig.x1
        else:
            label_right = heatmap_pos.x1

        fig_width_in = max(fig.get_size_inches()[0], 1e-6)
        gap_in = 0.08 + (space_colorbar / 100.0) * 0.35
        gap_frac = gap_in / fig_width_in
        cbar_width = 0.018
        cbar_left = label_right + gap_frac
        cbar_bottom = heatmap_pos.y0
        cbar_height = heatmap_pos.height
        cluster_grid.cax.set_position([cbar_left, cbar_bottom, cbar_width, cbar_height])
        cluster_grid.cax.yaxis.set_label_position("right")
        cluster_grid.cax.yaxis.tick_right()

    title = f"Expression Heatmap (Top {len(selected_labels)} genes by {pval_key})"
    cluster_grid.fig.suptitle(title, y=1.02, fontsize=12)

    buffer = io.BytesIO()
    cluster_grid.fig.savefig(buffer, format="png", dpi=300, bbox_inches="tight")
    plt.close(cluster_grid.fig)

    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    image_data = f"data:image/png;base64,{encoded}"

    width_px = int(width * 200)
    height_px = int(height * 200)

    data2d = cluster_grid.data2d
    row_labels = [str(label) for label in data2d.index.tolist()]
    col_labels = [str(label) for label in data2d.columns.tolist()]
    z_scores_ordered = data2d.to_numpy().tolist()

    return {
        "image": image_data,
        "width": width_px,
        "height": height_px,
        "title": title,
        "n_genes": len(selected_labels),
        "n_samples": len(resolved_samples),
        "row_labels": row_labels,
        "col_labels": col_labels,
        "z_scores": z_scores_ordered,
    }
