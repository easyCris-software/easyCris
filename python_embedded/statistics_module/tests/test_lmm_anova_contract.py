import csv
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from pathlib import Path
import importlib
import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
VALIDATION_SCRIPTS = PROJECT_ROOT / "_test_validation" / "scripts"
if str(VALIDATION_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(VALIDATION_SCRIPTS))

from python_embedded.statistics_module.lmm_anova import lmm_anova
from data_adapters import adapt_lmm_anova
from python_utils import load_csv


EMBEDDED_PYTHON = PROJECT_ROOT / "python_embedded" / "python.exe"
MAIN_PROJECT_ROOT = PROJECT_ROOT.parent.parent if PROJECT_ROOT.parent.name == ".worktrees" else PROJECT_ROOT
DEFAULT_TEST_EMBEDDED_PYTHON = MAIN_PROJECT_ROOT / "python_embedded" / "python.exe"
TEST_EMBEDDED_PYTHON = Path(os.environ.get("LMM_TEST_EMBEDDED_PYTHON", str(DEFAULT_TEST_EMBEDDED_PYTHON)))
STATS_BACKEND = PROJECT_ROOT / "python_embedded" / "stats_backend.py"
LOCAL_R_EXE = Path(r"C:\Program Files\R\R-4.5.1\bin\R.exe")
LMM_DATA_DIR = (
    PROJECT_ROOT
    / "_test_validation"
    / "Group1_Hypothesis_Testing"
    / "linear_mixed_models"
    / "data"
)
LMM_PY_RUNNER = (
    PROJECT_ROOT
    / "_test_validation"
    / "Group1_Hypothesis_Testing"
    / "linear_mixed_models"
    / "python"
    / "run_test.py"
)
NUMERIC_TIME_R_EXPORT = (
    PROJECT_ROOT
    / "_test_validation"
    / "Group1_Hypothesis_Testing"
    / "linear_mixed_models"
    / "r"
    / "export_numeric_time_inference.R"
)
NUMERIC_TIME_COMPARE = (
    PROJECT_ROOT
    / "_test_validation"
    / "Group1_Hypothesis_Testing"
    / "linear_mixed_models"
    / "python"
    / "compare_numeric_time_inference.py"
)
LMM_ANOVA_MODULE = importlib.import_module("python_embedded.statistics_module.lmm_anova")

ALL_ADJUSTMENTS = [
    "tukey",
    "bonferroni",
    "holm",
    "holm-sidak",
    "sidak",
    "fdr_bh",
    "dunnett",
]
ALL_CATEGORICAL_CONTROLS = {
    "Treatment": "A",
    "Sex": "F",
    "Strain": "B6",
    "Day": "D0",
}


def _multifactor_payload() -> dict:
    subjects = []
    dependent = []
    treatment = []
    sex = []
    strain = []
    day = []

    day_effect = {"D0": 0.0, "D1": 1.1, "D2": 2.0}
    treatment_effect = {"A": 0.0, "B": 2.4}
    sex_effect = {"F": 0.0, "M": 0.8}
    strain_effect = {"B6": 0.0, "D2": 1.3}

    for t_idx, trt in enumerate(["A", "B"]):
        for s_idx, sex_level in enumerate(["F", "M"]):
            for st_idx, strain_level in enumerate(["B6", "D2"]):
                combo_offset = t_idx * 4 + s_idx * 2 + st_idx
                for rep in range(3):
                    subject_id = f"{trt}{sex_level}{strain_level}_{rep + 1}"
                    subject_bias = (combo_offset + rep) * 0.15
                    for day_level in ["D0", "D1", "D2"]:
                        mean = (
                            10.0
                            + treatment_effect[trt]
                            + sex_effect[sex_level]
                            + strain_effect[strain_level]
                            + day_effect[day_level]
                            + (0.7 if trt == "B" and day_level != "D0" else 0.0)
                            + (0.4 if strain_level == "D2" and sex_level == "M" else 0.0)
                            + subject_bias
                        )
                        subjects.append(subject_id)
                        dependent.append(round(mean, 4))
                        treatment.append(trt)
                        sex.append(sex_level)
                        strain.append(strain_level)
                        day.append(day_level)

    return {
        "dependent": dependent,
        "subject": subjects,
        "predictors": {
            "Treatment": treatment,
            "Sex": sex,
            "Strain": strain,
            "Day": day,
        },
        "predictor_types": {
            "Treatment": "categorical",
            "Sex": "categorical",
            "Strain": "categorical",
            "Day": "categorical",
        },
        "factor_level_labels": {
            "Treatment": ["A", "B"],
            "Sex": ["F", "M"],
            "Strain": ["B6", "D2"],
            "Day": ["D0", "D1", "D2"],
        },
    }


def _load_rows(name: str) -> list[dict[str, str]]:
    path = LMM_DATA_DIR / name
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _categorical_payload(name: str = "dataset_01.csv") -> dict:
    rows = _load_rows(name)
    return {
        "dependent": [float(row["value"]) for row in rows],
        "subject": [row["subject"] for row in rows],
        "predictors": {
            "Treatment": [row["treatment"] for row in rows],
            "Sex": [row["sex"] for row in rows],
            "Strain": [row["strain"] for row in rows],
            "Day": [row["day"] for row in rows],
        },
        "predictor_types": {
            "Treatment": "categorical",
            "Sex": "categorical",
            "Strain": "categorical",
            "Day": "categorical",
        },
        "factor_level_labels": {
            "Treatment": ["A", "B"],
            "Sex": ["F", "M"],
            "Strain": ["B6", "D2"],
            "Day": ["D0", "D1", "D2"],
        },
    }


def _continuous_slope_payload() -> dict:
    rows = _load_rows("dataset_01.csv")
    return {
        "dependent": [float(row["value"]) for row in rows],
        "subject": [row["subject"] for row in rows],
        "predictors": {
            "Treatment": [row["treatment"] for row in rows],
            "Sex": [row["sex"] for row in rows],
            "Strain": [row["strain"] for row in rows],
            "Day_num": [float(row["day_num"]) for row in rows],
        },
        "predictor_types": {
            "Treatment": "categorical",
            "Sex": "categorical",
            "Strain": "categorical",
            "Day_num": "continuous",
        },
        "factor_level_labels": {
            "Treatment": ["A", "B"],
            "Sex": ["F", "M"],
            "Strain": ["B6", "D2"],
        },
    }


def _stable_random_slope_payload() -> dict:
    rows = _load_rows("dataset_slope_01.csv")
    return {
        "dependent": [float(row["value"]) for row in rows],
        "subject": [row["subject"] for row in rows],
        "predictors": {
            "Treatment": [row["treatment"] for row in rows],
            "Day_num": [float(row["day_num"]) for row in rows],
        },
        "predictor_types": {
            "Treatment": "categorical",
            "Day_num": "continuous",
        },
        "factor_level_labels": {
            "Treatment": ["A", "B"],
        },
    }


