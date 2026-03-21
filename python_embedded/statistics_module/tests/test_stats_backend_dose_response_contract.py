import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
STATS_BACKEND = REPO_ROOT / "python_embedded" / "stats_backend.py"
STATS_BACKEND_EXE = REPO_ROOT / "python_embedded" / "dist" / "stats_backend.dist" / "stats_backend.exe"
EMBEDDED_PYTHON = REPO_ROOT / "python_embedded" / "python.exe"


# Reproduction class: numerically unstable fit can emit NaN uncertainty fields.
UNSTABLE_3PL_DATA = {
    "doses": [
        9.37085603462e-09,
        1.34264426066e-06,
        0.000362999619302,
        0.101166400943,
        18.3565091363,
        4527.74567083,
        583029.194857,
        325536266.987,
    ],
    "responses": [
        68.5658273409,
        68.5658273748,
        68.5658273967,
        68.5658273085,
        68.5658274684,
        68.5658274594,
        68.5658274019,
        68.5658273659,
    ],
}

UNSTABLE_4PL_DATA = {
    "doses": [
        1.03613961143e-08,
        2.10914713127e-06,
        0.000355882662614,
        0.0645805149553,
        8.40888266669,
        3197.56833564,
        501048.25619,
        151828297.223,
    ],
    "responses": [
        136.590685959,
        -147.555743061,
        -76.5065370809,
        -14.8014423382,
        96.7388802734,
        -5.66990851644,
        -145.249552481,
        -62.5853881183,
    ],
}

STABLE_4PL_DATA = {
    "doses": [0.001, 0.001, 0.001, 0.01, 0.01, 0.01, 0.1, 0.1, 0.1, 1.0, 1.0, 1.0, 10.0, 10.0, 10.0, 100.0, 100.0],
    "responses": [2.5, 3.1, 2.8, 8.5, 9.2, 7.8, 32.5, 35.2, 30.8, 65.2, 68.5, 62.1, 88.5, 91.2, 86.8, 96.5, 98.2],
}

COMPARE_ZERO_DOSE_DATA = {
    "doses": [0.0, 0.0, 0.01, 0.01, 0.1, 0.1, 1.0, 1.0, 10.0, 10.0],
    "responses": [2.3, 2.7, 8.4, 9.1, 31.0, 33.8, 63.2, 66.1, 89.0, 90.7],
}

# Regression guard: few unique doses but enough positive observations should not
# be hard-rejected as "data unsuitable" for 3PL/4PL.
REPLICATE_HEAVY_3PL_DATA = {
    "doses": [0.1, 0.1, 0.1, 1.0, 1.0, 1.0, 10.0, 10.0, 10.0],
    "responses": [5.0, 4.8, 5.2, 21.0, 20.5, 21.4, 78.5, 79.2, 80.1],
}

INSUFFICIENT_5PL_DATA = {
    "doses": [0.0, 0.0, 0.1, 0.2, 1.0, 2.0, 10.0],
    "responses": [1.1, 1.2, 8.3, 12.4, 44.1, 58.7, 89.5],
}


def _strict_json_loads(text: str) -> dict:
    def _reject_nonfinite(token: str):
        raise ValueError(f"non-finite token in JSON payload: {token}")

    return json.loads(text, parse_constant=_reject_nonfinite)


def _backend_mode() -> str:
    mode = os.environ.get("EASYCRIS_STATS_BACKEND_CONTRACT_MODE", "script").strip().lower()
    if mode not in {"script", "exe"}:
        raise ValueError(
            "EASYCRIS_STATS_BACKEND_CONTRACT_MODE must be 'script' or 'exe', "
            f"got: {mode!r}"
        )
    return mode


def _run_backend_payload(payload: dict) -> tuple[str, str]:
    mode = _backend_mode()
    if mode == "exe":
        if not STATS_BACKEND_EXE.exists():
            raise RuntimeError(f"Compiled stats backend not found: {STATS_BACKEND_EXE}")
        args = [str(STATS_BACKEND_EXE)]
        cwd = str(STATS_BACKEND_EXE.parent)
    else:
        if not EMBEDDED_PYTHON.exists():
            raise RuntimeError(f"Embedded Python not found: {EMBEDDED_PYTHON}")
        if not STATS_BACKEND.exists():
            raise RuntimeError(f"Stats backend script not found: {STATS_BACKEND}")
        args = [str(EMBEDDED_PYTHON), str(STATS_BACKEND)]
        cwd = str(REPO_ROOT)

    result = subprocess.run(
        args,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=cwd,
        timeout=60,
        check=False,
    )
    return result.stdout, result.stderr


def _run_backend(test_name: str, doses: list[float], responses: list[float]) -> tuple[str, str]:
    payload = {
        "test": test_name,
        "data": {
            "doses": doses,
            "responses": responses,
            "fitting_method": "log_dose",
        },
        "parameters": {"alpha": 0.05},
    }
    return _run_backend_payload(payload)


