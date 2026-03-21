import csv
import os
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from python_embedded.statistics_module.anova import anova_two_way


def test_two_way_anova_exposes_flat_ci_fields_for_marginal_and_simple_effects():
    dependent = [
        10.2, 11.1, 14.9, 15.2, 12.0, 12.4,
        17.0, 17.4, 18.6, 19.1, 16.8, 17.2,
        14.1, 14.5, 17.3, 17.8, 13.6, 13.7,
    ]

    factor1_labels = ["A", "B", "C"]
    factor2_labels = ["X", "Y"]

    factor1 = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]
    factor2 = [0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0]

    result = anova_two_way(
        dependent,
        factor1,
        factor2,
        factor_names=["factor1", "factor2"],
        factor_level_labels={"factor1": factor1_labels, "factor2": factor2_labels},
        simple_effects={"factor_a_within_factor_b": True, "factor_b_within_factor_a": True},
    )

    assert result["success"] is True

    expected_keys = [
        "me1_ci_lower",
        "me1_ci_upper",
        "se1_ci_lower",
        "se1_ci_upper",
    ]

    for key in expected_keys:
        assert key in result, f"missing {key}"
        assert result[key] is not None


def test_two_way_anova_dunnett_ci_matches_r_reference_shape():
    data_path = (
        Path(PROJECT_ROOT)
        / "_test_validation"
        / "Group1_Hypothesis_Testing"
        / "anova_two_way"
        / "data"
        / "dataset_adjustment.csv"
    )

    rows = list(csv.DictReader(data_path.open("r", encoding="utf-8")))
    dependent = [float(row["value"]) for row in rows]

    factor1_labels = []
    factor2_labels = []
    factor1 = []
    factor2 = []

    for row in rows:
        factor1_label = row["factor1"]
        factor2_label = row["factor2"]

        if factor1_label not in factor1_labels:
            factor1_labels.append(factor1_label)
        if factor2_label not in factor2_labels:
            factor2_labels.append(factor2_label)

        factor1.append(factor1_labels.index(factor1_label))
        factor2.append(factor2_labels.index(factor2_label))

    result = anova_two_way(
        dependent,
        factor1,
        factor2,
        factor_names=["factor1", "factor2"],
        factor_level_labels={"factor1": factor1_labels, "factor2": factor2_labels},
        simple_effects={"factor_a_within_factor_b": True, "factor_b_within_factor_a": True},
        posthoc_adjustment="dunnett",
        control_levels={"factor1": "A", "factor2": "X"},
    )

    assert result["success"] is True
    assert result["me1_ci_lower"] == pytest.approx(-6.3512, abs=0.02)
    assert result["me1_ci_upper"] == pytest.approx(-4.6155, abs=0.02)
    assert result["se1_ci_lower"] == pytest.approx(-9.0532, abs=0.02)
    assert result["se1_ci_upper"] == pytest.approx(-6.0468, abs=0.02)
