"""
Regression analysis functions (logistic and linear regression).

VERSION: 2.0.5
DATE: 2025-12-04
CHANGES:
    - Add module constants for separation threshold and regularization parameters
    - Normalize multinomial label mapping to avoid repeated fallbacks
    - Add metadata validation guards
    - Document baseline_label/reference_category alias
"""
import numpy as np
import pandas as pd
from scipy import stats
from typing import Dict, Any, List, Optional
from .utils import (
    preprocess_data, format_number, sanitize_for_json,
    _consume_context_metadata, ensure_critical_statistics, safe_trapz,
    set_context_metadata
)

# ============================================================================
# Module Constants
# ============================================================================

# Logistic regression separation detection
# Coefficients with absolute value beyond this threshold indicate quasi-complete separation
SEPARATION_Z_THRESHOLD = 30.0

# Multinomial fallback regularization (when MLE fails to converge)
REGULARIZATION_PENALTY = 'l2'  # Ridge regression (L2) penalty
REGULARIZATION_C = 100.0  # Inverse of regularization strength (high C = weak regularization)


# Helper functions for multinomial logistic regression

def calculate_accuracy(y_true, y_pred):
    """Calculate classification accuracy"""
    return float(np.mean(y_true == y_pred))


def calculate_confusion_matrix(y_true, y_pred, n_classes):
    """Calculate confusion matrix"""
    cm = np.zeros((n_classes, n_classes), dtype=int)
    for true_label, pred_label in zip(y_true, y_pred):
        cm[true_label, pred_label] += 1
    return cm.tolist()


def calculate_classification_metrics(y_true, y_pred, labels, zero_division=0):
    """Calculate precision, recall, f1-score per class"""
    from collections import defaultdict
    metrics = {}

    for label in labels:
        tp = np.sum((y_true == label) & (y_pred == label))
        fp = np.sum((y_true != label) & (y_pred == label))
        fn = np.sum((y_true == label) & (y_pred != label))

        precision = tp / (tp + fp) if (tp + fp) > 0 else zero_division
        recall = tp / (tp + fn) if (tp + fn) > 0 else zero_division
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else zero_division

        metrics[str(label)] = {
            'precision': format_number(precision),
            'recall': format_number(recall),
            'f1_score': format_number(f1),
            'support': int(np.sum(y_true == label))
        }

    return metrics


def _binary_roc_curve(y_true_binary, y_scores, drop_intermediate=False):
    """Compute ROC curve points (sklearn-compatible) for binary classification."""
    try:
        y_true = np.asarray(y_true_binary).astype(int)
        y_score = np.asarray(y_scores, dtype=float)

        if y_true.size == 0 or y_score.size == 0:
            return None, None, None

        mask = np.isfinite(y_score)
        if not np.any(mask):
            return None, None, None

        y_true = y_true[mask]
        y_score = y_score[mask]

        # Sort scores descending, stable to match sklearn behavior
        desc_score_indices = np.argsort(y_score, kind="mergesort")[::-1]
        y_score = y_score[desc_score_indices]
        y_true = y_true[desc_score_indices]

        # Convert to boolean positives
        y_true = (y_true == 1)

        # Find threshold indices for distinct scores
        distinct_value_indices = np.where(np.diff(y_score))[0]
        threshold_idxs = np.r_[distinct_value_indices, y_true.size - 1]

        tps = np.cumsum(y_true)[threshold_idxs]
        fps = 1 + threshold_idxs - tps
        thresholds = y_score[threshold_idxs]

        if drop_intermediate and fps.size > 2:
            optimal_idxs = np.where(np.diff(fps, 2) | np.diff(tps, 2))[0] + 1
            optimal_idxs = np.r_[0, optimal_idxs, fps.size - 1]
            fps = fps[optimal_idxs]
            tps = tps[optimal_idxs]
            thresholds = thresholds[optimal_idxs]

        if tps[-1] == 0 or fps[-1] == 0:
            return None, None, None

        fpr = fps.astype(float) / fps[-1]
        tpr = tps.astype(float) / tps[-1]

        # Prepend origin and infinite threshold (sklearn behavior)
        fpr = np.r_[0.0, fpr]
        tpr = np.r_[0.0, tpr]
        thresholds = np.r_[np.inf, thresholds]

        return fpr, tpr, thresholds
    except:
        return None, None, None


def calculate_roc_auc(y_true_binary, y_scores):
    """Calculate ROC AUC for binary classification (sklearn-compatible)"""
    try:
        fpr, tpr, _ = _binary_roc_curve(y_true_binary, y_scores)
        if fpr is None or tpr is None:
            return None
        return safe_trapz(tpr, fpr)
    except:
        return None


def calculate_multiclass_auc_ovr(y_true, y_prob_matrix):
    """Calculate macro-averaged AUC for multiclass (one-vs-rest)"""
    try:
        n_classes = y_prob_matrix.shape[1]
        aucs = []

        for class_idx in range(n_classes):
            y_binary = (y_true == class_idx).astype(int)
            auc = calculate_roc_auc(y_binary, y_prob_matrix[:, class_idx])
            if auc is not None:
                aucs.append(float(auc))

        if aucs:
            return format_number(np.mean(aucs))
        else:
            return None
    except:
        return None


def calculate_roc_curves_multiclass(y_true, y_prob_matrix):
    """
    Calculate ROC curves (FPR, TPR, AUC) for multiclass classification (one-vs-rest).

    Parameters:
    -----------
    y_true : array-like
        True class labels (0, 1, 2, ...)
    y_prob_matrix : array-like, shape (n_samples, n_classes)
        Predicted probabilities for each class

    Returns:
    --------
    dict : ROC curves for each class
        {
            "0": {"fpr": [...], "tpr": [...], "auc": ...},
            "1": {"fpr": [...], "tpr": [...], "auc": ...},
            ...
        }
    """
    try:
        n_classes = y_prob_matrix.shape[1]
        roc_curves = {}

        for class_idx in range(n_classes):
            y_binary = (y_true == class_idx).astype(int)
            y_scores = y_prob_matrix[:, class_idx]

            fpr, tpr, thresholds = _binary_roc_curve(y_binary, y_scores)
            if fpr is not None and tpr is not None:
                auc = safe_trapz(tpr, fpr)
                roc_curves[str(class_idx)] = {
                    'fpr': [float(x) for x in fpr.tolist()],
                    'tpr': [float(x) for x in tpr.tolist()],
                    'thresholds': [float(x) for x in thresholds.tolist()],
                    'auc': float(auc)
                }
            else:
                roc_curves[str(class_idx)] = {
                    'fpr': None,
                    'tpr': None,
                    'thresholds': None,
                    'auc': None
                }

        return roc_curves
    except Exception as e:
        # Return None on error
        return None


def compute_hosmer_lemeshow(y_true, y_pred_proba, n_bins=10):
    """
    Compute Hosmer-Lemeshow goodness-of-fit test for binary logistic regression.

    Returns:
        (chi2_statistic, p_value, degrees_of_freedom)
    """
    try:
        # Sort by predicted probability
        sorted_indices = np.argsort(y_pred_proba)
        y_true_sorted = y_true[sorted_indices]
        y_prob_sorted = y_pred_proba[sorted_indices]

        # Create bins
        bin_edges = np.linspace(0, len(y_true), n_bins + 1).astype(int)

        chi2_stat = 0.0
        for i in range(n_bins):
            start_idx = bin_edges[i]
            end_idx = bin_edges[i + 1]

            if end_idx <= start_idx:
                continue

            bin_y_true = y_true_sorted[start_idx:end_idx]
            bin_y_prob = y_prob_sorted[start_idx:end_idx]

            observed_events = np.sum(bin_y_true)
            observed_non_events = len(bin_y_true) - observed_events

            expected_events = np.sum(bin_y_prob)
            expected_non_events = len(bin_y_prob) - expected_events

            if expected_events > 0:
                chi2_stat += (observed_events - expected_events) ** 2 / expected_events
            if expected_non_events > 0:
                chi2_stat += (observed_non_events - expected_non_events) ** 2 / expected_non_events

        df = n_bins - 2
        p_value = 1.0 - stats.chi2.cdf(chi2_stat, df)

        return chi2_stat, p_value, df
    except:
        return None, None, None