def _run_backend_payload(payload: dict) -> dict:
    result = subprocess.run(
        [str(TEST_EMBEDDED_PYTHON), str(STATS_BACKEND)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=str(PROJECT_ROOT),
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return json.loads(result.stdout)


def _load_lmm_python_runner():
    spec = importlib.util.spec_from_file_location("lmm_validation_runner", LMM_PY_RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _load_numeric_time_compare_module():
    spec = importlib.util.spec_from_file_location("numeric_time_compare", NUMERIC_TIME_COMPARE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _run_numeric_time_validation(
    output_dir: Path,
    mode: str,
    *,
    time_transform: str | None = None,
    target_stratum: dict[str, str] | None = None,
) -> dict:
    env = os.environ.copy()
    env["OUTPUT_DIR"] = str(output_dir)
    env["RANDOM_EFFECTS_MODE"] = mode
    env["R_LMER_DF"] = "satterthwaite"
    env["DF_METHOD"] = "satterthwaite"
    if time_transform:
        env["TIME_TRANSFORM"] = time_transform
    if target_stratum:
        env["TARGET_TRAIT"] = target_stratum["trait"]
        env["TARGET_STRAIN"] = target_stratum["strain"]
        env["TARGET_SEX"] = target_stratum["sex"]

    r_result = subprocess.run(
        [str(LOCAL_R_EXE), "--vanilla", "-f", str(NUMERIC_TIME_R_EXPORT)],
        text=True,
        capture_output=True,
        cwd=str(PROJECT_ROOT),
        env=env,
        timeout=240,
        check=False,
    )
    if r_result.returncode != 0:
        raise RuntimeError(r_result.stderr.strip() or r_result.stdout.strip())

    py_result = subprocess.run(
        [str(TEST_EMBEDDED_PYTHON), str(NUMERIC_TIME_COMPARE)],
        text=True,
        capture_output=True,
        cwd=str(PROJECT_ROOT),
        env=env,
        timeout=240,
        check=False,
    )
    if py_result.returncode != 0:
        raise RuntimeError(py_result.stderr.strip() or py_result.stdout.strip())

    if time_transform == "center_scale" and target_stratum:
        summary_name = "numeric_time_center_scale_target_diff_summary.json"
    else:
        summary_name = (
            "numeric_time_random_intercept_diff_summary.json"
            if mode == "random_intercept"
            else "numeric_time_contrast_diff_summary.json"
        )
    return json.loads((output_dir / summary_name).read_text(encoding="utf-8"))


def test_lmm_anova_supports_all_adjustments_for_categorical_simple_effects():
    payload = _categorical_payload()

    for method in ALL_ADJUSTMENTS:
        result = lmm_anova(
            payload["dependent"],
            payload["subject"],
            payload["predictors"],
            predictor_types=payload["predictor_types"],
            factor_level_labels=payload["factor_level_labels"],
            alpha=0.05,
            reml=False,
            random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment=method,
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

        assert result["success"] is True, method
        assert result["adjustment_method"]
        assert result["means_type"] == "lsmean"
        assert result["pairwise_comparisons"], method
        assert "me1_ci_lower" in result
        assert "se1_ci_lower" in result

        adjusted = [row for row in result["pairwise_comparisons"] if row.get("p_adjusted") is not None]
        assert adjusted, method

        if method == "dunnett":
            treatment_rows = [
                row for row in result["pairwise_comparisons"] if row.get("factor") == "Treatment"
            ]
            assert treatment_rows
            for row in treatment_rows:
                assert row["group2"] == "A"
                assert str(row["contrast"]).endswith("vs A")


def test_apply_dunnett_adjustment_canonicalizes_control_as_group2_and_flips_sign_fields():
    comparisons = [
        {
            "group1": "A",
            "group2": "B",
            "estimate": 1.25,
            "se": 0.5,
            "t_stat": 2.5,
            "df": 10.0,
            "p_raw": 0.02,
            "p_adjusted": 0.02,
            "ci_lower": 0.2,
            "ci_upper": 2.3,
            "contrast_vector": np.array([1.0, -1.0], dtype=float),
        }
    ]

    adjusted = LMM_ANOVA_MODULE._apply_dunnett_adjustment(
        comparisons=comparisons,
        control_level="A",
        alpha=0.05,
        df_approx=10.0,
        cov_fe=np.eye(2, dtype=float),
    )

    assert len(adjusted) == 1
    row = adjusted[0]
    assert row["group1"] == "B"
    assert row["group2"] == "A"
    assert row["estimate"] < 0
    assert row["t_stat"] < 0
    assert row["p_raw"] == 0.02
    assert row["p_adjusted"] == 0.02
    assert np.allclose(np.asarray(row["contrast_vector"], dtype=float), np.array([-1.0, 1.0]))
    assert row["ci_lower"] < row["ci_upper"]
    assert row["method"] == "Dunnett (model-based)"


def test_lmm_anova_stratified_runs_one_fit_per_selected_stratum():
    payload = _categorical_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        interaction_depth=2,
        df_method="satterthwaite",
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        stratify_by=["Sex", "Strain"],
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
    )

    assert result["success"] is True
    assert result["test_type"] == "lmm_anova_stratified"
    assert result["stratified"] is True
    assert result["stratify_by"] == ["Sex", "Strain"]
    assert len(result["strata_results"]) == 4

    labels = {item["stratum_label"] for item in result["strata_results"]}
    assert labels == {
        "Sex=F | Strain=B6",
        "Sex=F | Strain=D2",
        "Sex=M | Strain=B6",
        "Sex=M | Strain=D2",
    }

    for child in result["strata_results"]:
        assert child["success"] is True
        assert child["test_type"] == "lmm_anova"
        assert child["stratum"]
        assert set(child["stratum"].keys()) == {"Sex", "Strain"}
        assert {predictor["name"] for predictor in child["predictors"]} == {"Treatment", "Day"}
        assert "Sex" not in child["formula"]
        assert "Strain" not in child["formula"]


def test_lmm_anova_accepts_kenward_roger_for_random_intercept_models():
    payload = _categorical_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
        df_method="kenward_roger",
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "kenward_roger"
    assert result["applied_df_method"] == "kenward_roger"
    assert result["requested_reml"] is False
    assert result["inference_fit_reml"] is True
    assert result["kr_reml_refit"] is True
    assert result["contrast_method"] == "kenward_roger_t"
    assert all(row["inference"] == "kenward_roger_t" for row in result["pairwise_comparisons"])
    assert any("internal reml refit" in warning.lower() for warning in result["warnings"])


def test_lmm_anova_kenward_roger_uses_existing_reml_fit_without_refit():
    payload = _categorical_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=True,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
        df_method="kenward_roger",
    )

    assert result["success"] is True
    assert result["requested_reml"] is True
    assert result["inference_fit_reml"] is True
    assert result["kr_reml_refit"] is False
    assert not any("internal reml refit" in warning.lower() for warning in result.get("warnings", []))


def test_lmm_anova_rejects_kenward_roger_for_random_slope_models():
    payload = _stable_random_slope_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=True,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
        df_method="kenward_roger",
    )

    assert result["success"] is False
    assert "Kenward-Roger currently supports only random-intercept models" in result["error"]


def test_lmm_anova_stratified_rejects_using_all_predictors_as_strata():
    payload = _categorical_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        interaction_depth=2,
        df_method="satterthwaite",
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        stratify_by=["Treatment", "Sex", "Strain", "Day"],
    )

    assert result["success"] is False
    assert "remaining model predictors" in result["error"].lower()


def test_stratified_lmm_subsets_group_values_by_actual_row_indices(monkeypatch):
    payload = _categorical_payload()
    observed = []

    def fake_child(*args, **kwargs):
        observed.append(list(kwargs["random_effects_config"]["group_values"]))
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": []},
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "group_values": [f"group_{idx}" for idx in range(len(payload["dependent"]))],
            "random_intercept": True,
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Sex", "Strain"],
    )

    assert result["success"] is True
    assert observed
    first_stratum_rows = [
        idx
        for idx, (sex, strain) in enumerate(
            zip(payload["predictors"]["Sex"], payload["predictors"]["Strain"], strict=False)
        )
        if sex == "F" and strain == "B6"
    ]
    assert observed[0] == [f"group_{idx}" for idx in first_stratum_rows]


def test_stratified_lmm_filters_random_slopes_removed_by_stratification(monkeypatch):
    payload = _continuous_slope_payload()
    observed = []

    def fake_child(*args, **kwargs):
        observed.append(list(kwargs["random_effects_config"].get("random_slopes") or []))
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": []},
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num", "Treatment"],
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Treatment"],
    )

    assert result["success"] is True
    assert observed
    assert observed[0] == ["Day_num"]


def test_stratified_lmm_hoists_successful_child_warnings_and_posthoc_metadata(monkeypatch):
    payload = _categorical_payload()
    call_count = {"value": 0}

    def fake_child(*args, **kwargs):
        call_count["value"] += 1
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": [f"warning-{call_count['value']}"]},
            "warnings": [f"warning-{call_count['value']}"],
            "adjustment_method": "Tukey HSD",
            "posthoc_q": 0.05,
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Strain"],
    )

    assert result["success"] is True
    assert result["adjustment_method"] == "Tukey HSD"
    assert result["posthoc_q"] == 0.05
    assert result["warnings"]
    assert len(result["warnings"]) == len(result["strata_results"])
    assert any("warning-1" in warning for warning in result["warnings"])
    assert any("warning-2" in warning for warning in result["warnings"])


