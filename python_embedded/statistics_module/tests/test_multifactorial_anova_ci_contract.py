import csv
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from python_embedded.statistics_module.multifactorial_anova import multifactorial_anova


def _load_multifactorial_adjustment_dataset():
    data_path = (
        Path(PROJECT_ROOT)
        / "_test_validation"
        / "Group1_Hypothesis_Testing"
        / "multifactorial_anova"
        / "data"
        / "dataset_adjustment.csv"
    )

    rows = list(csv.DictReader(data_path.open("r", encoding="utf-8")))
    dependent = [float(row["value"]) for row in rows]
    factors = {
        "factor1": [row["factor1"] for row in rows],
        "factor2": [row["factor2"] for row in rows],
        "factor3": [row["factor3"] for row in rows],
    }
    return dependent, factors


def _load_multifactorial_adjustment_dataset_app_encoded():
    dependent, factors = _load_multifactorial_adjustment_dataset()
    encoded_factors = {}
    factor_level_labels = {}

    for factor_name, values in factors.items():
        labels = sorted({str(value) for value in values})
        factor_level_labels[factor_name] = labels
        encoded_factors[factor_name] = [labels.index(str(value)) for value in values]

    return dependent, encoded_factors, factor_level_labels


def test_multifactorial_anova_exposes_flat_ci_fields_for_marginal_and_simple_effects():
    dependent, factors = _load_multifactorial_adjustment_dataset()

    result = multifactorial_anova(
        dependent_var=dependent,
        factors=factors,
        factor_names=["factor1", "factor2", "factor3"],
        simple_effects_config=[
            {"factor": "factor1", "within": "factor2"},
            {"factor": "factor2", "within": "factor1"},
        ],
        posthoc_adjustment="tukey",
    )

    assert "me1_ci_lower" in result
    assert "me1_ci_upper" in result
    assert "se1_ci_lower" in result
    assert "se1_ci_upper" in result
    assert "me1_se" in result
    assert "se1_se" in result


def test_multifactorial_anova_exposes_pairwise_comparisons_for_shared_factorial_tables():
    dependent, factors = _load_multifactorial_adjustment_dataset()

    result = multifactorial_anova(
        dependent_var=dependent,
        factors=factors,
        factor_names=["factor1", "factor2", "factor3"],
        simple_effects_config=[
            {"factor": "factor1", "within": "factor2"},
            {"factor": "factor2", "within": "factor1"},
        ],
        posthoc_adjustment="tukey",
    )

    pairwise = result.get("pairwise_comparisons")
    assert isinstance(pairwise, list)
    assert any(entry.get("factor") and not entry.get("factor_scope") for entry in pairwise)
    assert any(entry.get("factor_scope") for entry in pairwise)


def test_multifactorial_anova_dunnett_ci_matches_r_reference_shape():
    dependent, encoded_factors, factor_level_labels = _load_multifactorial_adjustment_dataset_app_encoded()

    result = multifactorial_anova(
        dependent_var=dependent,
        factors=encoded_factors,
        factor_names=["factor1", "factor2", "factor3"],
        factor_level_labels=factor_level_labels,
        simple_effects_config=[
            {"factor": "factor1", "within": "factor2"},
            {"factor": "factor2", "within": "factor1"},
        ],
        posthoc_adjustment="dunnett",
        control_levels={"factor1": "A", "factor2": "X", "factor3": "Low"},
    )

    assert result["adjustment_method"] == "Dunnett"
    assert result["me1_ci_lower"] == pytest.approx(-6.3362, abs=0.02)
    assert result["me1_ci_upper"] == pytest.approx(-5.4861, abs=0.02)
    assert result["me5_estimate"] == pytest.approx(4.2111, abs=0.02)
    assert result["me5_ci_lower"] == pytest.approx(3.7885, abs=0.02)
    assert result["me5_ci_upper"] == pytest.approx(4.6337, abs=0.02)
    assert result["se1_ci_lower"] == pytest.approx(-8.7986, abs=0.02)
    assert result["se1_ci_upper"] == pytest.approx(-7.3347, abs=0.02)


@pytest.mark.skipif(
    not Path(r"C:\Program Files\R\R-4.5.1\bin\R.exe").exists(),
    reason="R 4.5.1 not installed at configured path",
)
def test_multifactorial_r_export_only_emits_marginal_effects_for_significant_main_effects():
    rows = ["factor1,factor2,factor3,value"]
    for factor1, factor1_effect in [("A", 0.0), ("B", 5.0)]:
        for factor2, factor2_effect in [("X", 0.0), ("Y", 3.0)]:
            for factor3 in ["Low", "High"]:
                for replicate, noise in enumerate([-0.2, 0.2], start=1):
                    value = 10.0 + factor1_effect + factor2_effect + noise
                    rows.append(f"{factor1},{factor2},{factor3},{value:.2f}")

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        data_file = temp_path / "dataset.csv"
        output_dir = temp_path / "results"
        output_file = output_dir / "r_result.csv"
        data_file.write_text("\n".join(rows) + "\n", encoding="utf-8")

        env = os.environ.copy()
        env.update(
            {
                "DATA_FILE": str(data_file),
                "OUTPUT_DIR": str(output_dir),
                "OUTPUT_FILE": str(output_file),
                "ADJUST_METHOD": "tukey",
            }
        )

        subprocess.run(
            [r"C:\Program Files\R\R-4.5.1\bin\R.exe", "--vanilla", "-f", "run_test.R"],
            cwd=Path(PROJECT_ROOT)
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "multifactorial_anova"
            / "r",
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )

        metrics = dict(csv.reader(output_file.open("r", encoding="utf-8")))

    assert metrics["factor1_significant"] == "TRUE"
    assert metrics["factor2_significant"] == "TRUE"
    assert metrics["factor3_significant"] == "FALSE"
    assert metrics["me1_factor"] == "factor1"
    assert metrics["me2_factor"] == "factor2"
    assert "me3_factor" not in metrics