def logistic_regression_binary_statsmodels(X, y, alpha=0.05, category_mapping=None, feature_names=None,
                                            use_regularization=False, penalty='l2', C=100.0):
    """
    Binary logistic regression using statsmodels Logit (proper binary logistic).

    Parameters:
    -----------
    X : array-like, shape (n_samples, n_features)
        Predictor variables
    y : array-like, shape (n_samples,)
        Binary outcome (0 = baseline/reference, 1 = comparison)
    alpha : float
        Significance level for confidence intervals (default 0.05)
    category_mapping : dict, optional
        Mapping from codes to category labels
    feature_names : list, optional
        Names of predictor variables
    use_regularization : bool, optional
        If True, use fit_regularized() instead of fit() (default False)
    penalty : str, optional
        Penalty type: 'l1', 'l2', or 'elasticnet' (default 'l2')
    C : float, optional
        Inverse of regularization strength; larger C = less regularization.
        Default 100.0 provides light regularization with proper CIs.

    Returns:
    --------
    dict : Results dictionary with coefficients, p-values, odds ratios, confidence intervals
    """
    try:
        import statsmodels.api as sm

        metadata = _consume_context_metadata("logistic_regression_binary_statsmodels")
        predictor_baselines = None
        predictor_encodings = None
        if metadata:
            if metadata.get('feature_names') is not None:
                feature_names = metadata.get('feature_names')
            predictor_baselines = metadata.get('predictor_baselines')
            predictor_encodings = metadata.get('predictor_encodings')
            # Read outcome_mapping from metadata if not provided as kwarg
            if category_mapping is None and metadata.get('outcome_mapping') is not None:
                category_mapping = metadata.get('outcome_mapping')

        # Validate category_mapping if provided
        if category_mapping is not None:
            if not isinstance(category_mapping, dict) or len(category_mapping) == 0:
                raise ValueError(
                    "category_mapping must be a non-empty dictionary mapping class codes to labels. "
                    f"Received: {type(category_mapping).__name__} with {len(category_mapping) if isinstance(category_mapping, dict) else 'N/A'} entries"
                )

        # Convert inputs to numpy arrays
        X_arr = np.array(X, dtype=float)
        if X_arr.ndim == 1:
            X_arr = X_arr.reshape(-1, 1)

        y_arr = np.array([int(round(float(val))) for val in y], dtype=int)

        # Validate data
        if len(X_arr) != len(y_arr):
            return {'success': False, 'error': 'X and y must have same number of samples'}

        unique_y_original = sorted(np.unique(y_arr))
        if len(unique_y_original) != 2:
            return {'success': False, 'error': f'Binary regression requires exactly 2 classes, found {len(unique_y_original)}'}

        # AUTOMATIC RECODING: Convert non-sequential codes to [0, 1]
        if not np.array_equal(unique_y_original, [0, 1]):
            # Create mapping from original codes to [0, 1]
            code_mapping = {unique_y_original[0]: 0, unique_y_original[1]: 1}

            # Apply recoding
            y_arr = np.array([code_mapping[val] for val in y_arr], dtype=int)

            # Update category_mapping to reflect the recoding
            if category_mapping is not None:
                category_mapping_recoded = {}
                for original_code_str, label in category_mapping.items():
                    try:
                        # Convert string key to int to match code_mapping keys (fix for type mismatch)
                        original_code = int(original_code_str)
                        if original_code in code_mapping:
                            new_code = code_mapping[original_code]
                            category_mapping_recoded[new_code] = label
                    except ValueError:
                        # If conversion fails, skip this entry
                        pass
                category_mapping = category_mapping_recoded

        n_samples, n_features = X_arr.shape

        # Prepare feature names
        if feature_names is None or len(feature_names) != n_features:
            feature_names = [f'X{i+1}' for i in range(n_features)]
        else:
            feature_names = [str(name) for name in feature_names]

        # Create DataFrame for statsmodels
        df_X = pd.DataFrame(X_arr, columns=feature_names)

        # Dummy variable expansion for categorical predictors
        dummy_mapping = {}  # Maps dummy column name -> (original_column, level_name, baseline_level)
        if predictor_encodings is not None and len(predictor_encodings) > 0:
            df_parts = []
            processed_cols = set()

            for col in df_X.columns:
                if col in predictor_encodings:
                    # This is a categorical column - expand to dummies
                    processed_cols.add(col)
                    encoding = predictor_encodings[col]

                    # Create reverse mapping: code -> level_name
                    code_to_level = {int(code): level for level, code in encoding.items()}

                    # Find baseline (code 0)
                    baseline_level = code_to_level.get(0, None)

                    # Create dummy for each non-baseline level
                    for code, level_name in sorted(code_to_level.items()):
                        if code != 0:  # Skip baseline (reference category)
                            dummy_col_name = f"{col}_{level_name}"
                            dummy_series = (df_X[col] == code).astype(int)
                            df_parts.append(pd.DataFrame({dummy_col_name: dummy_series}))
                            dummy_mapping[dummy_col_name] = (col, level_name, baseline_level)
                else:
                    # Continuous column - keep as-is
                    processed_cols.add(col)
                    df_parts.append(df_X[[col]])

            # Reassemble DataFrame with dummies
            if df_parts:
                df_X = pd.concat(df_parts, axis=1)

        df_X = sm.add_constant(df_X, has_constant='add')

        # Check condition number for multicollinearity
        try:
            cond_num = np.linalg.cond(df_X.values)
            if cond_num > 30:
                import sys
                print(f"WARNING: Design matrix condition number = {cond_num:.2f} (>30 indicates potential multicollinearity)", file=sys.stderr)
        except:
            pass  # Silently ignore if condition number calculation fails

        # Fit binary logit model using Logit
        model = sm.Logit(y_arr, df_X)

        if use_regularization:
            # Use regularized estimation (for handling separation)
            # Convert C (sklearn convention) to alpha (statsmodels convention): alpha = 1/C
            alpha_reg = 1.0 / C

            if penalty == 'l2':
                # Pure L2 (ridge): L1_wt=0
                result = model.fit_regularized(method='l1', alpha=alpha_reg, L1_wt=0.0, disp=False, maxiter=200)
            elif penalty == 'l1':
                # Pure L1 (lasso): L1_wt=1
                result = model.fit_regularized(method='l1', alpha=alpha_reg, L1_wt=1.0, disp=False, maxiter=200)
            else:
                # Elastic net: L1_wt=0.5
                result = model.fit_regularized(method='l1', alpha=alpha_reg, L1_wt=0.5, disp=False, maxiter=200)
        else:
            # Standard maximum likelihood estimation
            result = model.fit(disp=False, maxiter=200)

        # Extract parameters
        params = result.params
        bse = result.bse
        z_values = result.tvalues
        p_values = result.pvalues
        conf_int = result.conf_int(alpha=alpha)

        # Define intercept and feature names EARLY (needed for extended statistics)
        intercept_name = 'const'
        coef_names = [name for name in params.index if name != intercept_name]

        # ========================================================================
        # LOGISTIC REGRESSION ENHANCEMENTS
        # ========================================================================

        # PHASE 1: MODEL FIT STATISTICS
        # -2 Log Likelihood
        minus_2_log_l = -2 * result.llf
        minus_2_log_l_null = -2 * result.llnull if hasattr(result, 'llnull') else None

        # Likelihood Ratio Test (Testing Global Null Hypothesis: BETA=0)
        llr_chi2 = result.llr if hasattr(result, 'llr') else None
        llr_df = result.df_model if hasattr(result, 'df_model') else None
        llr_p = result.llr_pvalue if hasattr(result, 'llr_pvalue') else None

        # Wald Test (global - for all predictors jointly)
        # Wald χ² = sum of (β/SE)² for all predictors (excluding intercept)
        wald_chi2_global = None
        wald_df_global = len(coef_names)
        wald_p_global = None
        if wald_df_global > 0:
            try:
                cov_params = result.cov_params()
                cov_sub = cov_params.loc[coef_names, coef_names]
                beta_vec = params.loc[coef_names].values.astype(float)
                wald_chi2_global = float(beta_vec.T @ np.linalg.inv(cov_sub.values) @ beta_vec)
            except Exception:
                # Fallback: sum of z^2 (approximation)
                wald_chi2_global = np.sum(z_values[name]**2 for name in coef_names)
            wald_p_global = stats.chi2.sf(wald_chi2_global, wald_df_global)

        # Score Test (Rao) against intercept-only model
        score_chi2 = None
        score_df = None
        score_p = None
        if wald_df_global > 0:
            try:
                # Use intercept-only MLE: p0 = mean(y)
                p0 = float(np.mean(y_arr))
                if 0 < p0 < 1:
                    z_matrix = df_X[coef_names].values.astype(float)
                    resid = y_arr - p0
                    u_vec = z_matrix.T @ resid

                    w = p0 * (1 - p0)
                    n_obs = len(y_arr)
                    i_aa = w * n_obs
                    i_ab = w * z_matrix.sum(axis=0)
                    i_bb = w * (z_matrix.T @ z_matrix)

                    # Conditional information for predictors given intercept
                    s_mat = i_bb - np.outer(i_ab, i_ab) / i_aa
                    inv_s = np.linalg.pinv(s_mat)
                    score_chi2 = float(u_vec.T @ inv_s @ u_vec)
                    score_df = int(len(coef_names))
                    score_p = stats.chi2.sf(score_chi2, score_df)
            except Exception:
                pass

        model_fit = {
            'minus2logL': format_number(minus_2_log_l),
            'minus2logL_null': format_number(minus_2_log_l_null) if minus_2_log_l_null is not None else None,
            'aic': format_number(result.aic),
            'bic': format_number(result.bic),
            'lr_chi2': format_number(llr_chi2) if llr_chi2 is not None else None,
            'lr_df': int(llr_df) if llr_df is not None else None,
            'lr_p': format_number(llr_p) if llr_p is not None else None,
            'wald_chi2': format_number(wald_chi2_global),
            'wald_df': int(wald_df_global),
            'wald_p': format_number(wald_p_global),
            'score_chi2': format_number(score_chi2) if score_chi2 is not None else None,
            'score_df': int(score_df) if score_df is not None else None,
            'score_p': format_number(score_p) if score_p is not None else None
        }

        # PHASE 2: PSEUDO R-SQUARED
        n = n_samples
        llf = result.llf
        llnull = result.llnull if hasattr(result, 'llnull') else None

        mcfadden_r2 = result.prsquared  # Already computed

        # Cox & Snell R²: 1 - exp((llnull - llf) * 2 / n)
        cox_snell_r2 = 1 - np.exp((llnull - llf) * 2 / n) if llnull is not None else None

        # Nagelkerke R²: Cox & Snell / (1 - exp(llnull * 2 / n))
        if cox_snell_r2 is not None and llnull is not None:
            max_cox_snell = 1 - np.exp(llnull * 2 / n)
            nagelkerke_r2 = cox_snell_r2 / max_cox_snell if max_cox_snell != 0 else None
        else:
            nagelkerke_r2 = None

        pseudo_r2 = {
            'mcfadden': format_number(mcfadden_r2),
            'cox_snell': format_number(cox_snell_r2) if cox_snell_r2 is not None else None,
            'nagelkerke': format_number(nagelkerke_r2) if nagelkerke_r2 is not None else None
        }

        # Check for quasi-complete separation (inflated coefficients)
        # Coefficients beyond SEPARATION_Z_THRESHOLD indicate separation issues
        if np.any(np.abs(params) > SEPARATION_Z_THRESHOLD):
            max_coef = np.max(np.abs(params))
            problematic_vars = [name for name in params.index if abs(params[name]) > SEPARATION_Z_THRESHOLD]
            return {
                'success': False,
                'error': (
                    f'Quasi-complete separation detected. Maximum coefficient magnitude: {max_coef:.2f}. '
                    f'Problematic variables: {", ".join(problematic_vars)}. '
                    f'This typically indicates perfect or near-perfect prediction of the outcome by one or more predictors. '
                    f'Recommendations: (1) Use regularization (L1/L2 penalty), (2) Remove perfectly predictive variables, '
                    f'(3) Collapse categories to reduce sparsity, or (4) Increase sample size.'
                )
            }

        # Build coefficient table
        coefficients_table = []
        for name in coef_names:
            coef = float(params[name])
            se = float(bse[name])
            z = float(z_values[name])
            p = float(p_values[name])
            ci_lower = float(conf_int.loc[name].iloc[0])
            ci_upper = float(conf_int.loc[name].iloc[1])

            coefficients_table.append({
                'feature': name,
                'coef': format_number(coef),
                'std_err': format_number(se),
                'z_value': format_number(z),
                'p_value': format_number(p),
                'ci_lower': format_number(ci_lower),
                'ci_upper': format_number(ci_upper),
                'odds_ratio': format_number(np.exp(coef)),
                'or_ci_lower': format_number(np.exp(ci_lower)),
                'or_ci_upper': format_number(np.exp(ci_upper)),
                'significant': bool(p < alpha)
            })

        # Predictions - FIXED probability extraction
        y_prob_matrix = result.predict(df_X)

        # Extract P(y=1) correctly
        if isinstance(y_prob_matrix, pd.DataFrame):
            if y_prob_matrix.shape[1] > 1:
                y_prob = y_prob_matrix.iloc[:, 1]
            else:
                y_prob = y_prob_matrix.iloc[:, 0]
        elif isinstance(y_prob_matrix, np.ndarray) and y_prob_matrix.ndim == 2:
            if y_prob_matrix.shape[1] > 1:
                y_prob = y_prob_matrix[:, 1]
            else:
                y_prob = y_prob_matrix[:, 0]
        else:
            y_prob = y_prob_matrix

        y_pred = (y_prob >= 0.5).astype(int)

        # Metrics (inline simple versions)
        accuracy = float(np.mean(y_arr == y_pred))

        # Confusion matrix
        cm = np.zeros((2, 2), dtype=int)
        for true_label, pred_label in zip(y_arr, y_pred):
            cm[true_label, pred_label] += 1
        conf_matrix = cm.tolist()

        # ROC AUC + curve points (sklearn-compatible)
        roc_fpr = None
        roc_tpr = None
        roc_thresholds = None
        try:
            fpr, tpr, thresholds = _binary_roc_curve(y_arr, y_prob)
            if fpr is not None and tpr is not None:
                auc_roc = safe_trapz(tpr, fpr)
                roc_fpr = fpr.tolist()
                roc_tpr = tpr.tolist()
                roc_thresholds = thresholds.tolist()
            else:
                auc_roc = None
        except:
            auc_roc = None

        # Hosmer-Lemeshow
        try:
            hl_stat, hl_pvalue, hl_df = compute_hosmer_lemeshow(y_arr, y_prob)
            if hl_stat is not None and np.isnan(hl_stat):
                hl_stat = None
            if hl_pvalue is not None and np.isnan(hl_pvalue):
                hl_pvalue = None
        except:
            hl_stat, hl_pvalue, hl_df = None, None, None

        # PHASE 3: GOODNESS-OF-FIT - Enhanced Classification Table
        # Extract TP, TN, FP, FN from confusion matrix
        tn, fp, fn, tp = cm[0, 0], cm[0, 1], cm[1, 0], cm[1, 1]

        # Calculate sensitivity and specificity
        sensitivity = tp / (tp + fn) if (tp + fn) > 0 else 0
        specificity = tn / (tn + fp) if (tn + fp) > 0 else 0
        ppv = tp / (tp + fp) if (tp + fp) > 0 else 0  # Positive Predictive Value
        npv = tn / (tn + fn) if (tn + fn) > 0 else 0  # Negative Predictive Value

        classification_table = {
            'cutoff': 0.5,
            'tp': int(tp),
            'tn': int(tn),
            'fp': int(fp),
            'fn': int(fn),
            'accuracy': format_number(accuracy),
            'sensitivity': format_number(sensitivity),
            'specificity': format_number(specificity),
            'ppv': format_number(ppv),
            'npv': format_number(npv),
            'n_events': int(np.sum(y_arr == 1)),
            'n_non_events': int(np.sum(y_arr == 0))
        }

        # ROC/AUC metrics
        roc_metrics = {
            'auc': format_number(auc_roc) if auc_roc is not None else None
        }

        # Hosmer-Lemeshow goodness-of-fit
        hosmer_lemeshow = {
            'chi2': format_number(hl_stat) if hl_stat is not None else None,
            'df': int(hl_df) if hl_df is not None else None,
            'p': format_number(hl_pvalue) if hl_pvalue is not None else None,
            'n_groups': 10
        }

        goodness_of_fit = {
            'hosmer_lemeshow': hosmer_lemeshow,
            'classification': classification_table,
            'roc_auc': roc_metrics
        }

        # PHASE 4: TYPE 3 ANALYSIS OF EFFECTS (Wald χ² per predictor)
        # Group dummy variables by original predictor name
        # For continuous predictors, each is its own effect
        # For categorical predictors, sum Wald χ² across all dummy columns

        type3_tests = []
        processed_effects = set()

        for name in coef_names:
            effect_name = name
            effect_df = 1

            # Check if this is part of a dummy variable group
            if name in dummy_mapping:
                original_column, level_name, baseline_level = dummy_mapping[name]
                effect_name = original_column

                # Skip if we've already processed this categorical predictor
                if effect_name in processed_effects:
                    continue

                processed_effects.add(effect_name)

                # Sum Wald χ² across all dummy columns for this categorical predictor
                wald_chi2_effect = 0
                effect_df = 0
                for other_name in coef_names:
                    if other_name in dummy_mapping:
                        other_orig_col, _, _ = dummy_mapping[other_name]
                        if other_orig_col == original_column:
                            # This dummy belongs to the same categorical predictor
                            wald_chi2_effect += z_values[other_name]**2
                            effect_df += 1
            else:
                # Continuous predictor or single effect
                wald_chi2_effect = z_values[name]**2
                effect_df = 1

            # Calculate p-value for this effect
            p_effect = stats.chi2.sf(wald_chi2_effect, effect_df)

            type3_tests.append({
                'effect': effect_name,
                'df': int(effect_df),
                'chi2': format_number(wald_chi2_effect),
                'p': format_number(p_effect)
            })

        # Category mapping
        if category_mapping is not None:
            cat_map_out = category_mapping
        else:
            cat_map_out = {'0': '0', '1': '1'}

        def resolve_label(mapping, key):
            if mapping is None:
                return str(key)
            if key in mapping:
                return mapping[key]
            key_str = str(key)
            return mapping.get(key_str, str(key))

        baseline_label = resolve_label(cat_map_out, 0)
        event_label = resolve_label(cat_map_out, 1)

        # Calculate deviances from log-likelihoods
        null_deviance = -2 * result.llnull if hasattr(result, 'llnull') else None
        residual_deviance = -2 * result.llf

        regression_summary = {
            'model_type': 'logistic_binary',
            'log_likelihood': format_number(result.llf),
            'log_likelihood_null': format_number(result.llnull) if hasattr(result, 'llnull') else None,
            'null_deviance': format_number(null_deviance) if null_deviance is not None else None,
            'residual_deviance': format_number(residual_deviance),
            'df_null': int(result.df_model + result.df_resid) if hasattr(result, 'df_model') and hasattr(result, 'df_resid') else None,
            'df_residual': int(result.df_resid) if hasattr(result, 'df_resid') else None,
            'mcfadden_r2': format_number(result.prsquared),
            'accuracy': format_number(accuracy) if accuracy is not None else None,
            'aic': format_number(result.aic),
            'bic': format_number(result.bic),
            'n_observations': int(n_samples),
            'n_features': int(n_features),
            'converged': bool(result.mle_retvals.get('converged', True)),
            'alpha': format_number(alpha)
        }

        regression_coefficients = []

        intercept_ci = conf_int.loc[intercept_name]
        # PHASE 5: Add Wald χ² to intercept
        intercept_wald_chi2 = z_values[intercept_name]**2

        regression_coefficients.append({
            'class_label': event_label,
            'term': intercept_name,
            'term_display': 'Intercept',
            'term_type': 'intercept',
            'beta': format_number(params[intercept_name]),
            'std_error': format_number(bse[intercept_name]),
            'statistic': format_number(z_values[intercept_name]),
            'statistic_type': 'z',
            'wald_chi2': format_number(intercept_wald_chi2),  # NEW: Wald χ²
            'p_value': format_number(p_values[intercept_name]),
            'significant': bool(p_values[intercept_name] < alpha),
            'ci_lower': format_number(intercept_ci.iloc[0]),
            'ci_upper': format_number(intercept_ci.iloc[1]),
            'odds_ratio': format_number(np.exp(params[intercept_name])),
            'or_ci_lower': format_number(np.exp(intercept_ci.iloc[0])),
            'or_ci_upper': format_number(np.exp(intercept_ci.iloc[1]))
        })

        for name in coef_names:
            ci_bounds = conf_int.loc[name]

            # Check if this is a dummy variable
            term_display = name
            # PHASE 5: Calculate Wald χ² for this coefficient
            wald_chi2_coef = z_values[name]**2

            coeff_dict = {
                'class_label': event_label,
                'term': name,
                'term_display': term_display,
                'term_type': 'predictor',
                'beta': format_number(params[name]),
                'std_error': format_number(bse[name]),
                'statistic': format_number(z_values[name]),
                'statistic_type': 'z',
                'wald_chi2': format_number(wald_chi2_coef),  # NEW: Wald χ²
                'p_value': format_number(p_values[name]),
                'significant': bool(p_values[name] < alpha),
                'ci_lower': format_number(ci_bounds.iloc[0]),
                'ci_upper': format_number(ci_bounds.iloc[1]),
                'odds_ratio': format_number(np.exp(params[name])),
                'or_ci_lower': format_number(np.exp(ci_bounds.iloc[0])),
                'or_ci_upper': format_number(np.exp(ci_bounds.iloc[1]))
            }

            # Add dummy variable metadata
            if name in dummy_mapping:
                original_column, level_name, baseline_level = dummy_mapping[name]
                coeff_dict['term_display'] = f"{original_column} [{level_name}]"
                coeff_dict['original_column'] = original_column
                coeff_dict['level_name'] = level_name
                coeff_dict['baseline_level'] = baseline_level

            regression_coefficients.append(coeff_dict)

        # Build result
        result_dict = {
            'success': True,
            'method': 'statsmodels_logit',
            'model': 'binary_logit',
            'alpha': format_number(alpha),
            'n_samples': int(n_samples),
            'n_features': int(n_features),
            'feature_names': coef_names,
            'coefficients': [row['coef'] for row in coefficients_table],
            'std_errors': [row['std_err'] for row in coefficients_table],
            'z_values': [row['z_value'] for row in coefficients_table],
            'p_values': [row['p_value'] for row in coefficients_table],
            'odds_ratios': [row['odds_ratio'] for row in coefficients_table],
            'odds_ratios_ci_lower': [row['or_ci_lower'] for row in coefficients_table],
            'odds_ratios_ci_upper': [row['or_ci_upper'] for row in coefficients_table],
            'coefficients_table': coefficients_table,
            'intercept': format_number(params[intercept_name]),
            'intercept_std_error': format_number(bse[intercept_name]),
            'intercept_z_value': format_number(z_values[intercept_name]),
            'intercept_p_value': format_number(p_values[intercept_name]),
            'log_likelihood': format_number(result.llf),
            'pseudo_r2_mcfadden': format_number(result.prsquared),
            'aic': format_number(result.aic),
            'bic': format_number(result.bic),
            'accuracy': format_number(accuracy) if accuracy is not None else None,
            'confusion_matrix': conf_matrix,
            'auc_roc': format_number(auc_roc) if auc_roc is not None else None,
            'predicted_probabilities': [float(val) for val in y_prob],
            'roc_fpr': roc_fpr,
            'roc_tpr': roc_tpr,
            'roc_thresholds': roc_thresholds,
            'calibration_statistic': format_number(hl_stat) if hl_stat is not None else None,
            'calibration_p_value': format_number(hl_pvalue) if hl_pvalue is not None else None,
            'converged': bool(result.mle_retvals.get('converged', True)),
            'baseline_class': '0',
            'category_mapping': cat_map_out,
            'baseline_label': baseline_label,
            'event_label': event_label,
            'class_labels': {'0': baseline_label, '1': event_label},  # For UI display consistency with multinomial
            'regression_summary': regression_summary,
            'regression_coefficients': regression_coefficients,
            'predictor_baselines': predictor_baselines,
            # ENHANCEMENTS
            'model_fit': model_fit,           # NEW: -2LogL, LR/Score/Wald tests, AIC/BIC
            'pseudo_r2': pseudo_r2,           # NEW: Cox & Snell, Nagelkerke, McFadden
            'goodness_of_fit': goodness_of_fit,  # NEW: Hosmer-Lemeshow, Classification, ROC/AUC
            'type3_tests': type3_tests        # NEW: Type 3 Analysis of Effects
        }

        return sanitize_for_json(result_dict)

    except Exception as exc:
        return {'success': False, 'error': f'Binary logistic regression failed: {exc}'}