def test_stratified_lmm_aggregates_inference_fit_reml_across_successful_children(monkeypatch):
    payload = _categorical_payload()
    call_count = {"value": 0}

    def fake_child(*args, **kwargs):
        call_count["value"] += 1
        inference_fit_reml = call_count["value"] == 1
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": []},
            "warnings": [],
            "adjustment_method": "Tukey HSD",
            "posthoc_q": 0.05,
            "requested_reml": False,
            "inference_fit_reml": inference_fit_reml,
            "kr_reml_refit": call_count["value"] == 1,
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="kenward_roger",
        stratify_by=["Strain"],
    )

    assert result["success"] is True
    assert result["requested_reml"] is False
    assert result["inference_fit_reml"] is None
    assert result["kr_reml_refit"] is True


def test_stratified_lmm_marks_inference_fit_reml_as_mixed_when_successful_children_differ(monkeypatch):
    payload = _categorical_payload()
    call_count = {"value": 0}

    def fake_child(*args, **kwargs):
        call_count["value"] += 1
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": []},
            "warnings": [],
            "adjustment_method": "Tukey HSD",
            "posthoc_q": 0.05,
            "requested_reml": False,
            "inference_fit_reml": call_count["value"] == 1,
            "kr_reml_refit": call_count["value"] == 1,
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="kenward_roger",
        stratify_by=["Strain"],
    )

    assert result["success"] is True
    assert result["requested_reml"] is False
    assert result["inference_fit_reml"] is None
    assert result["kr_reml_refit"] is True


def test_stratified_lmm_skips_tiny_strata_with_descriptive_error(monkeypatch):
    payload = {
        "dependent": [1.0, 2.0, 3.0],
        "subject": ["s1", "s2", "s3"],
        "predictors": {
            "Treatment": ["A", "A", "B"],
            "Day": ["D0", "D1", "D0"],
            "Sex": ["F", "M", "M"],
        },
        "predictor_types": {
            "Treatment": "categorical",
            "Day": "categorical",
            "Sex": "categorical",
        },
        "factor_level_labels": {
            "Treatment": ["A", "B"],
            "Day": ["D0", "D1"],
            "Sex": ["F", "M"],
        },
    }

    called = {"value": False}

    def fake_child(*args, **kwargs):
        called["value"] = True
        raise AssertionError("child fit should not run for tiny strata")

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Sex"],
    )

    assert called["value"] is False
    assert result["success"] is False
    assert "all stratified lmm_anova fits failed" in result["error"].lower()


def test_stratified_lmm_warns_when_simple_effect_references_stratified_factor(monkeypatch):
    payload = _categorical_payload()

    def fake_child(*args, **kwargs):
        return {
            "success": True,
            "test_type": "lmm_anova",
            "fixed_effects": [],
            "pairwise_comparisons": [],
            "diagnostics": {"warnings": []},
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Sex"}],
        factor_level_labels=payload["factor_level_labels"],
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=0.05,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Sex"],
    )

    assert result["success"] is True
    assert result["warnings"]
    assert any("Treatment within Sex" in warning for warning in result["warnings"])


def test_stratified_lmm_hoists_dropped_simple_effect_warning_even_when_child_fit_fails(monkeypatch):
    def _fake_child(*args, **kwargs):
        return {
            "success": False,
            "test_type": "lmm_anova",
            "error": "synthetic child failure",
            "diagnostics": {"warnings": []},
        }

    monkeypatch.setattr(LMM_ANOVA_MODULE, "lmm_anova", _fake_child)

    result = LMM_ANOVA_MODULE._run_stratified_lmm(
        dependent=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        subject=["s1", "s1", "s2", "s2", "s3", "s3"],
        predictors={
            "Treatment": ["A", "A", "B", "B", "A", "B"],
            "Sex": ["F", "F", "F", "F", "F", "F"],
            "Day": [0, 1, 0, 1, 0, 1],
        },
        predictor_types={
            "Treatment": "categorical",
            "Sex": "categorical",
            "Day": "categorical",
        },
        alpha=0.05,
        reml=False,
        random_effects_config={"random_intercept": True},
        simple_effects_config=[{"factor": "Treatment", "within": "Sex"}],
        factor_level_labels={},
        posthoc_adjustment="tukey",
        control_levels={},
        posthoc_q=None,
        interaction_depth=2,
        df_method="satterthwaite",
        stratify_by=["Sex"],
    )

    assert result["success"] is False
    assert result["error"] == "All stratified lmm_anova fits failed."
    assert result["warnings"]
    assert any("synthetic child failure" in warning for warning in result["warnings"])
    assert any("Treatment within Sex" in warning for warning in result["warnings"])


def test_lmm_anova_supports_random_slope_for_one_continuous_predictor():
    payload = _continuous_slope_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert result["random_effects"]["random_intercept"] is True
    assert result["random_effects"]["random_slopes"] == ["Day_num"]
    assert result["fixed_effects"]
    assert result["fit_metrics"]["optimizer"]


def test_lmm_anova_supports_more_than_two_fixed_predictors():
    payload = _multifactor_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert len(result["predictors"]) == 4
    assert {item["name"] for item in result["predictors"]} == {"Treatment", "Sex", "Strain", "Day"}
    assert any(row["source"] == "Treatment" for row in result["fixed_effects"])
    assert any(row["source"] == "Sex" for row in result["fixed_effects"])
    assert any(row["source"] == "Strain" for row in result["fixed_effects"])
    assert any(row["source"] == "Day" for row in result["fixed_effects"])
    assert "fe1_source" in result
    assert "fe1_p" in result
    assert result["estimated_means"]
    assert any(row.get("factor") == "Treatment" for row in result["pairwise_comparisons"])
    assert any(row.get("factor_scope", "").startswith("Treatment|Day=") for row in result["pairwise_comparisons"])
    assert "se1_ci_lower" in result


def test_lmm_anova_defaults_to_two_way_interactions_for_multifactor_models():
    payload = _multifactor_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert ":" in result["formula"]
    assert "Treatment):C(Sex, Sum):C(Strain" not in result["formula"]
    assert not any(" x " in row["source"] and row["source"].count(" x ") > 1 for row in result["fixed_effects"])


def test_lmm_anova_requires_explicit_dunnett_controls_for_all_categorical_targets():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="dunnett",
        control_levels={"Treatment": "A"},
    )

    assert result["success"] is False
    assert "control" in result["error"].lower()


def test_lmm_anova_uses_configured_group_values_when_supplied():
    payload = _categorical_payload()
    group_values = []
    for subject_id in payload["subject"]:
        suffix = subject_id.rsplit("_", 1)[-1]
        group_values.append(f"Batch_{suffix}")

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Batch",
            "group_values": group_values,
            "random_intercept": True,
        },
        posthoc_adjustment="holm",
        control_levels={"Treatment": "A"},
    )

    assert result["success"] is True
    assert result["grouping_variable"] == "Batch"
    assert result["subject_count"] == 3


def test_lmm_anova_defaults_pairwise_outputs_to_satterthwaite_inference_for_phase1a_models():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert result["fit_metrics"]["converged"] is True
    assert result["requested_df_method"] == "satterthwaite"
    assert result["applied_df_method"] == "satterthwaite"
    assert result["finite_df_requested"] is True
    assert result["finite_df_applied"] is True
    assert result["finite_df_available"] is True
    assert result["finite_df_boundary_warning"] is False
    assert result["finite_df_fallback_reason"] is None
    assert result["omnibus_method"] == "satterthwaite_f"
    assert result["contrast_method"] == "satterthwaite_t"
    assert all(row["df"] is not None for row in result["pairwise_comparisons"])
    assert all(row["df"] is not None for row in result["estimated_means"])
    assert all(row["inference"] == "satterthwaite_t" for row in result["estimated_means"])


