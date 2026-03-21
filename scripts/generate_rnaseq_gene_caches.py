#!/usr/bin/env python3
"""
Generate bundled offline RNA-seq gene annotation caches.

Builds cache files for:
- human, mouse
- ensembl, entrez, uniprot, uniprot_swissprot

Output folder:
  python_embedded/rnaseq_module/gene_cache
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PY_DEPENDENCIES = ROOT / "python_embedded" / "python_dependencies"
GENE_CACHE_DIR = ROOT / "python_embedded" / "rnaseq_module" / "gene_cache"
META_PATH = GENE_CACHE_DIR / "gene_cache_meta.json"

ORGANISMS = {
    "human": "human",
    "mouse": "mouse",
}

SUPPORTED_TYPES = ("ensembl", "entrez", "uniprot", "uniprot_swissprot")


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")


def _valid_symbol(value: Any) -> bool:
    if value is None:
        return False
    s = str(value).strip()
    return bool(s) and s.lower() != "nan"


def _cache_path(organism: str, gene_id_type: str) -> Path:
    return GENE_CACHE_DIR / f"gene_symbols_{organism}_{gene_id_type}.json"


def _legacy_cache_path(organism: str) -> Path:
    return GENE_CACHE_DIR / f"gene_symbols_{organism}.json"


def _load_ensembl_seed_map(organism: str) -> dict[str, str]:
    primary = _cache_path(organism, "ensembl")
    data = _load_json(primary)
    if data:
        return {str(k): str(v) for k, v in data.items()}
    legacy = _legacy_cache_path(organism)
    data = _load_json(legacy)
    return {str(k): str(v) for k, v in data.items()}


def _clean_ensembl_id(raw_id: str) -> str:
    token = str(raw_id).strip()
    if token.startswith("ENS"):
        return token.split(".", 1)[0]
    return token


def _extract_ensembl_ids(seed_map: dict[str, str]) -> list[str]:
    ids: set[str] = set()
    for key in seed_map.keys():
        cleaned = _clean_ensembl_id(key)
        if cleaned.startswith("ENS"):
            ids.add(cleaned)
    return sorted(ids)


def _extract_ensembl_ids_from_hit(hit: dict[str, Any]) -> list[str]:
    values: list[str] = []
    ensembl_field = hit.get("ensembl")
    if isinstance(ensembl_field, dict):
        values.extend(_collect_values(ensembl_field.get("gene")))
        if not values:
            values.extend(_collect_values(ensembl_field))
    else:
        values.extend(_collect_values(ensembl_field))
    values.extend(_collect_values(hit.get("ensembl.gene")))

    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        cleaned = _clean_ensembl_id(raw)
        if not cleaned.startswith("ENS") or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def _extract_symbols(seed_map: dict[str, str]) -> list[str]:
    symbols: set[str] = set()
    for value in seed_map.values():
        if not _valid_symbol(value):
            continue
        symbol = str(value).strip()
        # Skip unresolved placeholders and non-symbol tokens.
        if symbol.startswith("ENS"):
            continue
        if symbol.isdigit():
            continue
        symbols.add(symbol)
    return sorted(symbols)


def _collect_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        v = value.strip()
        return [v] if v else []
    if isinstance(value, (list, tuple, set)):
        out: list[str] = []
        for item in value:
            out.extend(_collect_values(item))
        return out
    if isinstance(value, dict):
        out: list[str] = []
        for item in value.values():
            out.extend(_collect_values(item))
        return out
    v = str(value).strip()
    return [v] if v else []


def _extract_uniprot_ids(hit: dict[str, Any], swiss_only: bool) -> list[str]:
    ids: list[str] = []
    uniprot_field = hit.get("uniprot")
    if isinstance(uniprot_field, dict):
        ids.extend(_collect_values(uniprot_field.get("Swiss-Prot")))
        if not swiss_only:
            ids.extend(_collect_values(uniprot_field.get("TrEMBL")))
    elif not swiss_only:
        ids.extend(_collect_values(uniprot_field))

    # Fallback flattened keys from API responses.
    ids.extend(_collect_values(hit.get("uniprot.Swiss-Prot")))
    if not swiss_only:
        ids.extend(_collect_values(hit.get("uniprot.TrEMBL")))

    deduped: list[str] = []
    seen: set[str] = set()
    for item in ids:
        token = item.strip()
        if not token or token in seen:
            continue
        seen.add(token)
        deduped.append(token)
    return deduped


def _extract_ids_for_type(hit: dict[str, Any], gene_id_type: str) -> list[str]:
    if gene_id_type == "entrez":
        return _collect_values(hit.get("entrezgene"))
    if gene_id_type == "uniprot":
        return _extract_uniprot_ids(hit, swiss_only=False)
    if gene_id_type == "uniprot_swissprot":
        return _extract_uniprot_ids(hit, swiss_only=True)
    return []


def _query_type_map(
    mg: Any,
    *,
    organism: str,
    symbols: list[str],
    gene_id_type: str,
    batch_size: int,
    delay_secs: float,
) -> dict[str, str]:
    species = ORGANISMS[organism]
    output: dict[str, str] = {}
    total = len(symbols)
    fields = "symbol,entrezgene,uniprot,uniprot.Swiss-Prot,uniprot.TrEMBL"

    for offset in range(0, total, batch_size):
        batch = symbols[offset : offset + batch_size]
        response = mg.querymany(
            batch,
            scopes="symbol",
            species=species,
            fields=fields,
            as_dataframe=False,
            returnall=True,
            verbose=False,
        )
        hits = response.get("out", []) if isinstance(response, dict) else []
        for hit in hits:
            if not isinstance(hit, dict) or hit.get("notfound"):
                continue
            symbol = hit.get("symbol") or hit.get("query")
            if not _valid_symbol(symbol):
                continue
            symbol_text = str(symbol).strip()
            for gid in _extract_ids_for_type(hit, gene_id_type):
                key = str(gid).strip()
                if key and key not in output:
                    output[key] = symbol_text
        if delay_secs > 0 and offset + batch_size < total:
            time.sleep(delay_secs)

    return dict(sorted(output.items()))


def _query_ensembl_symbol_map(
    mg: Any,
    *,
    organism: str,
    ensembl_ids: list[str],
    batch_size: int,
    delay_secs: float,
) -> dict[str, str]:
    species = ORGANISMS[organism]
    output: dict[str, str] = {}
    total = len(ensembl_ids)
    for offset in range(0, total, batch_size):
        batch = ensembl_ids[offset : offset + batch_size]
        response = mg.querymany(
            batch,
            scopes="ensembl.gene",
            species=species,
            fields="symbol,ensembl.gene",
            as_dataframe=False,
            returnall=True,
            verbose=False,
        )
        hits = response.get("out", []) if isinstance(response, dict) else []
        for hit in hits:
            if not isinstance(hit, dict) or hit.get("notfound"):
                continue
            query_id = _clean_ensembl_id(hit.get("query", ""))
            symbol = hit.get("symbol")
            if query_id.startswith("ENS") and _valid_symbol(symbol):
                output[query_id] = str(symbol).strip()

        if delay_secs > 0 and offset + batch_size < total:
            time.sleep(delay_secs)

    # Preserve unresolved IDs as identity mapping for deterministic fallback.
    for eid in ensembl_ids:
        output.setdefault(eid, eid)
    return dict(sorted(output.items()))


def _bootstrap_ensembl_seed_map(
    mg: Any,
    *,
    organism: str,
) -> dict[str, str]:
    species = ORGANISMS[organism]
    output: dict[str, str] = {}
    iterator = mg.query(
        "*",
        species=species,
        fields="symbol,ensembl,ensembl.gene",
        fetch_all=True,
        verbose=False,
    )
    scanned = 0
    for hit in iterator:
        if not isinstance(hit, dict):
            continue
        scanned += 1
        symbol = hit.get("symbol")
        if not _valid_symbol(symbol):
            continue
        symbol_text = str(symbol).strip()
        for ensembl_id in _extract_ensembl_ids_from_hit(hit):
            output.setdefault(ensembl_id, symbol_text)

    return dict(sorted(output.items()))


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "unknown":
        return None
    return text


def _get_mygene_source_metadata(
    mg: Any, explicit_ensembl_version: str | None
) -> dict[str, Any]:
    meta = {}
    try:
        meta = mg.metadata() or {}
    except Exception:
        meta = {}

    source = meta.get("src") if isinstance(meta, dict) else {}
    ensembl = source.get("ensembl") if isinstance(source, dict) else {}
    entrez = source.get("entrez") if isinstance(source, dict) else {}
    uniprot = source.get("uniprot") if isinstance(source, dict) else {}
    ensembl_version = _normalize_optional_text(
        explicit_ensembl_version if explicit_ensembl_version else ensembl.get("version")
    )

    build_version = _normalize_optional_text(meta.get("build_version"))
    source_versions = {
        "ensembl": ensembl_version,
        "entrez": _normalize_optional_text(entrez.get("version")),
        "uniprot": _normalize_optional_text(uniprot.get("version")),
    }
    source_download_dates = {
        "ensembl": _normalize_optional_text(ensembl.get("download_date")),
        "entrez": _normalize_optional_text(entrez.get("download_date")),
        "uniprot": _normalize_optional_text(uniprot.get("download_date")),
    }
    return {
        "ensembl_version": ensembl_version,
        "mygene_build_version": build_version,
        "ensembl_download_date": source_download_dates["ensembl"],
        "source_versions": source_versions,
        "source_download_dates": source_download_dates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate offline RNA-seq gene cache bundles.")
    parser.add_argument(
        "--organisms",
        default="human,mouse",
        help="Comma-separated organisms: human,mouse",
    )
    parser.add_argument(
        "--types",
        default="ensembl,entrez,uniprot,uniprot_swissprot",
        help="Comma-separated id types: ensembl,entrez,uniprot,uniprot_swissprot",
    )
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--delay-secs", type=float, default=0.05)
    parser.add_argument(
        "--ensembl-version",
        default="",
        help="Optional override for metadata stamping (example: 115).",
    )
    args = parser.parse_args()

    selected_organisms = [o.strip().lower() for o in args.organisms.split(",") if o.strip()]
    selected_types = [t.strip().lower() for t in args.types.split(",") if t.strip()]

    invalid_orgs = [o for o in selected_organisms if o not in ORGANISMS]
    invalid_types = [t for t in selected_types if t not in SUPPORTED_TYPES]
    if invalid_orgs or invalid_types:
        if invalid_orgs:
            print(f"[gene-cache] Invalid organisms: {', '.join(invalid_orgs)}", file=sys.stderr)
        if invalid_types:
            print(f"[gene-cache] Invalid gene id types: {', '.join(invalid_types)}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(PY_DEPENDENCIES))
    try:
        import mygene  # type: ignore
    except Exception as exc:
        print(f"[gene-cache] mygene import failed from python_dependencies: {exc}", file=sys.stderr)
        return 1

    mg = mygene.MyGeneInfo()
    mg.use_https()

    meta = _load_json(META_PATH)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    source_meta = _get_mygene_source_metadata(mg, args.ensembl_version)
    meta["gene_cache_last_refresh_utc"] = now
    meta["gene_cache_source"] = "mygene.info"
    if source_meta.get("mygene_build_version"):
        meta["gene_cache_mygene_build_version"] = source_meta["mygene_build_version"]
    else:
        meta.pop("gene_cache_mygene_build_version", None)
    if source_meta.get("ensembl_version"):
        meta["gene_cache_ensembl_version"] = source_meta["ensembl_version"]
    else:
        meta.pop("gene_cache_ensembl_version", None)
    if source_meta.get("ensembl_download_date"):
        meta["gene_cache_ensembl_download_date"] = source_meta["ensembl_download_date"]
    else:
        meta.pop("gene_cache_ensembl_download_date", None)
    source_versions = source_meta["source_versions"]
    source_download_dates = source_meta["source_download_dates"]
    if isinstance(source_versions, dict):
        for source_name, source_version in source_versions.items():
            key = f"gene_cache_{source_name}_version"
            if source_version:
                meta[key] = str(source_version)
            else:
                meta.pop(key, None)
    if isinstance(source_download_dates, dict):
        for source_name, source_download_date in source_download_dates.items():
            key = f"gene_cache_{source_name}_download_date"
            if source_download_date:
                meta[key] = str(source_download_date)
            else:
                meta.pop(key, None)

    for organism in selected_organisms:
        seed_map = _load_ensembl_seed_map(organism)
        if not seed_map:
            print(f"[gene-cache] Seed cache missing for '{organism}', bootstrapping from MyGene...")
            seed_map = _bootstrap_ensembl_seed_map(mg, organism=organism)
            if not seed_map:
                print(
                    f"[gene-cache] Failed to bootstrap Ensembl seed for '{organism}'",
                    file=sys.stderr,
                )
                return 1
            bootstrap_path = _cache_path(organism, "ensembl")
            _save_json(bootstrap_path, seed_map)
            print(f"[gene-cache] Bootstrapped {len(seed_map)} entries -> {bootstrap_path}")

        ensembl_ids = _extract_ensembl_ids(seed_map)
        if not ensembl_ids:
            print(f"[gene-cache] No Ensembl IDs discovered for '{organism}'", file=sys.stderr)
            return 1

        ensembl_map = _query_ensembl_symbol_map(
            mg,
            organism=organism,
            ensembl_ids=ensembl_ids,
            batch_size=max(1, int(args.batch_size)),
            delay_secs=max(0.0, float(args.delay_secs)),
        )
        ensembl_path = _cache_path(organism, "ensembl")
        _save_json(ensembl_path, ensembl_map)
        meta[f"{organism}_ensembl"] = now
        meta[f"{organism}_ensembl_source"] = "mygene_querymany"
        if source_meta.get("ensembl_version"):
            meta[f"{organism}_ensembl_ensembl_version"] = source_meta["ensembl_version"]
        else:
            meta.pop(f"{organism}_ensembl_ensembl_version", None)
        meta[f"{organism}_ensembl_source_name"] = "ensembl"
        if source_versions.get("ensembl"):
            meta[f"{organism}_ensembl_source_version"] = str(source_versions["ensembl"])
        else:
            meta.pop(f"{organism}_ensembl_source_version", None)
        if source_download_dates.get("ensembl"):
            meta[f"{organism}_ensembl_source_download_date"] = str(source_download_dates["ensembl"])
        else:
            meta.pop(f"{organism}_ensembl_source_download_date", None)
        if source_meta.get("mygene_build_version"):
            meta[f"{organism}_ensembl_mygene_build_version"] = source_meta["mygene_build_version"]
        else:
            meta.pop(f"{organism}_ensembl_mygene_build_version", None)
        print(f"[gene-cache] {organism}/ensembl: {len(ensembl_map)} entries -> {ensembl_path}")

        symbols = _extract_symbols(ensembl_map)
        print(f"[gene-cache] {organism}: {len(symbols)} symbol seeds loaded")

        for gene_id_type in selected_types:
            if gene_id_type == "ensembl":
                continue
            cache = _query_type_map(
                mg,
                organism=organism,
                symbols=symbols,
                gene_id_type=gene_id_type,
                batch_size=max(1, int(args.batch_size)),
                delay_secs=max(0.0, float(args.delay_secs)),
            )
            out_path = _cache_path(organism, gene_id_type)
            _save_json(out_path, cache)
            meta[f"{organism}_{gene_id_type}"] = now
            meta[f"{organism}_{gene_id_type}_source"] = "mygene_querymany"
            # Non-Ensembl ID types must not be labeled with Ensembl version keys.
            meta.pop(f"{organism}_{gene_id_type}_ensembl_version", None)
            if gene_id_type == "entrez":
                source_name = "entrez"
            elif gene_id_type in ("uniprot", "uniprot_swissprot"):
                source_name = "uniprot"
            else:
                source_name = "ensembl"
            meta[f"{organism}_{gene_id_type}_source_name"] = source_name
            if source_versions.get(source_name):
                meta[f"{organism}_{gene_id_type}_source_version"] = str(source_versions[source_name])
            else:
                meta.pop(f"{organism}_{gene_id_type}_source_version", None)
            if source_download_dates.get(source_name):
                meta[f"{organism}_{gene_id_type}_source_download_date"] = str(
                    source_download_dates[source_name]
                )
            else:
                meta.pop(f"{organism}_{gene_id_type}_source_download_date", None)
            if source_meta.get("mygene_build_version"):
                meta[f"{organism}_{gene_id_type}_mygene_build_version"] = source_meta[
                    "mygene_build_version"
                ]
            else:
                meta.pop(f"{organism}_{gene_id_type}_mygene_build_version", None)
            print(f"[gene-cache] {organism}/{gene_id_type}: {len(cache)} entries -> {out_path}")

    _save_json(META_PATH, meta)
    print(f"[gene-cache] Updated metadata: {META_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