def logistic_regression_binary_adaptive(X, y, alpha=0.05, category_mapping=None, feature_names=None):
    """
    Adaptive binary logistic regression with automatic fallback.

    FDA-COMPLIANT APPROACH:
    1. Tries unpenalized MLE first (gold standard for inference)
    2. If separation detected (NaN/Inf in results), falls back to light regularization
    3. Clearly reports which method was used in results

    This provides optimal inferential statistics when possible, while gracefully handling
    small sample separation issues when necessary.

    Parameters:
    -----------
    X : array-like, shape (n_samples, n_features)
        Predictor variables
    y : array-like, shape (n_samples,)
        Binary outcome (0 = baseline/reference, 1 = comparison)
    alpha : float
        Significance level for confidence intervals (default 0.05)
    category_mapping : dict, optional
        Mapping from codes to category labels
    feature_names : list, optional
        Names of predictor variables

    Returns:
    --------
    dict : Results with method used, coefficients, odds ratios, 95% CIs
    """
    import sys
    import os

    def _resolve_log_stream():
        """
        Returns a writable stream for diagnostics.
        Prefers sys.stderr, then sys.__stderr__, and finally os.devnull as a last resort.
        """
        candidates = [
            getattr(sys, "stderr", None),
            getattr(sys, "__stderr__", None)
        ]
        for stream in candidates:
            if stream is not None and not getattr(stream, "closed", False):
                return stream
        try:
            return open(os.devnull, "w")
        except Exception:
            return None

    _log_stream = _resolve_log_stream()

    def log(msg=""):
        if _log_stream is None:
            return
        try:
            print(msg, file=_log_stream)
            _log_stream.flush()
        except Exception:
            pass

    log("\n" + "="*80)
    log("ADAPTIVE BINARY LOGISTIC REGRESSION - FDA-Compliant Approach")
    log("="*80)
    log("Strategy: Try unpenalized MLE → Fallback to light regularization if needed")
    log()

    # Consume metadata pushed from C# so we can forward it to the underlying statsmodels runner.
    metadata = _consume_context_metadata("logistic_regression_binary_adaptive")
    predictor_baselines = None
    predictor_encodings = None

    if metadata:
        if feature_names is None and metadata.get('feature_names') is not None:
            feature_names = metadata.get('feature_names')
        predictor_baselines = metadata.get('predictor_baselines')
        predictor_encodings = metadata.get('predictor_encodings')
        if category_mapping is None and metadata.get('outcome_mapping') is not None:
            category_mapping = metadata.get('outcome_mapping')

    def _push_statsmodels_metadata():
        """
        Re-publish metadata for the statsmodels runner before each invocation so it can
        decode predictor encodings and outcome labels (it consumes metadata on entry).
        """
        metadata_payload = {}
        if feature_names is not None:
            metadata_payload['feature_names'] = feature_names
        if predictor_baselines is not None:
            metadata_payload['predictor_baselines'] = predictor_baselines
        if predictor_encodings is not None:
            metadata_payload['predictor_encodings'] = predictor_encodings
        if category_mapping is not None:
            metadata_payload['outcome_mapping'] = category_mapping

        if metadata_payload:
            set_context_metadata("logistic_regression_binary_statsmodels", metadata_payload)

    # STEP 1: Try unpenalized MLE (best for inference)
    log("[STEP 1] Attempting unpenalized Maximum Likelihood Estimation...")

    _push_statsmodels_metadata()
    result1 = logistic_regression_binary_statsmodels(
        X, y,
        alpha=alpha,
        category_mapping=category_mapping,
        feature_names=feature_names,
        use_regularization=False
    )

    # Check if unpenalized succeeded
    if result1.get('success'):
        # Check for NaN values in coefficients
        has_nan = False
        if 'coefficients_table' in result1:
            for row in result1['coefficients_table']:
                if (row.get('coef') is None or
                    row.get('std_err') is None or
                    row.get('p_value') is None):
                    has_nan = True
                    break

        if not has_nan:
            log("[SUCCESS] Unpenalized MLE succeeded - using exact inference")
            log("="*80)
            log()
            result1['inference_method'] = 'unpenalized_mle'
            result1['inference_note'] = 'Exact maximum likelihood estimates with Wald confidence intervals (FDA standard)'
            return result1
        else:
            log("[WARNING] Unpenalized MLE produced NaN values - likely separation issue")
    else:
        log(f"[WARNING] Unpenalized MLE failed: {result1.get('error', 'Unknown error')}")

    # STEP 2: Fallback to light regularization
    log()
    log("[STEP 2] Falling back to light regularization (bias-reduced estimates)...")
    log("Using C=100 (very light penalty) to preserve approximate inference")
    log()

    _push_statsmodels_metadata()
    result2 = logistic_regression_binary_statsmodels(
        X, y,
        alpha=alpha,
        category_mapping=category_mapping,
        feature_names=feature_names,
        use_regularization=True,
        penalty=REGULARIZATION_PENALTY,
        C=REGULARIZATION_C  # Light regularization - balances stability and inference
    )

    if result2.get('success'):
        log("[SUCCESS] Light regularization succeeded")
        log("="*80)
        log()
        result2['inference_method'] = 'light_regularization'
        result2['inference_note'] = 'Bias-reduced estimates using light ridge penalty (C=100) to address quasi-complete separation. Confidence intervals are approximate. Consider collecting more data for exact inference.'
        result2['separation_detected'] = True
        return result2
    else:
        log(f"[ERROR] Both methods failed. Last error: {result2.get('error')}")
        log("="*80)
        log()
        return {
            'success': False,
            'error': 'Both unpenalized and regularized methods failed. Data may have severe issues.',
            'unpenalized_error': result1.get('error'),
            'regularized_error': result2.get('error')
        }