def test_lmm_anova_uses_finite_df_inference_for_stable_one_random_slope_models():
    payload = _stable_random_slope_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "satterthwaite"
    assert result["applied_df_method"] == "satterthwaite"
    assert result["finite_df_requested"] is True
    assert result["finite_df_applied"] is True
    assert result["finite_df_available"] is True
    assert result["finite_df_mode"] == "phase1b"
    assert result["finite_df_boundary_warning"] is False
    assert result["finite_df_fallback_reason"] is None
    assert result["omnibus_method"] == "satterthwaite_f"
    assert result["contrast_method"] == "satterthwaite_t"
    assert "omnibus_inference" in result
    assert result["omnibus_inference"].startswith("Satterthwaite")
    assert all(row["inference"] == "satterthwaite_f" for row in result["fixed_effects"])
    assert all(row["df"] is not None for row in result["pairwise_comparisons"])
    assert all(row["df"] is not None for row in result["estimated_means"])
    assert all(row["inference"] == "satterthwaite_t" for row in result["estimated_means"])
    assert "diag_random_effect_variance_3" in result
    assert "me1_p_adjusted" in result
    assert "fe1_df" in result
    assert isinstance(result["fe1_df"], float)
    assert isinstance(result["me1_df"], float)


def test_lmm_anova_supports_numeric_time_group_contrasts_for_random_slope_models():
    payload = _stable_random_slope_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
        posthoc_q=0.05,
        simple_effects_config=[],
        continuous_effects_config={
            "mode": "at_values",
            "group_factor": "Treatment",
            "time_factor": "Day_num",
            "time_values": [0.0, 2.0, 4.0],
        },
    )

    assert result["success"] is True
    assert result["pairwise_comparisons"]
    continuous_rows = [row for row in result["pairwise_comparisons"] if row.get("time_factor") == "Day_num"]
    assert continuous_rows
    scopes = {row.get("factor_scope") for row in continuous_rows}
    assert "Treatment|Day_num=0" in scopes
    assert "Treatment|Day_num=2" in scopes
    assert "Treatment|Day_num=4" in scopes
    assert all(row.get("factor") == "Treatment" for row in continuous_rows)
    assert all(row.get("time_value") is not None for row in continuous_rows)
    assert all(row.get("inference") == "satterthwaite_t" for row in continuous_rows)
    assert all(row.get("df") is not None for row in continuous_rows)
    assert all(np.isfinite(float(row["df"])) for row in continuous_rows)
    assert result["contrast_method"] == "satterthwaite_t"
    assert isinstance(result.get("continuous_effects"), list)
    assert result["continuous_effects"]
    assert "ce1_label" in result
    assert result["ce1_label"].startswith("A vs B|Treatment|Day_num=")
    assert result["ce1_time_factor"] == "Day_num"


def test_lmm_anova_warns_when_numeric_time_group_factor_has_single_level_after_filtering():
    payload = _stable_random_slope_payload()
    payload["predictors"]["Treatment"] = ["A"] * len(payload["predictors"]["Treatment"])
    payload["factor_level_labels"]["Treatment"] = ["A"]

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        continuous_effects_config={
            "mode": "at_values",
            "group_factor": "Treatment",
            "time_factor": "Day_num",
            "time_values": [0.0, 2.0, 4.0],
        },
    )

    assert result["success"] is False or not result.get("continuous_effects")
    if result["success"]:
        warnings = result["diagnostics"]["warnings"]
        assert any("continuous-time contrasts" in warning.lower() for warning in warnings)


def test_lmm_anova_attempts_finite_df_on_singular_random_slope_models_when_bundle_succeeds(monkeypatch):
    payload = _stable_random_slope_payload()

    original_build_diagnostics = LMM_ANOVA_MODULE._build_diagnostics

    def _singular_diagnostics(*args, **kwargs):
        diagnostics = original_build_diagnostics(*args, **kwargs)
        diagnostics["singular_fit"] = True
        diagnostics["near_zero_random_variance"] = False
        diagnostics["warnings"] = list(diagnostics.get("warnings", []))
        if not any("appears singular" in warning.lower() for warning in diagnostics["warnings"]):
            diagnostics["warnings"].append("Random-effects covariance appears singular.")
        return diagnostics

    monkeypatch.setattr(LMM_ANOVA_MODULE, "_build_diagnostics", _singular_diagnostics)

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "satterthwaite"
    assert result["applied_df_method"] == "satterthwaite"
    assert result["finite_df_requested"] is True
    assert result["finite_df_applied"] is True
    assert result["finite_df_available"] is True
    assert result["finite_df_mode"] == "phase1b"
    assert result["finite_df_boundary_warning"] is True
    assert result["finite_df_fallback_reason"] is None
    assert result["omnibus_method"] == "satterthwaite_f"
    assert result["contrast_method"] == "satterthwaite_t"
    assert any("results may be unstable" in warning.lower() for warning in result["diagnostics"]["warnings"])
    assert result["warnings"] == result["diagnostics"]["warnings"]


def test_lmm_anova_falls_back_to_asymptotic_when_phase1a_bundle_fails(monkeypatch):
    payload = _categorical_payload()

    def _explode(_fit):
        raise ValueError("synthetic phase1a failure")

    monkeypatch.setattr(LMM_ANOVA_MODULE, "_build_finite_df_inference_bundle", _explode)

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "satterthwaite"
    assert result["finite_df_requested"] is True
    assert result["finite_df_applied"] is False
    assert result["applied_df_method"] == "asymptotic"
    assert result["finite_df_available"] is False
    assert result["finite_df_fallback_reason"] is not None
    assert result["omnibus_method"] == "wald_chi2"
    assert result["contrast_method"] == "asymptotic_z"
    assert any("fell back to asymptotic inference" in warning.lower() for warning in result["diagnostics"]["warnings"])
    assert result["warnings"] == result["diagnostics"]["warnings"]


def test_lmm_anova_future_omnibus_contract_exposes_f_surface():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert "fe1_statistic_type" in result
    assert "fe1_f_value" in result
    assert "fe1_num_df" in result
    assert "fe1_den_df" in result
    assert result["fixed_effects"][0]["statistic_type"] == "F"


def test_lmm_anova_future_pairwise_contract_exposes_raw_p_surface():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert "me1_p_raw" in result
    assert "se1_p_raw" in result
    assert result["pairwise_comparisons"][0]["p_raw"] is not None
    assert "me1_t_ratio" in result
    assert "se1_t_ratio" in result


def test_lmm_anova_tukey_adjustment_does_not_clip_extreme_p_values():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert float(result["pairwise_comparisons"][0]["p_adjusted"]) < 1e-6
    assert float(result["me1_p"]) < 1e-6


def test_lmm_anova_tukey_matches_raw_p_for_two_level_families():
    payload = _categorical_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="tukey",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    first_pair = result["pairwise_comparisons"][0]
    assert abs(float(first_pair["p_adjusted"]) - float(first_pair["p_raw"])) < 1e-18
    assert abs(float(result["me1_p"]) - float(result["me1_p_raw"])) < 1e-18


def test_build_diagnostics_falls_back_to_fixed_only_residuals_for_singular_random_effect_prediction():
    class _SingularFit:
        def __init__(self):
            self.model = SimpleNamespace(
                exog=np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0]], dtype=float),
                endog=np.array([1.0, 2.0, 3.5], dtype=float),
            )
            self.fe_params = np.array([1.0, 1.1], dtype=float)
            self.cov_re = np.array([[1e-10]], dtype=float)
            self.converged = True

        @property
        def fittedvalues(self):
            raise ValueError("Cannot predict random effects from singular covariance structure.")

        @property
        def resid(self):
            raise AssertionError("resid should not be accessed after fittedvalues fails")

    diagnostics = LMM_ANOVA_MODULE._build_diagnostics(_SingularFit(), 0.05, 0, [])

    assert diagnostics["converged"] is True
    assert diagnostics["singular_fit"] is True
    assert diagnostics["residual_basis"] == "fixed_only_fallback"
    assert diagnostics["residual_normality"]["test"] == "Shapiro-Wilk"
    assert diagnostics["residual_spread"]["test"] == "Spearman(abs(residual), fitted)"
    assert any("fixed-effects-only fitted values" in warning.lower() for warning in diagnostics["warnings"])
    assert any("appears singular" in warning.lower() for warning in diagnostics["warnings"])