def _create_temp_duckdb_with_dose_response_rows(doses: list[float], responses: list[float]) -> Path:
    if len(doses) != len(responses):
        raise ValueError("doses and responses must have the same length")
    duckdb = pytest.importorskip("duckdb")
    db_path = Path(tempfile.gettempdir()) / f"easycris_contract_{uuid.uuid4().hex}.duckdb"
    conn = duckdb.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE data (dose DOUBLE, response DOUBLE)")
        conn.executemany(
            "INSERT INTO data (dose, response) VALUES (?, ?)",
            list(zip(doses, responses)),
        )
    finally:
        conn.close()
    return db_path


def _run_backend_via_preprocess_path(test_name: str, doses: list[float], responses: list[float]) -> dict:
    db_path = _create_temp_duckdb_with_dose_response_rows(doses, responses)
    try:
        payload = {
            "test": test_name,
            "data": {},
            "parameters": {
                "alpha": 0.05,
                "duckdb_path": str(db_path),
                "analysis_mode": "large",
                "execution_mode": "exact",
                "column_ids": ["dose", "response"],
                "column_names": ["dose", "response"],
                "column_types": ["numeric", "numeric"],
            },
        }
        stdout, _ = _run_backend_payload(payload)
        return _strict_json_loads(stdout)
    finally:
        db_path.unlink(missing_ok=True)


def test_3pl_backend_output_is_strict_json_even_for_unstable_data():
    stdout, stderr = _run_backend(
        "dose_response_3pl",
        UNSTABLE_3PL_DATA["doses"],
        UNSTABLE_3PL_DATA["responses"],
    )
    assert stderr is not None  # keep stderr available for debug if assertion fails
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") in (True, False)


def test_4pl_backend_output_is_strict_json_even_for_unstable_data():
    stdout, stderr = _run_backend(
        "dose_response_4pl",
        UNSTABLE_4PL_DATA["doses"],
        UNSTABLE_4PL_DATA["responses"],
    )
    assert stderr is not None
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") in (True, False)


def test_4pl_backend_output_is_strict_json_for_stable_data():
    stdout, _ = _run_backend(
        "dose_response_4pl",
        STABLE_4PL_DATA["doses"],
        STABLE_4PL_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") is True


def test_3pl_backend_output_is_strict_json_for_stable_data():
    stdout, _ = _run_backend(
        "dose_response_3pl",
        STABLE_4PL_DATA["doses"],
        STABLE_4PL_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") is True


def test_compare_backend_output_is_strict_json_for_stable_data():
    stdout, _ = _run_backend(
        "dose_response_compare",
        STABLE_4PL_DATA["doses"],
        STABLE_4PL_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") is True


def test_compare_zero_dose_is_classified_as_data_unsuitable():
    stdout, _ = _run_backend(
        "dose_response_compare",
        COMPARE_ZERO_DOSE_DATA["doses"],
        COMPARE_ZERO_DOSE_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") is False
    assert parsed.get("error_type") == "DoseResponseDataUnsuitable"


def test_replicate_heavy_3pl_not_rejected_as_data_unsuitable():
    stdout, _ = _run_backend(
        "dose_response_3pl",
        REPLICATE_HEAVY_3PL_DATA["doses"],
        REPLICATE_HEAVY_3PL_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    if parsed.get("success") is False:
        assert parsed.get("error_type") != "DoseResponseDataUnsuitable"


def test_5pl_insufficient_positive_observations_is_not_misclassified_as_success():
    stdout, _ = _run_backend(
        "dose_response_5pl",
        INSUFFICIENT_5PL_DATA["doses"],
        INSUFFICIENT_5PL_DATA["responses"],
    )
    parsed = _strict_json_loads(stdout)
    assert parsed.get("success") is False
    assert parsed.get("error_type") == "DoseResponseDataUnsuitable"


def test_preprocess_path_3pl_uses_three_positive_observation_threshold():
    parsed = _run_backend_via_preprocess_path(
        "dose_response_3pl",
        [0.0, 0.0, 0.1, 1.0, 10.0],
        [1.5, 1.7, 8.2, 35.1, 82.4],
    )
    # Preprocess threshold drift would return a plain {"success": false, "error": "..."}
    # without error_type. Execute-path failures are structured with error_type.
    assert parsed.get("error_type") is not None or parsed.get("success") is True


def test_preprocess_path_5pl_uses_six_positive_observation_threshold():
    parsed = _run_backend_via_preprocess_path(
        "dose_response_5pl",
        [0.0, 0.0, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0],
        [1.1, 1.0, 6.5, 12.8, 39.2, 63.7, 85.4, 93.1],
    )
    assert parsed.get("error_type") is not None or parsed.get("success") is True