def logistic_regression_multinomial_statsmodels(X, y, alpha=0.05, category_mapping=None, feature_names=None,
                                                 use_regularization=False, penalty='l2', C=100.0):
    """
    Multinomial logistic regression using statsmodels MNLogit (Maximum Likelihood Estimation).

    STATSMODELS IMPLEMENTATION - NOT sklearn
    This implementation uses statsmodels for publication-quality statistics including:
    - Proper standard errors and z-statistics
    - Maximum likelihood estimation (MLE)
    - McFadden's Pseudo R²
    - AIC/BIC information criteria
    - Convergence diagnostics

    Parameters:
    -----------
    X : array-like, shape (n_samples, n_features)
        Predictor variables
    y : array-like, shape (n_samples,)
        Multinomial outcome (0 = baseline/reference, 1, 2, 3, ... = comparison classes)
    alpha : float
        Significance level for confidence intervals (default 0.05)
    category_mapping : dict, optional
        Mapping from codes to category labels
    feature_names : list, optional
        Names of predictor variables
    use_regularization : bool, optional
        If True, use fit_regularized() instead of fit() (default False)
    penalty : str, optional
        Penalty type: 'l1', 'l2', or 'elasticnet' (default 'l2')
    C : float, optional
        Inverse of regularization strength; larger C = less regularization.
        Default 100.0 provides light regularization with proper CIs.
        NOTE: Values < 100 may shrink some coefficients to zero, causing NaN standard errors.

    Returns:
    --------
    dict : Results dictionary with coefficients, p-values, odds ratios, and 95% CIs for each class vs baseline.
          With regularization, some SEs/p-values may be None if coefficients are exactly zero.
    """
    import time
    import sys as system_module
    import os
    start_time = time.time()

    # CONSOLE LOGGING - Runtime details (to STDERR when available; resilient on Windows service hosts)
    def _resolve_log_stream():
        """
        Returns a writable stream for diagnostics.
        Prefers sys.stderr, then sys.__stderr__, and finally os.devnull as a last resort.
        """
        candidates = [
            getattr(system_module, "stderr", None),
            getattr(system_module, "__stderr__", None)
        ]
        for stream in candidates:
            if stream is not None and not getattr(stream, "closed", False):
                return stream
        try:
            return open(os.devnull, "w")
        except Exception:
            return None

    _log_stream = _resolve_log_stream()

    def log(msg=""):
        if _log_stream is None:
            return
        try:
            print(msg, file=_log_stream)
            _log_stream.flush()
        except Exception:
            pass

    log("\n" + "="*80)
    log("STATSMODELS MULTINOMIAL LOGISTIC REGRESSION - Runtime Execution Log")
    log("="*80)
    log(f"Timestamp: {pd.Timestamp.now()}")
    log(f"Method: statsmodels.MNLogit (NOT sklearn)")
    log(f"Regularization: {'ENABLED' if use_regularization else 'DISABLED'}")
    if use_regularization:
        log(f"  Penalty: {penalty}")
        log(f"  C (inverse strength): {C}")
        log(f"  Alpha (statsmodels): {1.0/C if C > 0 else 0.0}")
    log(f"Significance level (alpha): {alpha}")
    log()

    try:
        import statsmodels.api as sm
        import sys
        import os
        # Add script directory to path for local imports
        script_dir = os.path.dirname(os.path.abspath(__file__))
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
        log("[OK] Statsmodels imported successfully")
    except ImportError as e:
        log(f"[ERROR] Failed to import statsmodels: {e}")
        return {'success': False, 'error': f'Required package not installed: {str(e)}'}

    # DIAGNOSTIC: Save input data for debugging
    try:
        import json
        diagnostic_data = {
            'timestamp': str(pd.Timestamp.now()),
            'y_first_10': y[:10] if len(y) >= 10 else y,
            'y_type': str(type(y[0])) if len(y) > 0 else 'empty',
            'y_unique': list(set(y))[:10],
            'category_mapping': category_mapping,
            'X_shape': [len(X), len(X[0]) if len(X) > 0 else 0],
            'use_regularization': use_regularization,
            'penalty': penalty,
            'C': C
        }
        with open('python_input_diagnostic.json', 'w') as f:
            json.dump(diagnostic_data, f, indent=2)
    except:
        pass  # Don't fail if diagnostic logging fails

    # Convert inputs to numpy arrays
    log("-"*80)
    log("DATA VALIDATION")
    log("-"*80)
    metadata = _consume_context_metadata("logistic_regression_multinomial_statsmodels")
    predictor_baselines = None
    predictor_encodings = None
    if metadata:
        if metadata.get('feature_names') is not None:
            feature_names = metadata.get('feature_names')
        predictor_baselines = metadata.get('predictor_baselines')
        predictor_encodings = metadata.get('predictor_encodings')
        # Read outcome_mapping from metadata if not provided as kwarg
        if category_mapping is None and metadata.get('outcome_mapping') is not None:
            category_mapping = metadata.get('outcome_mapping')

    # Validate category_mapping if provided
    if category_mapping is not None:
        if not isinstance(category_mapping, dict) or len(category_mapping) == 0:
            raise ValueError(
                "category_mapping must be a non-empty dictionary mapping class codes to labels. "
                f"Received: {type(category_mapping).__name__} with {len(category_mapping) if isinstance(category_mapping, dict) else 'N/A'} entries"
            )

    try:
        X_arr = np.array(X, dtype=float)
        if X_arr.ndim == 1:
            X_arr = X_arr.reshape(-1, 1)
        log(f"[OK] X converted to numpy array: shape {X_arr.shape}")
    except Exception as exc:
        log(f"[ERROR] Cannot convert X to numeric array: {exc}")
        return {'success': False, 'error': f'Cannot convert X to numeric array: {exc}'}

    # Handle categorical outcome encoding
    try:
        # Try direct integer conversion first (for pre-encoded data)
        y_arr = np.array([int(round(float(val))) for val in y], dtype=int)
        log(f"[OK] y converted to integer array: {len(y_arr)} samples")
        # Create reverse mapping from integers to themselves (use string keys for consistency)
        unique_vals = sorted(np.unique(y_arr))
        outcome_label_mapping = {str(v): str(v) for v in unique_vals}
    except (ValueError, TypeError):
        # If that fails, assume categorical strings - encode them
        log(f"[INFO] y contains non-numeric values, encoding as categorical")
        y_series = pd.Series(y)
        y_codes, y_categories = pd.factorize(y_series, sort=True)
        y_arr = y_codes.astype(int)
        # Create mapping from integer codes to original category names (use string keys)
        outcome_label_mapping = {str(i): str(cat) for i, cat in enumerate(y_categories)}
        log(f"[OK] y encoded to integer array: {len(y_arr)} samples, {len(y_categories)} categories")
        log(f"[OK] Category mapping: {outcome_label_mapping}")

    # Validate data
    if len(X_arr) != len(y_arr):
        log(f"[ERROR] X and y length mismatch: X={len(X_arr)}, y={len(y_arr)}")
        return {'success': False, 'error': 'X and y must have same number of samples'}

    unique_y_original = sorted(np.unique(y_arr))
    n_classes = len(unique_y_original)

    if n_classes < 2:
        log(f"[ERROR] Only {n_classes} class found - need at least 2")
        return {'success': False, 'error': 'Multinomial regression requires at least 2 classes'}

    # BEST PRACTICE: Limit outcome to max 10 categories to prevent overfitting
    MAX_CATEGORIES = 10
    if n_classes > MAX_CATEGORIES:
        log(f"[ERROR] Too many outcome categories: {n_classes} (max allowed: {MAX_CATEGORIES})")
        error_msg = (
            f"Too many outcome categories: {n_classes}\n"
            f"Maximum allowed: {MAX_CATEGORIES}\n\n"
            f"Categorical outcomes with many categories cause overfitting and unstable estimates.\n\n"
            f"RECOMMENDATIONS:\n"
            f"  1. Collapse categories into fewer groups (e.g., Low/Medium/High)\n"
            f"  2. Group rare categories into 'Other'\n"
            f"  3. Use ordinal encoding if categories have natural ordering\n\n"
            f"Please reduce to {MAX_CATEGORIES} or fewer categories."
        )
        return {'success': False, 'error': error_msg}

    # AUTOMATIC RECODING: Convert non-sequential codes to sequential [0, 1, 2, ...]
    expected_codes = list(range(n_classes))
    if unique_y_original != expected_codes:
        log(f"[INFO] Non-sequential outcome codes detected: {unique_y_original}")
        log(f"[INFO] Automatically recoding to sequential: {expected_codes}")

        # Create mapping from original codes to sequential codes
        code_mapping = {original: sequential for sequential, original in enumerate(unique_y_original)}

        # Apply recoding
        y_arr_recoded = np.array([code_mapping[val] for val in y_arr], dtype=int)

        # Update category_mapping to reflect the recoding
        if category_mapping is not None:
            # Remap category labels to new sequential codes
            category_mapping_recoded = {}
            for original_code, label in category_mapping.items():
                if original_code in code_mapping:
                    new_code = code_mapping[original_code]
                    category_mapping_recoded[new_code] = label
            category_mapping = category_mapping_recoded
            log(f"[INFO] Updated category mapping: {category_mapping}")

        # Log the recoding mapping
        log(f"[INFO] Recoding mapping:")
        for orig, seq in code_mapping.items():
            label = category_mapping.get(seq, f"Class {seq}") if category_mapping else f"Class {seq}"
            log(f"    {orig} → {seq} ({label})")

        # Replace y_arr with recoded version
        y_arr = y_arr_recoded
        unique_y = expected_codes
        log(f"[OK] Outcome recoded successfully to sequential codes: {unique_y}")
    else:
        unique_y = unique_y_original
        log(f"[OK] Outcome codes already sequential: {unique_y}")

    n_samples, n_features = X_arr.shape

    log(f"[OK] Data validated:")
    log(f"  Samples: {n_samples}")
    log(f"  Features: {n_features}")
    log(f"  Classes: {n_classes} {unique_y}")
    log(f"  Category mapping: {category_mapping}")

    # Prepare feature names
    if feature_names is None or len(feature_names) != n_features:
        feature_names = [f'X{i+1}' for i in range(n_features)]
    else:
        feature_names = [str(name) for name in feature_names]
    log(f"  Features: {', '.join(feature_names)}")
    log()

    # MNLogit baseline: Class 0 (first category) is always the baseline for numeric codes
    baseline_class = 0
    comparison_classes = [int(c) for c in unique_y if c != baseline_class]

    # Create DataFrame for statsmodels
    df_X = pd.DataFrame(X_arr, columns=feature_names)

    # Dummy variable expansion for categorical predictors
    dummy_mapping = {}  # Maps dummy column name -> (original_column, level_name, baseline_level)
    if predictor_encodings is not None and len(predictor_encodings) > 0:
        df_parts = []
        processed_cols = set()

        for col in df_X.columns:
            if col in predictor_encodings:
                # This is a categorical column - expand to dummies
                processed_cols.add(col)
                encoding = predictor_encodings[col]

                # Create reverse mapping: code -> level_name
                code_to_level = {int(code): level for level, code in encoding.items()}

                # Find baseline (code 0)
                baseline_level = code_to_level.get(0, None)

                # Create dummy for each non-baseline level
                for code, level_name in sorted(code_to_level.items()):
                    if code != 0:  # Skip baseline (reference category)
                        dummy_col_name = f"{col}_{level_name}"
                        dummy_series = (df_X[col] == code).astype(int)
                        df_parts.append(pd.DataFrame({dummy_col_name: dummy_series}))
                        dummy_mapping[dummy_col_name] = (col, level_name, baseline_level)
            else:
                # Continuous column - keep as-is
                processed_cols.add(col)
                df_parts.append(df_X[[col]])

        # Reassemble DataFrame with dummies
        if df_parts:
            df_X = pd.concat(df_parts, axis=1)

    df_X = sm.add_constant(df_X, has_constant='add')

    log("-"*80)
    log("MODEL FITTING - STATSMODELS MNLogit")
    log("-"*80)
    log(f"Baseline class: {baseline_class}")
    log(f"Comparison classes: {comparison_classes}")
    log(f"Model type: statsmodels.MNLogit (Multinomial Logit via Maximum Likelihood)")

    # Fit multinomial logit model
    # statsmodels MNLogit uses class 0 as reference/baseline
    try:
        model = sm.MNLogit(y_arr, df_X)
        log(f"[OK] MNLogit model initialized")

        if use_regularization:
            # Use regularized fit (PENALIZED Maximum Likelihood)
            # Convert C (inverse strength) to statsmodels alpha (penalty strength)
            reg_alpha = 1.0 / C if C > 0 else 0.0

            # Set L1 weight based on penalty type
            if penalty == 'l1':
                L1_wt = 1.0  # Pure L1 (lasso)
            elif penalty == 'l2':
                L1_wt = 0.0  # Pure L2 (ridge)
            elif penalty == 'elasticnet':
                L1_wt = 0.5  # Mix of L1 and L2
            else:
                L1_wt = 0.0  # Default to L2

            log(f"Fitting with REGULARIZATION:")
            log(f"  Method: Penalized Maximum Likelihood")
            log(f"  Penalty: {penalty} (L1_wt={L1_wt})")
            log(f"  Alpha (statsmodels): {reg_alpha}")
            log(f"  Max iterations: 200")

            fit_start = time.time()
            result = model.fit_regularized(method='l1', alpha=reg_alpha, L1_wt=L1_wt,
                                          maxiter=200, disp=False)
            fit_time = time.time() - fit_start
            log(f"[OK] Regularized fit completed in {fit_time:.3f} seconds")
        else:
            # Use standard MLE fit (no regularization)
            log(f"Fitting with MAXIMUM LIKELIHOOD ESTIMATION (MLE):")
            log(f"  Method: Newton-Raphson")
            log(f"  No regularization")
            log(f"  Max iterations: 200")

            fit_start = time.time()
            result = model.fit(method='newton', maxiter=200, disp=False)
            fit_time = time.time() - fit_start
            log(f"[OK] MLE fit completed in {fit_time:.3f} seconds")

    except Exception as exc:
        log(f"[ERROR] Model fitting failed: {exc}")
        return {'success': False, 'error': f'Model fitting failed: {exc}'}

    # Extract parameters
    # params has shape (n_features+1, n_classes-1)
    # Columns are comparison classes [1, 2, 3, ...], rows are features
    try:
        params = result.params
        bse = result.bse
        z_values = result.tvalues
        p_values = result.pvalues
    except AttributeError as exc:
        return {'success': False, 'error': f'Result object missing attributes (use_regularization={use_regularization}): {exc}'}

    # Check for NaN parameters (indicates fit failure)
    if params.isna().any().any():
        return {'success': False, 'error': 'Model fit produced NaN parameters. Try with regularization or check for separation.'}

    z_critical = stats.norm.ppf(1 - alpha / 2)
    conf_int_lower = params - z_critical * bse
    conf_int_upper = params + z_critical * bse

    # Create mapping from class_code to column position in params
    # params has columns [0, 1, ...] representing comparison_classes [1, 2, ...]
    class_to_col = {class_code: col_idx for col_idx, class_code in enumerate(comparison_classes)}

    # Separate intercept and features
    intercept_name = 'const'
    coef_names = [name for name in params.index if name != intercept_name]

    # Build coefficients table by class
    coefficients_table = {}

    for class_code in comparison_classes:
        class_key = str(class_code)
        rows = []
        col_idx = class_to_col[class_code]  # Map class code to column position

        for feat_name in coef_names:
            coef_val = params.loc[feat_name, col_idx]
            se_val = bse.loc[feat_name, col_idx]
            z_val = z_values.loc[feat_name, col_idx]
            p_val = p_values.loc[feat_name, col_idx]
            ci_lower_val = conf_int_lower.loc[feat_name, col_idx]
            ci_upper_val = conf_int_upper.loc[feat_name, col_idx]

            # Convert to float, handle NaN → None for JSON compatibility
            # DO NOT replace NaN with 0.0 - let errors be visible
            coef = float(coef_val) if not pd.isna(coef_val) else None
            se = float(se_val) if not pd.isna(se_val) else None
            z = float(z_val) if not pd.isna(z_val) else None
            p = float(p_val) if not pd.isna(p_val) else None
            ci_lower = float(ci_lower_val) if not pd.isna(ci_lower_val) else None
            ci_upper = float(ci_upper_val) if not pd.isna(ci_upper_val) else None

            row_dict = {
                'feature': feat_name,
                'coef': format_number(coef) if coef is not None else None,
                'std_err': format_number(se) if se is not None else None,
                'z_value': format_number(z) if z is not None else None,
                'p_value': format_number(p) if p is not None else None,
                'ci_lower': format_number(ci_lower) if ci_lower is not None else None,
                'ci_upper': format_number(ci_upper) if ci_upper is not None else None,
                'odds_ratio': format_number(np.exp(coef)) if coef is not None else None,
                'or_ci_lower': format_number(np.exp(ci_lower)) if ci_lower is not None else None,
                'or_ci_upper': format_number(np.exp(ci_upper)) if ci_upper is not None else None,
                'significant': bool(p < alpha) if p is not None else None
            }

            # Add dummy variable metadata if applicable
            if feat_name in dummy_mapping:
                original_column, level_name, baseline_level = dummy_mapping[feat_name]
                row_dict['original_column'] = original_column
                row_dict['level_name'] = level_name
                row_dict['baseline_level'] = baseline_level
                row_dict['feature_display'] = f"{original_column} [{level_name}]"
            else:
                row_dict['feature_display'] = feat_name

            rows.append(row_dict)

        coefficients_table[class_key] = rows

    # Extract intercepts by class
    intercept_values = []
    intercept_se = []
    intercept_z = []
    intercept_p = []
    intercept_or = []
    intercept_or_ci_lower = []
    intercept_or_ci_upper = []

    for class_code in comparison_classes:
        col_idx = class_to_col[class_code]  # Map class code to column position

        # Extract values and handle NaN
        int_val = params.loc[intercept_name, col_idx]
        int_se_val = bse.loc[intercept_name, col_idx]
        int_z_val = z_values.loc[intercept_name, col_idx]
        int_p_val = p_values.loc[intercept_name, col_idx]
        int_ci_lower_val = conf_int_lower.loc[intercept_name, col_idx]
        int_ci_upper_val = conf_int_upper.loc[intercept_name, col_idx]

        intercept_values.append(float(int_val) if not pd.isna(int_val) else None)
        intercept_se.append(float(int_se_val) if not pd.isna(int_se_val) else None)
        intercept_z.append(float(int_z_val) if not pd.isna(int_z_val) else None)
        intercept_p.append(float(int_p_val) if not pd.isna(int_p_val) else None)
        intercept_or.append(float(np.exp(int_val)) if not pd.isna(int_val) else None)
        intercept_or_ci_lower.append(float(np.exp(int_ci_lower_val)) if not pd.isna(int_ci_lower_val) else None)
        intercept_or_ci_upper.append(float(np.exp(int_ci_upper_val)) if not pd.isna(int_ci_upper_val) else None)

    # Build coefficient matrices for backwards compatibility
    coefficients_list = []
    std_errors_list = []
    z_values_list = []
    p_values_list = []
    odds_ratios_list = []
    or_ci_lower_list = []
    or_ci_upper_list = []

    for feat_name in coef_names:
        coef_row = [float(params.loc[feat_name, class_to_col[c]]) for c in comparison_classes]
        se_row = [float(bse.loc[feat_name, class_to_col[c]]) for c in comparison_classes]
        z_row = [float(z_values.loc[feat_name, class_to_col[c]]) for c in comparison_classes]
        p_row = [float(p_values.loc[feat_name, class_to_col[c]]) for c in comparison_classes]
        or_row = [float(np.exp(params.loc[feat_name, class_to_col[c]])) for c in comparison_classes]
        or_ci_low_row = [float(np.exp(conf_int_lower.loc[feat_name, class_to_col[c]])) for c in comparison_classes]
        or_ci_high_row = [float(np.exp(conf_int_upper.loc[feat_name, class_to_col[c]])) for c in comparison_classes]

        coefficients_list.append(coef_row)
        std_errors_list.append(se_row)
        z_values_list.append(z_row)
        p_values_list.append(p_row)
        odds_ratios_list.append(or_row)
        or_ci_lower_list.append(or_ci_low_row)
        or_ci_upper_list.append(or_ci_high_row)

    # Predictions and diagnostics
    # IMPORTANT: result.predict() returns probabilities for ALL classes [0, 1, 2, ...]
    # NOT just non-baseline classes! This is already a complete probability matrix.
    prob_matrix = result.predict(df_X)

    # Convert to numpy array
    if isinstance(prob_matrix, pd.DataFrame):
        prob_matrix = prob_matrix.values
    else:
        prob_matrix = np.array(prob_matrix)

    # Ensure it's 2D
    if prob_matrix.ndim == 1:
        prob_matrix = prob_matrix.reshape(-1, 1)

    # Predicted classes (argmax directly gives us class indices 0, 1, 2, ...)
    y_pred = np.argmax(prob_matrix, axis=1)

    # Accuracy and confusion matrix
    accuracy = calculate_accuracy(y_arr, y_pred)
    conf_matrix = calculate_confusion_matrix(y_arr, y_pred, n_classes=n_classes)

    classification_metrics = calculate_classification_metrics(y_arr, y_pred, labels=list(range(n_classes)), zero_division=0)

    # Per-class AUC
    auc_per_class = {}
    for class_idx in range(n_classes):
        class_mask = (y_arr == class_idx).astype(int)
        auc = calculate_roc_auc(class_mask, prob_matrix[:, class_idx])
        auc_per_class[str(class_idx)] = auc

    # Macro AUC (one-vs-rest)
    macro_auc = calculate_multiclass_auc_ovr(y_arr, prob_matrix)

    # ROC curves (one-vs-rest) - FPR, TPR arrays for each class
    roc_curves = calculate_roc_curves_multiclass(y_arr, prob_matrix)

    # Category mapping for output
    if category_mapping is not None:
        cat_map_out = category_mapping
    elif 'outcome_label_mapping' in locals():
        # Use the mapping created during categorical encoding
        cat_map_out = outcome_label_mapping
    else:
        cat_map_out = {str(c): str(c) for c in unique_y}

    # Normalize all keys to strings to avoid repeated .get() fallbacks
    cat_map_out = {str(k): str(v) for k, v in cat_map_out.items()}

    baseline_label = cat_map_out[str(baseline_class)]

    regression_summary = {
        'model_type': 'logistic_multinomial',
        'log_likelihood': format_number(result.llf),
        'log_likelihood_null': format_number(result.llnull) if (hasattr(result, 'llnull') and result.llnull is not None) else None,
        'mcfadden_r2': format_number(result.prsquared),
        'accuracy': format_number(accuracy) if accuracy is not None else None,
        'aic': format_number(result.aic),
        'bic': format_number(result.bic),
        'n_observations': int(n_samples),
        'n_features': int(n_features),
        'n_classes': int(n_classes),
        'converged': bool(result.mle_retvals.get('converged', True)),
        'alpha': format_number(alpha)
    }

    regression_coefficients = []
    for class_code in comparison_classes:
        class_key = str(class_code)
        class_label = cat_map_out[class_key]  # Normalized keys ensure this exists
        col_idx = class_to_col[class_code]

        intercept_ci_lower = conf_int_lower.loc[intercept_name, col_idx]
        intercept_ci_upper = conf_int_upper.loc[intercept_name, col_idx]

        regression_coefficients.append({
            'class_label': class_label,
            'term': intercept_name,
            'term_display': 'Intercept',
            'term_type': 'intercept',
            'beta': format_number(params.loc[intercept_name, col_idx]),
            'std_error': format_number(bse.loc[intercept_name, col_idx]),
            'statistic': format_number(z_values.loc[intercept_name, col_idx]),
            'statistic_type': 'z',
            'p_value': format_number(p_values.loc[intercept_name, col_idx]),
            'significant': bool(p_values.loc[intercept_name, col_idx] < alpha),
            'ci_lower': format_number(intercept_ci_lower),
            'ci_upper': format_number(intercept_ci_upper),
            'odds_ratio': format_number(np.exp(params.loc[intercept_name, col_idx])),
            'or_ci_lower': format_number(np.exp(intercept_ci_lower)),
            'or_ci_upper': format_number(np.exp(intercept_ci_upper))
        })

        for row in coefficients_table[class_key]:
            coeff_dict = {
                'class_label': class_label,
                'term': row['feature'],
                'term_display': row.get('feature_display', row['feature']),
                'term_type': 'predictor',
                'beta': row['coef'],
                'std_error': row['std_err'],
                'statistic': row['z_value'],
                'statistic_type': 'z',
                'p_value': row['p_value'],
                'significant': row['significant'],
                'ci_lower': row.get('ci_lower'),
                'ci_upper': row.get('ci_upper'),
                'odds_ratio': row['odds_ratio'],
                'or_ci_lower': row['or_ci_lower'],
                'or_ci_upper': row['or_ci_upper']
            }

            # Add dummy variable metadata if present
            if 'original_column' in row:
                coeff_dict['original_column'] = row['original_column']
                coeff_dict['level_name'] = row['level_name']
                coeff_dict['baseline_level'] = row['baseline_level']

            regression_coefficients.append(coeff_dict)

    # ========================================================================
    # LOGISTIC REGRESSION ENHANCEMENTS (MULTINOMIAL)
    # ========================================================================

    # PHASE 1: MODEL FIT STATISTICS
    # -2 Log Likelihood
    minus_2_log_l = -2 * result.llf
    minus_2_log_l_null = -2 * result.llnull if hasattr(result, 'llnull') else None

    # Likelihood Ratio Test (Testing Global Null Hypothesis: BETA=0)
    llr_chi2 = result.llr if hasattr(result, 'llr') else None
    llr_df = result.df_model if hasattr(result, 'df_model') else None
    llr_p = result.llr_pvalue if hasattr(result, 'llr_pvalue') else None

    # Wald Test (global - for all predictors jointly, across all classes)
    # For multinomial: sum Wald χ² across all classes and all predictors
    wald_chi2_global = None
    wald_df_global = 0
    wald_p_global = None
    try:
        cov_params = result.cov_params()
        beta_vals = []
        cov_keys = []

        if isinstance(cov_params.index, pd.MultiIndex):
            for class_code in comparison_classes:
                class_key = str(class_code)
                for name in coef_names:
                    key = None
                    if (class_key, name) in cov_params.index:
                        key = (class_key, name)
                    elif (class_code, name) in cov_params.index:
                        key = (class_code, name)
                    elif (name, class_key) in cov_params.index:
                        key = (name, class_key)
                    elif (name, class_code) in cov_params.index:
                        key = (name, class_code)
                    if key is None:
                        raise KeyError(f"Missing cov key for {name}, class {class_code}")
                    cov_keys.append(key)
                    beta_vals.append(float(params.loc[name, class_to_col[class_code]]))
        else:
            for class_code in comparison_classes:
                for name in coef_names:
                    candidates = [
                        f"{name}[{class_code}]",
                        f"{name}:{class_code}",
                        f"{name}_{class_code}",
                    ]
                    key = next((c for c in candidates if c in cov_params.index), None)
                    if key is None:
                        raise KeyError(f"Missing cov key for {name}, class {class_code}")
                    cov_keys.append(key)
                    beta_vals.append(float(params.loc[name, class_to_col[class_code]]))

        if cov_keys:
            cov_sub = cov_params.loc[cov_keys, cov_keys]
            beta_vec = np.array(beta_vals, dtype=float)
            wald_chi2_global = float(beta_vec.T @ np.linalg.inv(cov_sub.values) @ beta_vec)
            wald_df_global = len(beta_vals)
    except Exception:
        # Fallback: sum of z^2 (approximation)
        wald_chi2_global = 0
        wald_df_global = 0
        for class_code in comparison_classes:
            col_idx = class_to_col[class_code]
            for name in coef_names:
                wald_chi2_global += z_values.loc[name, col_idx]**2
                wald_df_global += 1

    if wald_chi2_global is not None and wald_df_global > 0:
        wald_p_global = stats.chi2.sf(wald_chi2_global, wald_df_global)

    # Score Test (if available from statsmodels)
    score_chi2 = None
    score_p = None
    if hasattr(result, 'score') and hasattr(result, 'score_test'):
        try:
            score_chi2 = result.score_test()[0]
            score_p = result.score_test()[1]
        except:
            pass

    model_fit = {
        'minus2logL': format_number(minus_2_log_l),
        'minus2logL_null': format_number(minus_2_log_l_null) if minus_2_log_l_null is not None else None,
        'aic': format_number(result.aic),
        'bic': format_number(result.bic),
        'lr_chi2': format_number(llr_chi2) if llr_chi2 is not None else None,
        'lr_df': int(llr_df) if llr_df is not None else None,
        'lr_p': format_number(llr_p) if llr_p is not None else None,
        'wald_chi2': format_number(wald_chi2_global),
        'wald_df': int(wald_df_global),
        'wald_p': format_number(wald_p_global),
        'score_chi2': format_number(score_chi2) if score_chi2 is not None else None,
        'score_p': format_number(score_p) if score_p is not None else None
    }

    # PHASE 2: PSEUDO R-SQUARED
    n = n_samples
    llf = result.llf
    llnull = result.llnull if hasattr(result, 'llnull') else None

    mcfadden_r2 = result.prsquared  # Already computed

    # Cox & Snell R²: 1 - exp((llnull - llf) * 2 / n)
    cox_snell_r2 = 1 - np.exp((llnull - llf) * 2 / n) if llnull is not None else None

    # Nagelkerke R²: Cox & Snell / (1 - exp(llnull * 2 / n))
    if cox_snell_r2 is not None and llnull is not None:
        max_cox_snell = 1 - np.exp(llnull * 2 / n)
        nagelkerke_r2 = cox_snell_r2 / max_cox_snell if max_cox_snell != 0 else None
    else:
        nagelkerke_r2 = None

    pseudo_r2 = {
        'mcfadden': format_number(mcfadden_r2),
        'cox_snell': format_number(cox_snell_r2) if cox_snell_r2 is not None else None,
        'nagelkerke': format_number(nagelkerke_r2) if nagelkerke_r2 is not None else None
    }

    # PHASE 3: GOODNESS-OF-FIT (NO Hosmer-Lemeshow for multinomial)
    # Classification metrics (already calculated)
    goodness_of_fit = {
        'classification': {
            'accuracy': format_number(accuracy) if accuracy is not None else None,
            'macro_precision': format_number(classification_metrics.get('macro avg', {}).get('precision')) if classification_metrics else None,
            'macro_recall': format_number(classification_metrics.get('macro avg', {}).get('recall')) if classification_metrics else None,
            'macro_f1': format_number(classification_metrics.get('macro avg', {}).get('f1-score')) if classification_metrics else None,
            'n_samples': int(n_samples)
        },
        'roc_auc': {
            'macro_auc': format_number(macro_auc) if macro_auc is not None else None,
            'per_class_auc': {str(k): format_number(v) if v is not None else None for k, v in auc_per_class.items()}
        }
    }

    # PHASE 4: TYPE 3 ANALYSIS OF EFFECTS (Wald χ² per predictor across all classes)
    # Group dummy variables by original predictor name
    # For multinomial: sum Wald χ² across ALL classes for each predictor
    type3_tests = []
    processed_effects = set()

    for name in coef_names:
        effect_name = name
        effect_df = len(comparison_classes)  # df = number of classes for each predictor

        # Check if this is part of a dummy variable group
        if name in dummy_mapping:
            original_column, level_name, baseline_level = dummy_mapping[name]
            effect_name = original_column

            # Skip if we've already processed this categorical predictor
            if effect_name in processed_effects:
                continue

            processed_effects.add(effect_name)

            # Sum Wald χ² across all dummy columns for this categorical predictor AND all classes
            wald_chi2_effect = 0
            effect_df = 0
            for other_name in coef_names:
                if other_name in dummy_mapping:
                    other_orig_col, _, _ = dummy_mapping[other_name]
                    if other_orig_col == original_column:
                        # This dummy belongs to the same categorical predictor
                        # Sum across all classes
                        for class_code in comparison_classes:
                            col_idx = class_to_col[class_code]
                            wald_chi2_effect += z_values.loc[other_name, col_idx]**2
                            effect_df += 1
        else:
            # Continuous predictor - sum Wald χ² across all classes
            wald_chi2_effect = 0
            for class_code in comparison_classes:
                col_idx = class_to_col[class_code]
                wald_chi2_effect += z_values.loc[name, col_idx]**2
            effect_df = len(comparison_classes)

        # Calculate p-value for this effect
        p_effect = stats.chi2.sf(wald_chi2_effect, effect_df)

        type3_tests.append({
            'effect': effect_name,
            'df': int(effect_df),
            'chi2': format_number(wald_chi2_effect),
            'p': format_number(p_effect)
        })

    # PHASE 5: ADD WALD χ² TO COEFFICIENTS
    # Already done in the coefficient loop above, but need to add it to regression_coefficients
    # Go back and update each coefficient with Wald χ²
    for i, coeff in enumerate(regression_coefficients):
        if 'statistic' in coeff and coeff['statistic'] is not None:
            try:
                z_val = float(coeff['statistic'])
                coeff['wald_chi2'] = format_number(z_val ** 2)
            except:
                coeff['wald_chi2'] = None

    # Build result dictionary
    result_dict = {
        'success': True,
        'method': 'statsmodels_mnlogit_regularized' if use_regularization else 'statsmodels_mnlogit',
        'model': 'multinomial_logit',
        'regularization': penalty if use_regularization else 'none',
        'C': format_number(C) if use_regularization else None,
        'alpha': format_number(alpha),
        'n_samples': int(n_samples),
        'n_features': int(n_features),
        'n_classes': int(n_classes),
        'feature_names': coef_names,
        'classes': [str(c) for c in comparison_classes],
        'baseline_class': str(baseline_class),
        'coefficients': coefficients_list,
        'std_errors': std_errors_list,
        'z_values': z_values_list,
        'p_values': p_values_list,
        'odds_ratios': odds_ratios_list,
        'odds_ratios_ci_lower': or_ci_lower_list,
        'odds_ratios_ci_upper': or_ci_upper_list,
        'odds_ratios_absolute': odds_ratios_list,
        'coefficients_table': coefficients_table,
        'intercept': intercept_values,
        'intercept_std_error': intercept_se,
        'intercept_z_value': intercept_z,
        'intercept_p_value': intercept_p,
        'intercept_odds_ratio': intercept_or,
        'intercept_or_ci_lower': intercept_or_ci_lower,
        'intercept_or_ci_upper': intercept_or_ci_upper,
        'log_likelihood': format_number(result.llf),
        'log_likelihood_null': format_number(result.llnull) if (hasattr(result, 'llnull') and result.llnull is not None) else None,
        'pseudo_r2_mcfadden': format_number(result.prsquared),
        'aic': format_number(result.aic),
        'bic': format_number(result.bic),
        'accuracy': format_number(accuracy) if accuracy is not None else None,
        'confusion_matrix': conf_matrix,
        'classification_report': classification_metrics,
        'predicted_probabilities': prob_matrix.tolist(),
        'auc_roc_macro': format_number(macro_auc) if macro_auc is not None else None,
        'auc_roc_per_class': auc_per_class,
        'roc_curves': roc_curves,  # NEW: ROC curves (FPR, TPR) for each class (one-vs-rest)
        'converged': bool(result.mle_retvals.get('converged', True)),
        'n_iterations': int(result.mle_retvals.get('iterations', 0)),
        'category_mapping': cat_map_out,
        'baseline_label': baseline_label,
        'reference_category': baseline_label,  # Alias for validation compatibility
        'class_labels': {str(c): cat_map_out[str(c)] for c in comparison_classes},
        'regression_summary': regression_summary,
        'regression_coefficients': regression_coefficients,
        'predictor_baselines': predictor_baselines,
        # ENHANCEMENTS
        'model_fit': model_fit,           # NEW: -2LogL, LR/Score/Wald tests, AIC/BIC
        'pseudo_r2': pseudo_r2,           # NEW: Cox & Snell, Nagelkerke, McFadden
        'goodness_of_fit': goodness_of_fit,  # NEW: Classification, ROC/AUC (no H-L for multinomial)
        'type3_tests': type3_tests        # NEW: Type 3 Analysis of Effects
    }

    def _fmt_stat(value, decimals=4):
        if value is None:
            return "NA"
        try:
            return f"{float(value):.{decimals}f}"
        except (TypeError, ValueError):
            return "NA"

    def _fmt_percent(value, decimals=2):
        if value is None:
            return "NA"
        try:
            return f"{float(value) * 100:.{decimals}f}%"
        except (TypeError, ValueError):
            return "NA"

    # CONSOLE LOGGING - Model Diagnostics & Fit Statistics
    log()
    log("-"*80)
    log("MODEL DIAGNOSTICS & FIT STATISTICS")
    log("-"*80)
    log(f"CONVERGENCE STATUS:")
    log(f"  Converged: {result_dict['converged']}")
    log(f"  Iterations: {result_dict['n_iterations']}")
    log()
    log(f"GOODNESS-OF-FIT STATISTICS:")
    log(f"  Log-Likelihood: {_fmt_stat(result_dict['log_likelihood'])}")
    if result_dict['log_likelihood_null'] is not None:
        log(f"  Log-Likelihood (Null): {_fmt_stat(result_dict['log_likelihood_null'])}")
    log(f"  McFadden's Pseudo R²: {_fmt_stat(result_dict['pseudo_r2_mcfadden'])}")
    log(f"    Interpretation: Proportion of log-likelihood explained by model")
    log(f"    Range: 0 (no fit) to 1 (perfect fit)")
    log(f"    Values 0.2-0.4 indicate excellent fit")
    log()
    log(f"INFORMATION CRITERIA (Lower is better):")
    log(f"  AIC (Akaike): {_fmt_stat(result_dict['aic'])}")
    log(f"    Penalizes model complexity: -2*LL + 2*k")
    log(f"  BIC (Bayesian): {_fmt_stat(result_dict['bic'])}")
    log(f"    Stronger penalty for complexity: -2*LL + k*ln(n)")
    log()
    log(f"PREDICTION PERFORMANCE:")
    log(f"  Accuracy: {_fmt_stat(result_dict['accuracy'])} ({_fmt_percent(result_dict['accuracy'])})")
    log(f"  Macro AUC-ROC: {_fmt_stat(result_dict['auc_roc_macro'])}")
    log(f"  Per-class AUC:")
    for class_idx, auc_val in result_dict['auc_roc_per_class'].items():
        class_label = cat_map_out.get(str(class_idx), class_idx)
        log(f"    Class {class_idx} ({class_label}): {_fmt_stat(auc_val)}")
    log()

    total_time = time.time() - start_time
    log("-"*80)
    log(f"ANALYSIS COMPLETE - Total runtime: {total_time:.3f} seconds")
    log("="*80)
    log()

    # Sanitize all values to ensure JSON compatibility (remove NaN/Inf)
    return ensure_critical_statistics(sanitize_for_json(result_dict))