def test_build_diagnostics_raises_non_singularity_value_errors():
    class _BadFit:
        @property
        def fittedvalues(self):
            raise ValueError("unexpected fittedvalues failure")

        @property
        def resid(self):
            raise AssertionError("resid should not be accessed after fittedvalues fails")

    try:
        LMM_ANOVA_MODULE._build_diagnostics(_BadFit(), 0.05, 0, [])
    except ValueError as exc:
        assert "unexpected fittedvalues failure" in str(exc)
    else:
        raise AssertionError("Expected unrelated diagnostics failures to continue raising")


def test_build_diagnostics_falls_back_to_fixed_only_residuals_for_singular_linalg_errors():
    class _LinAlgSingularFit:
        def __init__(self):
            self.model = SimpleNamespace(
                exog=np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0]], dtype=float),
                endog=np.array([1.0, 2.0, 3.5], dtype=float),
            )
            self.fe_params = np.array([1.0, 1.1], dtype=float)
            self.cov_re = np.array([[1e-10]], dtype=float)
            self.converged = True

        @property
        def fittedvalues(self):
            raise np.linalg.LinAlgError("random-effects prediction failed: matrix is not positive definite")

        @property
        def resid(self):
            raise AssertionError("resid should not be accessed after fittedvalues fails")

    diagnostics = LMM_ANOVA_MODULE._build_diagnostics(_LinAlgSingularFit(), 0.05, 0, [])

    assert diagnostics["residual_basis"] == "fixed_only_fallback"
    assert any("fixed-effects-only fitted values" in warning.lower() for warning in diagnostics["warnings"])


def test_lmm_anova_survives_singular_random_effect_prediction_and_promotes_warnings(monkeypatch):
    payload = _categorical_payload()
    original_fit_model = LMM_ANOVA_MODULE._fit_model

    class _FitProxy:
        def __init__(self, inner):
            self._inner = inner

        @property
        def fittedvalues(self):
            raise ValueError("Cannot predict random effects from singular covariance structure.")

        @property
        def resid(self):
            raise AssertionError("resid should not be accessed after fittedvalues fails")

        def __getattr__(self, name):
            return getattr(self._inner, name)

    def _fit_with_singular_prediction(*args, **kwargs):
        fit, fit_warnings, optimizer_used = original_fit_model(*args, **kwargs)
        return _FitProxy(fit), fit_warnings, optimizer_used

    monkeypatch.setattr(LMM_ANOVA_MODULE, "_fit_model", _fit_with_singular_prediction)

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
        },
        simple_effects_config=[{"factor": "Treatment", "within": "Day"}],
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
    )

    assert result["success"] is True
    assert "error" not in result
    assert result["diagnostics"]["residual_basis"] == "fixed_only_fallback"
    assert any("fixed-effects-only fitted values" in warning.lower() for warning in result["diagnostics"]["warnings"])
    assert result["warnings"] == result["diagnostics"]["warnings"]


def test_stats_backend_routes_lmm_anova():
    payload = _categorical_payload()
    backend_payload = {
        "test": "lmm_anova",
        "data": payload,
        "parameters": {
            "alpha": 0.05,
            "reml": False,
            "posthoc_adjustment": "tukey",
            "simple_effects": [{"factor": "Treatment", "within": "Day"}],
            "control_levels": {"Treatment": "A"},
            "random_effects_config": {
                "group_var": "Subject",
                "random_intercept": True,
            },
        },
    }

    parsed = _run_backend_payload(backend_payload)
    assert parsed["success"] is True
    assert parsed["results"]["success"] is True
    assert parsed["results"]["test_type"] == "lmm_anova"
    assert parsed["results"]["requested_df_method"] == "satterthwaite"
    assert parsed["results"]["applied_df_method"] == "satterthwaite"


def test_stats_backend_routes_lmm_anova_continuous_effects_config_for_numeric_time_followup():
    payload = _stable_random_slope_payload()
    backend_payload = {
        "test": "lmm_anova",
        "data": payload,
        "parameters": {
            "alpha": 0.05,
            "reml": False,
            "df_method": "satterthwaite",
            "posthoc_adjustment": "holm",
            "simple_effects": [],
            "control_levels": ALL_CATEGORICAL_CONTROLS,
            "random_effects_config": {
                "group_var": "Subject",
                "random_intercept": True,
                "random_slopes": ["Day_num"],
            },
            "continuous_effects_config": {
                "mode": "at_values",
                "group_factor": "Treatment",
                "time_factor": "Day_num",
                "time_values": [0.0, 2.0, 4.0],
            },
        },
    }

    parsed = _run_backend_payload(backend_payload)

    assert parsed["success"] is True
    assert parsed["results"]["success"] is True
    assert parsed["results"]["test_type"] == "lmm_anova"
    assert parsed["results"]["continuous_effects_config"]["mode"] == "at_values"
    assert parsed["results"]["continuous_effects_config"]["time_factor"] == "Day_num"
    assert isinstance(parsed["results"].get("continuous_effects"), list)
    assert parsed["results"]["continuous_effects"]


def test_lmm_anova_gracefully_downgrades_kr_for_random_slope_numeric_time_followup():
    payload = _stable_random_slope_payload()
    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "Subject",
            "random_intercept": True,
            "random_slopes": ["Day_num"],
        },
        posthoc_adjustment="holm",
        control_levels=ALL_CATEGORICAL_CONTROLS,
        posthoc_q=0.05,
        simple_effects_config=[],
        continuous_effects_config={
            "mode": "at_values",
            "group_factor": "Treatment",
            "time_factor": "Day_num",
            "time_values": [0.0, 2.0, 4.0],
        },
        df_method="kenward_roger",
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "kenward_roger"
    assert result["df_method"] == "satterthwaite"
    assert result["applied_df_method"] != "kenward_roger"
    assert any(
        "kenward-roger" in warning.lower() and "fell back" in warning.lower()
        for warning in result.get("warnings", [])
    )


def test_lmm_python_validation_runner_requires_explicit_dunnett_controls(monkeypatch):
    monkeypatch.setenv("ADJUST_METHOD", "dunnett")
    monkeypatch.delenv("CONTROL_LEVEL_TREATMENT", raising=False)
    monkeypatch.delenv("CONTROL_LEVEL_SEX", raising=False)
    monkeypatch.delenv("CONTROL_LEVEL_STRAIN", raising=False)
    monkeypatch.delenv("CONTROL_LEVEL_DAY", raising=False)

    runner = _load_lmm_python_runner()
    rows = _load_rows("dataset_01.csv")

    try:
        runner._prepare_args(rows)
    except ValueError as exc:
        assert "dunnett" in str(exc).lower()
        assert "control" in str(exc).lower()
    else:
        raise AssertionError("Expected explicit Dunnett control validation to fail")


def test_lmm_python_validation_runner_supports_random_slope_configuration(monkeypatch):
    monkeypatch.setenv("PREDICTOR_COLUMNS", "treatment,sex,strain,day_num")
    monkeypatch.setenv("CONTINUOUS_PREDICTORS", "day_num")
    monkeypatch.setenv("RANDOM_SLOPE_PREDICTOR", "day_num")
    monkeypatch.setenv("SIMPLE_EFFECT_FACTOR", "")
    monkeypatch.setenv("SIMPLE_EFFECT_WITHIN", "")

    runner = _load_lmm_python_runner()
    rows = _load_rows("dataset_01.csv")

    args = runner._prepare_args(rows)

    assert args["random_effects_config"]["random_slopes"] == ["Day_num"]


def test_lmm_python_validation_runner_preserves_explicit_dunnett_controls(monkeypatch):
    monkeypatch.setenv("ADJUST_METHOD", "dunnett")
    monkeypatch.setenv("CONTROL_LEVEL_TREATMENT", "A")
    monkeypatch.setenv("CONTROL_LEVEL_SEX", "F")
    monkeypatch.setenv("CONTROL_LEVEL_STRAIN", "B6")
    monkeypatch.setenv("CONTROL_LEVEL_DAY", "D0")

    runner = _load_lmm_python_runner()
    rows = _load_rows("dataset_01.csv")

    args = runner._prepare_args(rows)

    assert args["control_levels"] == {
        "Treatment": "A",
        "Sex": "F",
        "Strain": "B6",
        "Day": "D0",
    }


