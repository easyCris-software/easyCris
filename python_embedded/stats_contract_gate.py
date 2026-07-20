#!/usr/bin/env python3
"""
Standalone strict-JSON contract gate for stats.

Runs without pytest so release compile flows can validate backend output
contracts without introducing pytest as a runtime/build dependency.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import uuid
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
STATS_BACKEND = REPO_ROOT / "python_embedded" / "stats.py"
STATS_BACKEND_EXE = REPO_ROOT / "python_embedded" / "dist" / "stats.dist" / "stats.exe"
EMBEDDED_PYTHON = REPO_ROOT / "python_embedded" / "python.exe"


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

INSUFFICIENT_5PL_DATA = {
    "doses": [0.0, 0.0, 0.1, 0.2, 1.0, 2.0, 10.0],
    "responses": [1.1, 1.2, 8.3, 12.4, 44.1, 58.7, 89.5],
}


def _strict_json_loads(text: str) -> dict:
    def _reject_nonfinite(token: str):
        raise ValueError(f"non-finite token in JSON payload: {token}")

    return json.loads(text, parse_constant=_reject_nonfinite)


def _run_backend_payload(payload: dict, mode: str) -> tuple[str, str]:
    if mode == "exe":
        if not STATS_BACKEND_EXE.exists():
            raise RuntimeError(f"Compiled stats backend not found: {STATS_BACKEND_EXE}")
        args = [str(STATS_BACKEND_EXE)]
        cwd = str(STATS_BACKEND_EXE.parent)
    elif mode == "script":
        if not EMBEDDED_PYTHON.exists():
            raise RuntimeError(f"Embedded Python not found: {EMBEDDED_PYTHON}")
        if not STATS_BACKEND.exists():
            raise RuntimeError(f"Stats backend script not found: {STATS_BACKEND}")
        args = [str(EMBEDDED_PYTHON), str(STATS_BACKEND)]
        cwd = str(REPO_ROOT)
    else:
        raise ValueError(f"Unsupported mode: {mode}")

    result = subprocess.run(
        args,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=cwd,
        timeout=90,
        check=False,
    )
    return result.stdout, result.stderr


def _run_backend(test_name: str, doses: list[float], responses: list[float], mode: str) -> dict:
    payload = {
        "test": test_name,
        "data": {
            "doses": doses,
            "responses": responses,
            "fitting_method": "log_dose",
        },
        "parameters": {"alpha": 0.05},
    }
    stdout, stderr = _run_backend_payload(payload, mode)
    try:
        return _strict_json_loads(stdout)
    except Exception as exc:
        preview = stdout[:400].replace("\n", "\\n")
        raise RuntimeError(f"{test_name} produced invalid strict JSON: {exc}. stdout={preview}") from exc


def _create_temp_duckdb_with_dose_response_rows(doses: list[float], responses: list[float]) -> Path:
    if len(doses) != len(responses):
        raise ValueError("doses and responses must have the same length")
    try:
        import duckdb
    except ImportError as exc:
        raise RuntimeError("duckdb is required for preprocess contract checks") from exc

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


def _run_backend_via_preprocess_path(test_name: str, doses: list[float], responses: list[float], mode: str) -> dict:
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
        stdout, _ = _run_backend_payload(payload, mode)
        return _strict_json_loads(stdout)
    finally:
        db_path.unlink(missing_ok=True)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run_contract_suite(mode: str) -> None:
    parsed_3pl = _run_backend("dose_response_3pl", UNSTABLE_3PL_DATA["doses"], UNSTABLE_3PL_DATA["responses"], mode)
    _assert(parsed_3pl.get("success") in (True, False), "3PL unstable strict JSON check failed")

    parsed_4pl = _run_backend("dose_response_4pl", UNSTABLE_4PL_DATA["doses"], UNSTABLE_4PL_DATA["responses"], mode)
    _assert(parsed_4pl.get("success") in (True, False), "4PL unstable strict JSON check failed")

    parsed_4pl_stable = _run_backend("dose_response_4pl", STABLE_4PL_DATA["doses"], STABLE_4PL_DATA["responses"], mode)
    _assert(parsed_4pl_stable.get("success") is True, "4PL stable run failed")

    parsed_3pl_stable = _run_backend("dose_response_3pl", STABLE_4PL_DATA["doses"], STABLE_4PL_DATA["responses"], mode)
    _assert(parsed_3pl_stable.get("success") is True, "3PL stable run failed")

    parsed_compare = _run_backend("dose_response_compare", STABLE_4PL_DATA["doses"], STABLE_4PL_DATA["responses"], mode)
    _assert(parsed_compare.get("success") is True, "compare stable run failed")

    parsed_compare_zero = _run_backend(
        "dose_response_compare",
        COMPARE_ZERO_DOSE_DATA["doses"],
        COMPARE_ZERO_DOSE_DATA["responses"],
        mode,
    )
    _assert(parsed_compare_zero.get("success") is False, "compare zero-dose should fail")
    _assert(
        parsed_compare_zero.get("error_type") == "DoseResponseDataUnsuitable",
        "compare zero-dose should classify as DoseResponseDataUnsuitable",
    )

    parsed_5pl_insufficient = _run_backend(
        "dose_response_5pl",
        INSUFFICIENT_5PL_DATA["doses"],
        INSUFFICIENT_5PL_DATA["responses"],
        mode,
    )
    _assert(parsed_5pl_insufficient.get("success") is False, "5PL insufficient should fail")
    _assert(
        parsed_5pl_insufficient.get("error_type") == "DoseResponseDataUnsuitable",
        "5PL insufficient should classify as DoseResponseDataUnsuitable",
    )

    parsed_pre_3pl = _run_backend_via_preprocess_path(
        "dose_response_3pl",
        [0.0, 0.0, 0.1, 1.0, 10.0],
        [1.5, 1.7, 8.2, 35.1, 82.4],
        mode,
    )
    _assert(
        parsed_pre_3pl.get("error_type") is not None or parsed_pre_3pl.get("success") is True,
        "preprocess path 3PL threshold drift detected",
    )

    parsed_pre_5pl = _run_backend_via_preprocess_path(
        "dose_response_5pl",
        [0.0, 0.0, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0],
        [1.1, 1.0, 6.5, 12.8, 39.2, 63.7, 85.4, 93.1],
        mode,
    )
    _assert(
        parsed_pre_5pl.get("error_type") is not None or parsed_pre_5pl.get("success") is True,
        "preprocess path 5PL threshold drift detected",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Stats backend strict JSON contract gate")
    parser.add_argument("--mode", choices=("script", "exe"), required=True)
    args = parser.parse_args()

    print(f"[stats-contract-gate] Running in {args.mode} mode")
    run_contract_suite(args.mode)
    print("[stats-contract-gate] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