def logistic_regression_multinomial_adaptive(X, y, alpha=0.05, category_mapping=None, feature_names=None):
    """
    Adaptive multinomial logistic regression with automatic fallback.

    FDA-COMPLIANT APPROACH:
    1. Tries unpenalized MLE first (gold standard for inference)
    2. If separation detected (NaN/Inf in results), falls back to light regularization
    3. Clearly reports which method was used in results

    This provides optimal inferential statistics when possible, while gracefully handling
    small sample separation issues when necessary.

    Parameters:
    -----------
    X : array-like, shape (n_samples, n_features)
        Predictor variables
    y : array-like, shape (n_samples,)
        Outcome (0 = reference/control, 1, 2, ... = treatment groups)
    alpha : float
        Significance level for confidence intervals (default 0.05)
    category_mapping : dict, optional
        Mapping from numeric codes to category labels
    feature_names : list, optional
        Names of predictor variables

    Returns:
    --------
    dict : Results with method used, coefficients, odds ratios, 95% CIs
    """
    import sys

    def log(msg=""):
        print(msg, file=sys.stderr)

    log("\n" + "="*80)
    log("ADAPTIVE LOGISTIC REGRESSION - FDA-Compliant Approach")
    log("="*80)
    log("Strategy: Try unpenalized MLE → Fallback to light regularization if needed")
    log()

    # STEP 1: Try unpenalized MLE (best for inference)
    log("[STEP 1] Attempting unpenalized Maximum Likelihood Estimation...")

    result1 = logistic_regression_multinomial_statsmodels(
        X, y,
        alpha=alpha,
        category_mapping=category_mapping,
        feature_names=feature_names,
        use_regularization=False
    )

    # Check if unpenalized succeeded
    if result1.get('success'):
        # Check for NaN values in coefficients
        has_nan = False
        if 'coefficients_by_class' in result1:
            for class_key, rows in result1['coefficients_by_class'].items():
                for row in rows:
                    if (row.get('coef') is None or
                        row.get('std_err') is None or
                        row.get('p_value') is None):
                        has_nan = True
                        break
                if has_nan:
                    break

        if not has_nan:
            log("[SUCCESS] Unpenalized MLE succeeded - using exact inference")
            log("="*80)
            log()
            result1['inference_method'] = 'unpenalized_mle'
            result1['inference_note'] = 'Exact maximum likelihood estimates with Wald confidence intervals (FDA standard)'
            return result1
        else:
            log("[WARNING] Unpenalized MLE produced NaN values - likely separation issue")
    else:
        log(f"[WARNING] Unpenalized MLE failed: {result1.get('error', 'Unknown error')}")

    # STEP 2: Fallback to light regularization
    log()
    log("[STEP 2] Falling back to light regularization (bias-reduced estimates)...")
    log("Using C=100 (very light penalty) to preserve approximate inference")
    log()

    result2 = logistic_regression_multinomial_statsmodels(
        X, y,
        alpha=alpha,
        category_mapping=category_mapping,
        feature_names=feature_names,
        use_regularization=True,
        penalty=REGULARIZATION_PENALTY,
        C=REGULARIZATION_C  # Light regularization - balances stability and inference
    )

    if result2.get('success'):
        log("[SUCCESS] Light regularization succeeded")
        log("="*80)
        log()
        result2['inference_method'] = 'light_regularization'
        result2['inference_note'] = 'Bias-reduced estimates using light ridge penalty (C=100) to address quasi-complete separation. Confidence intervals are approximate. Consider collecting more data for exact inference.'
        result2['separation_detected'] = True
        return result2
    else:
        log(f"[ERROR] Both methods failed. Last error: {result2.get('error')}")
        log("="*80)
        log()
        return {
            'success': False,
            'error': 'Both unpenalized and regularized methods failed. Data may have severe issues.',
            'unpenalized_error': result1.get('error'),
            'regularized_error': result2.get('error')
        }