def test_lmm_python_validation_runner_accepts_uppercase_id_value_columns(monkeypatch):
    monkeypatch.setenv("PREDICTOR_COLUMNS", "Condition,Strain,Sex,Trait,Day")
    monkeypatch.setenv("CONTINUOUS_PREDICTORS", "Day")
    monkeypatch.setenv("RANDOM_SLOPE_PREDICTOR", "Day")
    monkeypatch.setenv("SIMPLE_EFFECT_FACTOR", "")
    monkeypatch.setenv("SIMPLE_EFFECT_WITHIN", "")

    runner = _load_lmm_python_runner()
    rows = _load_rows("Dat_long_cleaned.csv")

    args = runner._prepare_args(rows)

    assert len(args["dependent"]) == len(rows)
    assert len(args["subject"]) == len(rows)
    assert args["random_effects_config"]["random_slopes"] == ["Day"]
    assert set(args["predictors"]) == {"Condition", "Strain", "Sex", "Trait", "Day"}


def test_lmm_validation_adapter_prefers_explicit_fixture_schema_over_inference():
    with tempfile.TemporaryDirectory() as tmpdir:
        csv_path = Path(tmpdir) / "dataset.csv"
        schema_path = csv_path.with_suffix(".schema.json")
        csv_path.write_text(
            "subject,value,dose_code,time_num\n"
            "S1,10.0,0,0\n"
            "S1,11.0,1,1\n"
            "S2,12.0,0,0\n"
            "S2,13.0,1,1\n",
            encoding="utf-8",
        )
        schema_path.write_text(
            json.dumps(
                {
                    "predictor_types": {
                        "dose_code": "categorical",
                        "time_num": "continuous",
                    },
                    "factor_level_labels": {
                        "dose_code": ["0", "1"],
                    },
                }
            ),
            encoding="utf-8",
        )

        data = load_csv(csv_path)
        adapted = adapt_lmm_anova(data)

        assert adapted["predictor_types"]["dose_code"] == "categorical"
        assert adapted["predictor_types"]["time_num"] == "continuous"
        assert adapted["predictors"]["dose_code"] == ["0", "1", "0", "1"]
        assert adapted["factor_level_labels"]["dose_code"] == ["0", "1"]


def test_numeric_time_oracle_uses_selected_value_emmeans_surface():
    module = _load_numeric_time_compare_module()
    summary = module.build_oracle_metadata()

    assert summary["surface"] == "emmeans_at_values"
    assert summary["df_method"] == "satterthwaite"
    assert summary["time_grid"] == [0.0, 2.0, 4.0]
    assert "time_value" in summary["required_row_fields"]
    assert "contrast_variance" in summary["required_row_fields"]
    assert "p_raw" in summary["required_row_fields"]
    assert "trend" not in summary["surface"]


def test_numeric_time_random_intercept_selected_value_validation_emits_dedicated_summary():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(Path(tmpdir), mode="random_intercept")

    assert summary["oracle"]["surface"] == "emmeans_at_values"
    assert summary["oracle"]["random_effects_mode"] == "random_intercept"
    assert summary["matched_rows"] > 0
    assert summary["fallback_row_count"] == 0
    assert summary["max_abs_diff"]["estimate"]["abs_diff"] <= 1e-4
    assert summary["max_abs_diff"]["se"]["abs_diff"] <= 1e-4
    assert summary["max_abs_diff"]["t_ratio"]["abs_diff"] <= 2e-4
    assert summary["max_abs_diff"]["p_raw"]["abs_diff"] <= 1e-2
    assert summary["max_abs_diff"]["df"]["abs_diff"] >= 0.0


def test_numeric_time_random_intercept_selected_value_df_parity_is_close():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(Path(tmpdir), mode="random_intercept")

    assert summary["oracle"]["random_effects_mode"] == "random_intercept"
    assert summary["max_abs_diff"]["df"]["abs_diff"] <= 0.01
    assert summary["stable_slope_rows"]["max_rel_df_diff"] <= 1e-3


def test_random_slope_numeric_time_summary_separates_estimate_se_and_df_drift():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(Path(tmpdir), mode="random_slope")

    assert "max_abs_diff" in summary
    assert "estimate" in summary["max_abs_diff"]
    assert "se" in summary["max_abs_diff"]
    assert "df" in summary["max_abs_diff"]
    assert "t_ratio" in summary["max_abs_diff"]
    assert "p_raw" in summary["max_abs_diff"]
    assert "stable_slope_rows" in summary
    assert "max_rel_df_diff" in summary["stable_slope_rows"]
    assert "perturbation_surface" in summary
    assert "pd_failures" in summary["perturbation_surface"]


def test_targeted_center_scaled_numeric_time_validation_emits_dedicated_summary():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(
            Path(tmpdir),
            mode="random_slope",
            time_transform="center_scale",
            target_stratum={
                "trait": "Center_time(s)",
                "strain": "D2",
                "sex": "F",
            },
        )

    assert summary["oracle"]["time_transform"] == "center_scale"
    assert summary["oracle"]["target_stratum"] == {
        "trait": "Center_time(s)",
        "strain": "D2",
        "sex": "F",
    }
    assert summary["matched_rows"] == 3
    assert summary["stable_rows"] > 0
    assert summary["fallback_row_count"] in {0, 3}
    assert "fallback_reason_counts" in summary
    assert summary["max_abs_diff"]["se"]["abs_diff"] <= 0.01


def test_targeted_center_scaled_numeric_time_validation_exports_python_contrast_vectors():
    with tempfile.TemporaryDirectory() as tmpdir:
        _run_numeric_time_validation(
            Path(tmpdir),
            mode="random_slope",
            time_transform="center_scale",
            target_stratum={
                "trait": "Center_time(s)",
                "strain": "D2",
                "sex": "F",
            },
        )
        rows = list(csv.DictReader((Path(tmpdir) / "py_numeric_time_center_scale_target_contrasts.csv").open()))

    assert rows
    assert all(str(row.get("contrast_vector", "")).strip() for row in rows)


def test_targeted_center_scaled_numeric_time_validation_normalizes_contrast_vector_terms():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(
            Path(tmpdir),
            mode="random_slope",
            time_transform="center_scale",
            target_stratum={
                "trait": "Center_time(s)",
                "strain": "D2",
                "sex": "F",
            },
        )

    assert summary["matched_rows"] == 3
    assert summary["max_abs_diff"]["contrast_vector"]["abs_diff"] == 0.0


def test_targeted_center_scaled_numeric_time_validation_improves_df_parity():
    with tempfile.TemporaryDirectory() as tmpdir:
        summary = _run_numeric_time_validation(
            Path(tmpdir),
            mode="random_slope",
            time_transform="center_scale",
            target_stratum={
                "trait": "Center_time(s)",
                "strain": "D2",
                "sex": "F",
            },
        )

    assert summary["matched_rows"] == 3
    assert summary["max_abs_diff"]["df"]["abs_diff"] <= 0.1
    assert summary["max_abs_diff"]["p_raw"]["abs_diff"] <= 0.005


