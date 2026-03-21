import csv
import os
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from python_embedded.statistics_module.parametric import anova_one_way


def _load_one_way_adjustment_groups():
    data_path = (
        Path(PROJECT_ROOT)
        / "_test_validation"
        / "Group1_Hypothesis_Testing"
        / "anova_one_way"
        / "data"
        / "dataset_adjustment.csv"
    )

    rows = list(csv.DictReader(data_path.open("r", encoding="utf-8")))
    ordered_labels = []
    grouped = {}
    for row in rows:
        label = row["group"]
        if label not in grouped:
            ordered_labels.append(label)
            grouped[label] = []
        grouped[label].append(float(row["value"]))

    return [grouped[label] for label in ordered_labels], ordered_labels


def _run_one_way_adjustment(method: str, **metadata):
    groups, labels = _load_one_way_adjustment_groups()
    return anova_one_way(
        *groups,
        group_labels=labels,
        posthoc_adjustment=method,
        **metadata,
    )


def test_one_way_anova_exposes_flat_posthoc_ci_fields():
    result = _run_one_way_adjustment("tukey")

    assert result["success"] is True
    for key in [
        "posthoc1_se",
        "posthoc1_ci_lower",
        "posthoc1_ci_upper",
        "posthoc1_df",
        "posthoc1_t",
    ]:
        assert key in result, f"missing {key}"
        assert result[key] is not None

    first_pair = result["pairwise_comparisons"][0]
    assert "se" in first_pair
    assert "ci_lower" in first_pair
    assert "ci_upper" in first_pair
    assert "df" in first_pair
    assert "t_stat" in first_pair


def test_one_way_anova_dunnett_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("dunnett", control_level="Control")

    assert result["success"] is True
    assert result["adjustment_method"] == "Dunnett"
    assert result["posthoc1_mean_diff"] == pytest.approx(4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(4.0519, abs=0.02)
    assert result["posthoc1_ci_upper"] == pytest.approx(5.3481, abs=0.02)
    assert result["posthoc1_t"] == pytest.approx(18.1110, abs=0.02)


def test_one_way_anova_bonferroni_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("bonferroni")

    assert result["success"] is True
    assert result["posthoc1_mean_diff"] == pytest.approx(-4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.4367, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-3.9633, abs=0.0002)


def test_one_way_anova_sidak_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("sidak")

    assert result["success"] is True
    assert result["posthoc1_mean_diff"] == pytest.approx(-4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.4344, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-3.9656, abs=0.0002)


def test_one_way_anova_holm_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("holm")

    assert result["success"] is True
    assert result["posthoc1_mean_diff"] == pytest.approx(-4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.4367, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-3.9633, abs=0.0002)


def test_one_way_anova_holm_sidak_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("holm-sidak")

    assert result["success"] is True
    assert result["posthoc1_mean_diff"] == pytest.approx(-4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.2315, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-4.1685, abs=0.0002)


def test_one_way_anova_fdr_default_q_ci_matches_r_reference_shape():
    result = _run_one_way_adjustment("fdr_bh")

    assert result["success"] is True
    assert result["posthoc_q"] == pytest.approx(0.05, abs=0.0001)
    assert result["posthoc1_mean_diff"] == pytest.approx(-4.7, abs=0.0001)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.4367, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-3.9633, abs=0.0002)


def test_one_way_anova_fdr_custom_q_updates_threshold_without_changing_ci_rule():
    result = _run_one_way_adjustment("fdr_bh", posthoc_q=1e-12)

    assert result["success"] is True
    assert result["posthoc_q"] == pytest.approx(1e-12, abs=1e-16)
    assert result["posthoc1_ci_lower"] == pytest.approx(-5.4367, abs=0.0002)
    assert result["posthoc1_ci_upper"] == pytest.approx(-3.9633, abs=0.0002)
    assert result["pairwise_comparisons"][0]["significant"] is True
    assert result["pairwise_comparisons"][2]["significant"] is False
    assert result["pairwise_comparisons"][4]["significant"] is False