def multiple_linear_regression(X, y, alpha=0.05):
    """
    Perform multiple linear regression

    Args:
        X: Feature matrix (2D array/list)
        y: Target variable (1D array/list)
        alpha: Significance level (default 0.05)

    Returns:
        Dictionary containing regression results
    """
    try:
        # Import statsmodels here
        try:
            import statsmodels.api as sm
        except ImportError:
            return {'success': False, 'error': 'statsmodels package required for multiple linear regression. Install with: pip install statsmodels'}

        metadata = _consume_context_metadata("multiple_linear_regression")
        feature_names = None
        predictor_baselines = None
        predictor_encodings = None
        if metadata:
            feature_names = metadata.get('feature_names')
            predictor_baselines = metadata.get('predictor_baselines')
            predictor_encodings = metadata.get('predictor_encodings')

        X_arr = np.array(X, dtype=float)
        if X_arr.ndim == 1:
            X_arr = X_arr.reshape(-1, 1)

        y_arr = preprocess_data(y)

        if feature_names is not None and len(feature_names) == X_arr.shape[1]:
            feature_names = [str(name) for name in feature_names]
            X_df = pd.DataFrame(X_arr, columns=feature_names)

            # Dummy variable expansion for categorical predictors
            dummy_mapping = {}  # Maps dummy column name -> (original_column, level_name)
            if predictor_encodings is not None and len(predictor_encodings) > 0:
                df_parts = []
                processed_cols = set()

                for col in X_df.columns:
                    if col in predictor_encodings:
                        # This is a categorical column - expand to dummies
                        processed_cols.add(col)
                        encoding = predictor_encodings[col]

                        # Create reverse mapping: code -> level_name
                        code_to_level = {int(code): level for level, code in encoding.items()}

                        # Find baseline (code 0)
                        baseline_level = code_to_level.get(0, None)

                        # Create dummy for each non-baseline level
                        for code, level_name in sorted(code_to_level.items()):
                            if code != 0:  # Skip baseline (reference category)
                                dummy_col_name = f"{col}_{level_name}"
                                dummy_series = (X_df[col] == code).astype(int)
                                df_parts.append(pd.DataFrame({dummy_col_name: dummy_series}))
                                dummy_mapping[dummy_col_name] = (col, level_name, baseline_level)
                    else:
                        # Continuous column - keep as-is
                        processed_cols.add(col)
                        df_parts.append(X_df[[col]])

                # Reassemble DataFrame with dummies
                if df_parts:
                    X_df = pd.concat(df_parts, axis=1)

            X_with_const = sm.add_constant(X_df, has_constant='add')
        else:
            feature_names = [f'X{i+1}' for i in range(X_arr.shape[1])]
            X_df = pd.DataFrame(X_arr, columns=feature_names)
            X_with_const = sm.add_constant(X_df, has_constant='add')
            dummy_mapping = {}

        # Fit model
        model = sm.OLS(y_arr, X_with_const).fit()

        conf_int = model.conf_int(alpha=alpha)

        # ========================================================================
        # PHASE 1: ANOVA TABLE
        # ========================================================================
        # Calculate sums of squares
        # model.ssr is residual sum of squares (SSE)
        # model.ess is regression sum of squares (SSR)
        sse = model.ssr
        ssr = model.ess if hasattr(model, 'ess') else (model.centered_tss - model.ssr)

        anova_table = {
            'model': {
                'df': int(model.df_model),           # Degrees of freedom (model)
                'ss': format_number(ssr),            # Sum of squares (regression)
                'ms': format_number(model.mse_model),# Mean square (model)
                'f': format_number(model.fvalue),    # F-statistic
                'p': format_number(model.f_pvalue)   # F p-value
            },
            'error': {
                'df': int(model.df_resid),           # Degrees of freedom (residual)
                'ss': format_number(sse),            # Sum of squares (error)
                'ms': format_number(model.mse_resid) # Mean square (error/residual)
            },
            'total': {
                'df': int(model.nobs - 1),           # Total DF
                'ss': format_number(model.centered_tss) # Total sum of squares
            }
        }

        # ========================================================================
        # PHASE 2: ROOT MSE AND MODEL FIT METRICS
        # ========================================================================
        rmse = np.sqrt(model.mse_resid)
        y_mean = np.mean(y_arr)
        cv = (rmse / y_mean) * 100 if y_mean != 0 else None

        model_fit_metrics = {
            'rmse': format_number(rmse),
            'dependent_mean': format_number(y_mean),
            'coefficient_variation': format_number(cv),
            'n_observations': int(model.nobs)
        }

        # ========================================================================
        # PHASE 3: STANDARDIZED COEFFICIENTS (Beta weights)
        # ========================================================================
        # Formula: β_std = β_unstd * (SD_X / SD_Y)
        std_y = np.std(y_arr, ddof=1)  # Sample standard deviation of Y
        standardized_betas = {}

        for name in X_df.columns if hasattr(X_df, 'columns') else []:
            if name in model.params.index:
                beta_unstd = model.params[name]
                std_x = np.std(X_df[name], ddof=1)

                # Standardized beta
                beta_std = beta_unstd * (std_x / std_y) if std_y != 0 else 0
                standardized_betas[name] = format_number(beta_std)

        # Intercept has no standardized beta (always 0)
        standardized_betas['const'] = 0

        # ========================================================================
        # PHASE 4: VIF (Variance Inflation Factor) for multicollinearity
        # ========================================================================
        from statsmodels.stats.outliers_influence import variance_inflation_factor

        vif_values = {}
        try:
            # VIF requires the constant term to be included
            X_with_const_arr = X_with_const.values if hasattr(X_with_const, 'values') else X_with_const

            for i, col_name in enumerate(X_with_const.columns if hasattr(X_with_const, 'columns') else []):
                if col_name != 'const':  # Skip intercept
                    vif = variance_inflation_factor(X_with_const_arr, i)
                    vif_values[col_name] = format_number(vif)
        except Exception:
            # VIF calculation failed (singular matrix, perfect multicollinearity, etc.)
            # Set all VIF values to None
            vif_values = {col: None for col in (X_df.columns if hasattr(X_df, 'columns') else [])}

        # ========================================================================
        # PHASE 5: DURBIN-WATSON TEST for autocorrelation
        # ========================================================================
        from statsmodels.stats.stattools import durbin_watson

        dw_statistic = durbin_watson(model.resid)

        # Interpretation (rule of thumb: DW ≈ 2 means no autocorrelation)
        if 1.5 <= dw_statistic <= 2.5:
            dw_interpretation = "No autocorrelation detected (DW≈2)"
        elif dw_statistic < 1.5:
            dw_interpretation = "Positive autocorrelation detected (DW<1.5)"
        else:
            dw_interpretation = "Negative autocorrelation detected (DW>2.5)"

        diagnostics = {
            'durbin_watson': format_number(dw_statistic),
            'dw_interpretation': dw_interpretation
        }

        coeff_table = []
        regression_coefficients = []
        for name in model.params.index:
            coef_val = model.params[name]
            se_val = model.bse[name]
            t_val = model.tvalues[name]
            p_val = model.pvalues[name]
            ci_lower_val = conf_int.loc[name].iloc[0]
            ci_upper_val = conf_int.loc[name].iloc[1]

            # Check if this is a dummy variable
            term_display = str(name)
            original_column = None
            level_name = None
            baseline_level = None
            if name in dummy_mapping:
                original_column, level_name, baseline_level = dummy_mapping[name]
                term_display = f"{original_column} [{level_name}]"
            elif name == 'const':
                term_display = 'Intercept'

            coeff_entry = {
                'term': str(name),
                'coef': format_number(coef_val),
                'se': format_number(se_val),
                't': format_number(t_val),
                'p': format_number(p_val),
                'ci_lower': format_number(ci_lower_val),
                'ci_upper': format_number(ci_upper_val),
                'significant': bool(p_val < alpha),
                'vif': vif_values.get(name, None)
            }
            coeff_table.append(coeff_entry)

            coeff_dict = {
                'class_label': None,
                'term': str(name),
                'term_display': term_display,
                'term_type': 'intercept' if name == 'const' else 'predictor',
                'beta': format_number(coef_val),
                'std_error': format_number(se_val),
                'statistic': format_number(t_val),
                'statistic_type': 't',
                'p_value': format_number(p_val),
                'significant': bool(p_val < alpha),
                'ci_lower': format_number(ci_lower_val),
                'ci_upper': format_number(ci_upper_val),
                'odds_ratio': None,
                'or_ci_lower': None,
                'or_ci_upper': None,
                'beta_standardized': standardized_betas.get(name, None),  # NEW: Standardized beta
                'vif': vif_values.get(name, None)                        # NEW: VIF
            }

            # Add dummy variable metadata
            if original_column is not None:
                coeff_dict['original_column'] = original_column
                coeff_dict['level_name'] = level_name
                coeff_dict['baseline_level'] = baseline_level

            regression_coefficients.append(coeff_dict)

        regression_summary = {
            'model_type': 'linear',
            'log_likelihood': format_number(model.llf),
            'mcfadden_r2': None,
            'r_squared': format_number(model.rsquared),
            'adj_r_squared': format_number(model.rsquared_adj),
            'accuracy': None,
            'aic': format_number(model.aic),
            'bic': format_number(model.bic),
            'f_statistic': format_number(model.fvalue),
            'f_p_value': format_number(model.f_pvalue),
            'n_observations': int(model.nobs),
            'n_features': int(X_arr.shape[1] if X_arr.ndim > 1 else 1),
            'df_model': format_number(model.df_model),
            'df_resid': format_number(model.df_resid),
            'alpha': format_number(alpha)
        }

        result = {
            'success': True,
            'coefficients': [float(c) for c in model.params],
            'std_errors': [float(se) for se in model.bse],
            't_values': [float(t) for t in model.tvalues],
            'p_values': [float(p) for p in model.pvalues],
            'coef_labels': [str(name) for name in model.params.index],
            'coeff_table': coeff_table,
            'feature_names': [str(name) for name in feature_names],
            'r_squared': format_number(model.rsquared),
            'adj_r_squared': format_number(model.rsquared_adj),
            'f_statistic': format_number(model.fvalue),
            'f_pvalue': format_number(model.f_pvalue),
            'is_significant': bool(model.f_pvalue < alpha),
            'alpha': format_number(alpha),
            'n_observations': int(model.nobs),
            'n_features': int(X_arr.shape[1] if X_arr.ndim > 1 else 1),
            'fitted_values': [float(val) for val in model.fittedvalues],
            'residuals': [float(val) for val in model.resid],
            'regression_summary': regression_summary,
            'regression_coefficients': regression_coefficients,
            'predictor_baselines': predictor_baselines,
            'anova_table': anova_table,              # NEW: ANOVA table
            'model_fit_metrics': model_fit_metrics,  # NEW: RMSE, dep mean, CV
            'diagnostics': diagnostics                # NEW: Durbin-Watson test
        }

        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}