def _build_random_intercept_numeric_time_target_case() -> dict:
    compare_module = _load_numeric_time_compare_module()
    pheno = compare_module.prep_df(pd.read_csv(compare_module.BASE_DIR / "Pheno_cleaned.csv"))
    subset = pheno[
        (pheno["Trait"] == "Temp_60(°C)")
        & (pheno["Strain"] == "B6")
        & (pheno["Sex"] == "M")
        & (pheno["Day"] >= 0)
    ].copy()
    subset["Day"] = subset["Day"].astype(float)
    subset["Condition"] = subset["Condition"].astype(str)
    assert not subset.empty

    predictors = {
        "Condition": subset["Condition"].tolist(),
        "Day": subset["Day"].tolist(),
    }
    predictor_types = {"Condition": "categorical", "Day": "continuous"}
    factor_level_labels = {
        "Condition": list(dict.fromkeys(predictors["Condition"])),
    }
    predictor_metas = LMM_ANOVA_MODULE._build_predictor_metas(
        predictors,
        predictor_types,
        factor_level_labels,
    )

    model_df = pd.DataFrame(
        {
            "DV": subset["Value"].astype(float).to_numpy(),
            "subject": subset["ID"].astype(str).to_numpy(),
        }
    )
    for meta in predictor_metas:
        values = pd.Series(predictors[meta.original_name], dtype="object")
        if meta.is_categorical:
            model_df[meta.internal_name] = pd.Categorical(values, categories=meta.labels, ordered=True)
        else:
            model_df[meta.internal_name] = pd.to_numeric(values, errors="coerce")
    model_df["group_id"] = model_df["subject"].astype("object")
    clean_df = model_df.dropna().copy()

    fixed_formula = LMM_ANOVA_MODULE._build_fixed_formula(predictor_metas, 2)
    re_formula, slope_metas = LMM_ANOVA_MODULE._build_random_formula(
        {"group_var": "ID", "random_intercept": True, "random_slopes": []},
        predictor_metas,
    )
    fit, _warnings, _optimizer = LMM_ANOVA_MODULE._fit_model(
        clean_df,
        fixed_formula,
        re_formula,
        False,
        clean_df["group_id"],
    )
    assert not slope_metas

    bundle = LMM_ANOVA_MODULE._build_finite_df_inference_bundle(fit)
    fit_for_inference = bundle.get("fit", fit)
    condition_meta = next(meta for meta in predictor_metas if meta.original_name == "Condition")
    day_meta = next(meta for meta in predictor_metas if meta.original_name == "Day")
    level_labels = factor_level_labels["Condition"]
    left_label, right_label = level_labels[:2]
    left_row = {
        "subject": str(clean_df["subject"].iloc[0]),
        condition_meta.internal_name: left_label,
        day_meta.internal_name: 2.0,
    }
    right_row = {
        "subject": str(clean_df["subject"].iloc[0]),
        condition_meta.internal_name: right_label,
        day_meta.internal_name: 2.0,
    }
    x_left = LMM_ANOVA_MODULE._grid_row_to_exog(fit_for_inference, left_row)
    x_right = LMM_ANOVA_MODULE._grid_row_to_exog(fit_for_inference, right_row)
    contrast = x_left - x_right

    return {
        "fit": fit_for_inference,
        "bundle": bundle,
        "contrast": contrast,
        "term_names": list(fit_for_inference.fe_params.index),
        "row_key": "Temp_60(°C)|B6|M|2|VEH - THC",
    }


def _build_random_slope_near_singular_target_case() -> dict:
    compare_module = _load_numeric_time_compare_module()
    pheno = compare_module.prep_df(pd.read_csv(compare_module.BASE_DIR / "Pheno_cleaned.csv"))
    subset = pheno[
        (pheno["Trait"] == "Temp_60(°C)")
        & (pheno["Strain"] == "D2")
        & (pheno["Sex"] == "M")
        & (pheno["Day"] >= 0)
    ].copy()
    subset["Day"] = subset["Day"].astype(float)
    subset["Condition"] = subset["Condition"].astype(str)
    assert not subset.empty

    predictors = {
        "Condition": subset["Condition"].tolist(),
        "Day": subset["Day"].tolist(),
    }
    predictor_types = {"Condition": "categorical", "Day": "continuous"}
    factor_level_labels = {
        "Condition": list(dict.fromkeys(predictors["Condition"])),
    }
    predictor_metas = LMM_ANOVA_MODULE._build_predictor_metas(
        predictors,
        predictor_types,
        factor_level_labels,
    )

    model_df = pd.DataFrame(
        {
            "DV": subset["Value"].astype(float).to_numpy(),
            "subject": subset["ID"].astype(str).to_numpy(),
        }
    )
    for meta in predictor_metas:
        values = pd.Series(predictors[meta.original_name], dtype="object")
        if meta.is_categorical:
            model_df[meta.internal_name] = pd.Categorical(values, categories=meta.labels, ordered=True)
        else:
            model_df[meta.internal_name] = pd.to_numeric(values, errors="coerce")
    model_df["group_id"] = model_df["subject"].astype("object")
    clean_df = model_df.dropna().copy()

    fixed_formula = LMM_ANOVA_MODULE._build_fixed_formula(predictor_metas, 2)
    re_formula, slope_metas = LMM_ANOVA_MODULE._build_random_formula(
        {"group_var": "ID", "random_intercept": True, "random_slopes": ["Day"]},
        predictor_metas,
    )
    fit, fit_warnings, _optimizer = LMM_ANOVA_MODULE._fit_model(
        clean_df,
        fixed_formula,
        re_formula,
        False,
        clean_df["group_id"],
    )
    assert slope_metas
    return {
        "fit": fit,
        "warnings": fit_warnings,
        "row_key": "Temp_60(°C)|D2|M|2|VEH - THC",
    }


def _build_random_slope_near_zero_diagonal_case() -> dict:
    compare_module = _load_numeric_time_compare_module()
    pheno = compare_module.prep_df(pd.read_csv(compare_module.BASE_DIR / "Pheno_cleaned.csv"))
    subset = pheno[
        (pheno["Trait"] == "Tail.Flick.Latency(ms)")
        & (pheno["Strain"] == "B6")
        & (pheno["Sex"] == "F")
        & (pheno["Day"] >= 0)
    ].copy()
    subset["Day"] = subset["Day"].astype(float)
    subset["Condition"] = subset["Condition"].astype(str)
    assert not subset.empty

    predictors = {
        "Condition": subset["Condition"].tolist(),
        "Day": subset["Day"].tolist(),
    }
    predictor_types = {"Condition": "categorical", "Day": "continuous"}
    factor_level_labels = {
        "Condition": list(dict.fromkeys(predictors["Condition"])),
    }
    predictor_metas = LMM_ANOVA_MODULE._build_predictor_metas(
        predictors,
        predictor_types,
        factor_level_labels,
    )

    model_df = pd.DataFrame(
        {
            "DV": subset["Value"].astype(float).to_numpy(),
            "subject": subset["ID"].astype(str).to_numpy(),
        }
    )
    for meta in predictor_metas:
        values = pd.Series(predictors[meta.original_name], dtype="object")
        if meta.is_categorical:
            model_df[meta.internal_name] = pd.Categorical(values, categories=meta.labels, ordered=True)
        else:
            model_df[meta.internal_name] = pd.to_numeric(values, errors="coerce")
    model_df["group_id"] = model_df["subject"].astype("object")
    clean_df = model_df.dropna().copy()

    fixed_formula = LMM_ANOVA_MODULE._build_fixed_formula(predictor_metas, 2)
    re_formula, slope_metas = LMM_ANOVA_MODULE._build_random_formula(
        {"group_var": "ID", "random_intercept": True, "random_slopes": ["Day"]},
        predictor_metas,
    )
    fit, fit_warnings, _optimizer = LMM_ANOVA_MODULE._fit_model(
        clean_df,
        fixed_formula,
        re_formula,
        False,
        clean_df["group_id"],
    )
    assert slope_metas
    return {
        "fit": fit,
        "warnings": fit_warnings,
        "row_key": "Tail.Flick.Latency(ms)|B6|F|0|VEH - THC",
    }


def _center_time_random_slope_payload() -> dict:
    compare_module = _load_numeric_time_compare_module()
    dataset = compare_module.prep_df(pd.read_csv(compare_module.BASE_DIR / "Dat_long_cleaned.csv"))
    subset = dataset[
        (dataset["Trait"] == "Center_time(s)")
        & (dataset["Strain"] == "D2")
        & (dataset["Sex"] == "F")
        & (dataset["Day"] >= 0)
    ].copy()
    assert not subset.empty
    return {
        "dependent": subset["Value"].astype(float).tolist(),
        "subject": subset["ID"].astype(str).tolist(),
        "predictors": {
            "Condition": subset["Condition"].astype(str).tolist(),
            "Day": subset["Day"].astype(float).tolist(),
        },
        "predictor_types": {
            "Condition": "categorical",
            "Day": "continuous",
        },
        "factor_level_labels": {
            "Condition": list(dict.fromkeys(subset["Condition"].astype(str).tolist())),
        },
    }


def test_random_intercept_numeric_time_target_case_exposes_df_diagnostics():
    case = _build_random_intercept_numeric_time_target_case()

    diagnostics = LMM_ANOVA_MODULE._collect_satterthwaite_1d_diagnostics(
        case["contrast"],
        case["bundle"]["cov_beta"],
        case["bundle"]["cov_beta_jacobian"],
        case["bundle"]["theta_cov"],
        theta_names=case["bundle"]["theta_names"],
        contrast_term_names=case["term_names"],
    )

    assert diagnostics["df"] > 0
    assert diagnostics["contrast_variance"] > 0
    assert diagnostics["denominator"] > 0
    assert diagnostics["theta_names"] == case["bundle"]["theta_names"]
    assert diagnostics["contrast_term_names"] == case["term_names"]
    assert any(name.endswith(":Day") for name in diagnostics["contrast_vector_by_term"])
    assert set(diagnostics["variance_gradient_by_theta"]) == set(case["bundle"]["theta_names"])


def test_random_slope_near_singular_target_case_still_builds_varpar_spec():
    case = _build_random_slope_near_singular_target_case()

    spec = importlib.import_module("python_embedded.statistics_module.lmm_parameterization").extract_finite_df_varpar_spec(
        case["fit"]
    )

    assert case["row_key"] == "Temp_60(°C)|D2|M|2|VEH - THC"
    assert spec.theta.shape == (4,)
    assert np.all(np.isfinite(spec.theta))
    assert np.all(np.isfinite(spec.covariance))
    assert np.min(np.linalg.eigvalsh(spec.covariance)) >= -1e-8


def test_random_slope_near_singular_target_case_rejects_unstable_finite_df_bundle():
    case = _build_random_slope_near_singular_target_case()

    with __import__("pytest").raises(ValueError, match="non-positive eigenvalues|does not reproduce fitted fixed-effect covariance"):
        LMM_ANOVA_MODULE._build_finite_df_inference_bundle(case["fit"])


def test_random_slope_near_zero_diagonal_case_uses_noncollapsed_jacobian_slice():
    case = _build_random_slope_near_zero_diagonal_case()
    parameterization = importlib.import_module("python_embedded.statistics_module.lmm_parameterization")
    inference = importlib.import_module("python_embedded.statistics_module.lmm_inference_satterthwaite")

    spec = parameterization.extract_finite_df_varpar_spec(case["fit"])
    theta = np.asarray(spec.theta, dtype=float)
    base = parameterization.cov_beta_from_finite_df_varpar(case["fit"], theta)
    steps = inference.finite_difference_step_sizes(theta)
    plus = theta.copy()
    plus[2] += steps[2]
    plus_cov = parameterization.cov_beta_from_finite_df_varpar(case["fit"], plus)
    plus_only_norm = float(np.linalg.norm((plus_cov - base) / steps[2]))

    jacobian = inference.numerical_cov_beta_jacobian(
        case["fit"],
        theta,
        evaluator=parameterization.cov_beta_from_finite_df_varpar,
    )

    assert case["row_key"] == "Tail.Flick.Latency(ms)|B6|F|0|VEH - THC"
    assert abs(theta[2]) < steps[2]
    assert float(np.linalg.norm(jacobian[2])) >= plus_only_norm * 0.5


def test_random_slope_near_zero_diagonal_case_rejects_indefinite_hessian_bundle():
    case = _build_random_slope_near_zero_diagonal_case()

    with __import__("pytest").raises(ValueError, match="non-positive eigenvalues"):
        LMM_ANOVA_MODULE._build_finite_df_inference_bundle(case["fit"])


def test_lmm_anova_falls_back_when_real_random_slope_fit_has_boundary_and_hessian_warnings():
    compare_module = _load_numeric_time_compare_module()
    pheno = compare_module.prep_df(pd.read_csv(compare_module.BASE_DIR / "Pheno_cleaned.csv"))
    subset = pheno[
        (pheno["Trait"] == "Temp_30(°C)")
        & (pheno["Strain"] == "B6")
        & (pheno["Sex"] == "M")
        & (pheno["Day"] >= 0)
    ].copy()
    assert not subset.empty

    predictors = {
        "Condition": subset["Condition"].astype(str).tolist(),
        "Day": subset["Day"].astype(float).tolist(),
    }
    factor_level_labels = {
        "Condition": list(dict.fromkeys(predictors["Condition"])),
    }

    result = lmm_anova(
        subset["Value"].astype(float).tolist(),
        subset["ID"].astype(str).tolist(),
        predictors,
        predictor_types={"Condition": "categorical", "Day": "continuous"},
        factor_level_labels=factor_level_labels,
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "ID",
            "random_intercept": True,
            "random_slopes": ["Day"],
        },
        posthoc_adjustment="tukey",
        df_method="satterthwaite",
        simple_effects_config=[],
        continuous_effects_config={
            "mode": "at_values",
            "group_factor": "Condition",
            "time_factor": "Day",
            "time_values": [0.0, 2.0, 4.0],
        },
    )

    target_row = next(
        row
        for row in result["pairwise_comparisons"]
        if row.get("time_factor") == "Day"
        and float(row.get("time_value")) == 0.0
        and row.get("group1") == "VEH"
        and row.get("group2") == "THC"
    )

    assert result["success"] is True
    assert result["requested_df_method"] == "satterthwaite"
    assert result["applied_df_method"] == "asymptotic"
    assert result["finite_df_applied"] is False
    assert result["finite_df_fallback_reason"] is not None
    assert "boundary" in result["finite_df_fallback_reason"].lower()
    assert target_row["inference"] == "asymptotic_z"
    assert target_row["df"] is None


def test_lmm_anova_center_scales_targeted_random_slope_numeric_time_before_warning_gate():
    payload = _center_time_random_slope_payload()

    result = lmm_anova(
        payload["dependent"],
        payload["subject"],
        payload["predictors"],
        predictor_types=payload["predictor_types"],
        factor_level_labels=payload["factor_level_labels"],
        alpha=0.05,
        reml=False,
        random_effects_config={
            "group_var": "ID",
            "random_intercept": True,
            "random_slopes": ["Day"],
        },
        posthoc_adjustment="tukey",
        df_method="satterthwaite",
        simple_effects_config=[],
        continuous_effects_config={
            "mode": "at_values",
            "group_factor": "Condition",
            "time_factor": "Day",
            "time_values": [0.0, 2.0, 4.0],
            "time_transform": "center_scale",
        },
    )

    assert result["success"] is True
    assert result["finite_df_requested"] is True
    assert result["continuous_effects_transform"]["mode"] == "center_scale"
    assert result["continuous_effects_transform"]["time_factor"] == "Day"
    assert result["continuous_effects_transform"]["applied"] is True
    assert result["continuous_effects_transform"]["display_time_values"] == [0.0, 2.0, 4.0]
    if result["finite_df_fallback_reason"] is not None:
        assert "singular" not in result["finite_df_fallback_reason"].lower()


def test_contrast_payload_marks_row_level_fallback_when_satterthwaite_df_is_not_finite(monkeypatch):
    monkeypatch.setattr(LMM_ANOVA_MODULE, "satterthwaite_df_1d", lambda *args, **kwargs: float("inf"))

    comparison = LMM_ANOVA_MODULE._contrast_payload(
        fe_params=np.array([1.0, 0.5], dtype=float),
        cov_fe=np.eye(2, dtype=float),
        x_left=np.array([1.0, 0.0], dtype=float),
        x_right=np.array([0.0, 1.0], dtype=float),
        left_label="A",
        right_label="B",
        alpha=0.05,
        df_approx=float("inf"),
        phase1a_inference={
            "method": "satterthwaite",
            "cov_beta_jacobian": np.zeros((1, 2, 2), dtype=float),
            "theta_cov": np.eye(1, dtype=float),
        },
    )

    entry = LMM_ANOVA_MODULE._format_pairwise_entry(comparison, threshold=0.05)

    assert entry["df"] is None
    assert entry["inference"] == "asymptotic_z"
    assert "df_fallback_reason" in entry
    assert "satterthwaite" in entry["df_fallback_reason"].lower()
