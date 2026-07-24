"""
Gene Annotation Module
Gene ID to symbol mapping using bundled local cache only.

VERSION: 2.0.0

Features:
- Local cache for previously mapped genes
- Bundled cache for common mouse/human genes
- Strict offline fallback using original IDs
- Batch processing for efficiency
- Multiple gene ID types: Ensembl, Entrez, UniProt, UniProt Swiss-Prot
"""

import sys
import json
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Any
from pathlib import Path

from .utils import emit_progress


# Cache directory and file paths
MODULE_DIR = Path(__file__).parent
CACHE_DIR = MODULE_DIR / "gene_cache"
CACHE_META_FILE = CACHE_DIR / "gene_cache_meta.json"

# Legacy organism to dataset mapping (for cache file naming)
ORGANISM_KEYS = {
    "mmusculus": "mouse",
    "hsapiens": "human",
    "mouse": "mouse",
    "human": "human",
}

# Cached Ensembl version (resolved from local cache metadata only)
_ensembl_version_cache: Optional[str] = None


def get_ensembl_version() -> Optional[str]:
    """Resolve Ensembl version from local cache metadata only."""
    global _ensembl_version_cache
    if _ensembl_version_cache is not None:
        return _ensembl_version_cache

    # Strict offline mode: never perform outbound lookup here.
    return None


def _ensure_cache_dir():
    """Create cache directory if it doesn't exist."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _get_cache_file(organism: str, gene_id_type: str = "ensembl") -> Path:
    """Get cache file path for organism and gene ID type."""
    org_key = ORGANISM_KEYS.get(organism.lower(), "mouse")
    return CACHE_DIR / f"gene_symbols_{org_key}_{gene_id_type}.json"


def _get_legacy_cache_file(organism: str) -> Path:
    """Get legacy cache file path (for backward compatibility)."""
    org_key = ORGANISM_KEYS.get(organism.lower(), "mouse")
    return CACHE_DIR / f"gene_symbols_{org_key}.json"


def _load_cache_meta() -> Dict[str, str]:
    if CACHE_META_FILE.exists():
        try:
            with open(CACHE_META_FILE, 'r') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def _save_cache_meta(meta: Dict[str, str]):
    _ensure_cache_dir()
    try:
        with open(CACHE_META_FILE, 'w') as f:
            json.dump(meta, f)
    except Exception:
        pass


def _set_last_refresh(
    organism: str,
    gene_id_type: str = "ensembl",
    when: Optional[datetime] = None,
    ensembl_version: Optional[str] = None
) -> None:
    meta = _load_cache_meta()
    org_key = ORGANISM_KEYS.get(organism.lower(), organism.lower())
    cache_key = f"{org_key}_{gene_id_type}"
    timestamp = when or datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    meta[cache_key] = timestamp.isoformat()
    meta[f"{cache_key}_source"] = "local_cache"
    if ensembl_version:
        meta[f"{cache_key}_ensembl_version"] = ensembl_version
    _save_cache_meta(meta)


def _get_last_refresh(organism: str, gene_id_type: str = "ensembl") -> Optional[datetime]:
    meta = _load_cache_meta()
    org_key = ORGANISM_KEYS.get(organism.lower(), organism.lower())
    cache_key = f"{org_key}_{gene_id_type}"
    raw = meta.get(cache_key)
    if raw:
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            pass

    # Fallback to file modification time
    cache_file = _get_cache_file(organism, gene_id_type)
    if cache_file.exists():
        try:
            return datetime.fromtimestamp(cache_file.stat().st_mtime, tz=timezone.utc)
        except OSError:
            pass

    # Try legacy cache file for ensembl type
    if gene_id_type == "ensembl":
        legacy_file = _get_legacy_cache_file(organism)
        if legacy_file.exists():
            try:
                return datetime.fromtimestamp(legacy_file.stat().st_mtime, tz=timezone.utc)
            except OSError:
                pass

    return None


def get_cache_status(
    organism: str,
    gene_id_type: str = "ensembl",
    max_age_days: int = 30,
    allow_online: bool = True
) -> Dict[str, Any]:
    """Get cache status for organism and gene ID type."""
    last_refresh = _get_last_refresh(organism, gene_id_type)
    cache_file = _get_cache_file(organism, gene_id_type)
    cache_exists = cache_file.exists()
    if not cache_exists and gene_id_type == "ensembl":
        cache_exists = _get_legacy_cache_file(organism).exists()
    now = datetime.now(timezone.utc)
    if last_refresh is None:
        stale = True
    else:
        if last_refresh > now + timedelta(days=1):
            stale = True
        else:
            stale = now - last_refresh >= timedelta(days=max_age_days)

    # Get cached metadata
    meta = _load_cache_meta()
    org_key = ORGANISM_KEYS.get(organism.lower(), organism.lower())
    cache_key = f"{org_key}_{gene_id_type}"
    cached_version = (
        meta.get(f"{cache_key}_ensembl_version")
        if gene_id_type == "ensembl"
        else None
    )
    annotation_source = meta.get(f"{cache_key}_source", "local_cache")
    annotation_source_name = meta.get(f"{cache_key}_source_name")
    if gene_id_type == "uniprot_swissprot" and annotation_source_name == "uniprot":
        annotation_source_name = "uniprot_swissprot"
    if not annotation_source_name:
        if gene_id_type == "entrez":
            annotation_source_name = "entrez"
        elif gene_id_type == "uniprot_swissprot":
            annotation_source_name = "uniprot_swissprot"
        elif gene_id_type == "uniprot":
            annotation_source_name = "uniprot"
        else:
            annotation_source_name = "ensembl"
    annotation_source_version = meta.get(f"{cache_key}_source_version")

    # If no cached version, optionally try to get current version
    ensembl_version = cached_version
    ensembl_version_source = "cache" if cached_version is not None else None
    if ensembl_version is None and allow_online:
        ensembl_version = get_ensembl_version()
        if ensembl_version is not None:
            ensembl_version_source = "online"

    return {
        "organism": organism,
        "gene_id_type": gene_id_type,
        "last_refresh": last_refresh.isoformat() if last_refresh else None,
        "max_age_days": max_age_days,
        "stale": stale,
        "ensembl_version": ensembl_version,
        "ensembl_version_source": ensembl_version_source,
        "annotation_source": annotation_source,
        "annotation_source_name": annotation_source_name,
        "annotation_source_version": annotation_source_version,
        "cache_exists": cache_exists,
    }


def _load_cache(organism: str, gene_id_type: str = "ensembl") -> Dict[str, str]:
    """Load gene symbol cache for organism and gene ID type."""
    cache_file = _get_cache_file(organism, gene_id_type)

    if cache_file.exists():
        try:
            with open(cache_file, 'r') as f:
                return json.load(f)
        except Exception:
            pass

    # Fallback to legacy cache for ensembl type
    if gene_id_type == "ensembl":
        legacy_file = _get_legacy_cache_file(organism)
        if legacy_file.exists():
            try:
                with open(legacy_file, 'r') as f:
                    return json.load(f)
            except Exception:
                pass

    return {}


def _save_cache(organism: str, cache: Dict[str, str], gene_id_type: str = "ensembl"):
    """Save gene symbol cache for organism and gene ID type."""
    _ensure_cache_dir()
    cache_file = _get_cache_file(organism, gene_id_type)

    try:
        with open(cache_file, 'w') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f"[Annotation] Failed to save cache: {e}", file=sys.stderr)


def _clean_gene_id(gene_id: str) -> str:
    """Strip version number from gene ID (e.g., ENSMUSG00000000001.5 -> ENSMUSG00000000001)."""
    # Only strip version for Ensembl-style IDs
    if gene_id.startswith(("ENS", "FBgn")):
        return gene_id.split('.')[0]
    return gene_id


def _is_valid_symbol(value: Any) -> bool:
    if value is None:
        return False
    try:
        symbol = str(value).strip()
    except Exception:
        return False
    return bool(symbol) and symbol.lower() != "nan"


def get_gene_symbols(
    gene_ids: List[str],
    organism: str = "mmusculus",
    gene_id_type: str = "ensembl",
    use_cache: bool = True,
    batch_size: int = 1000,
    refresh_identity_cache: bool = False,
    allow_online: bool = False,
    refresh_all: bool = False
) -> Dict[str, str]:
    """
    Convert gene IDs to gene symbols.

    Args:
        gene_ids: List of gene IDs (Ensembl, Entrez, or UniProt depending on gene_id_type)
        organism: "mmusculus" (mouse) or "hsapiens" (human)
        gene_id_type: Type of gene ID - "ensembl", "entrez", "uniprot", or "uniprot_swissprot"
        use_cache: Whether to use local cache
        batch_size: Number of IDs to query per batch
        refresh_identity_cache: Requery IDs mapped to themselves in cache
        allow_online: Reserved for compatibility; runtime is offline-only
        refresh_all: Requery all provided IDs (ignores cached values)

    Returns:
        Dict of {gene_id: gene_symbol, ...}
    """
    if not gene_ids:
        return {}

    # Clean version numbers (for Ensembl IDs)
    id_mapping = {gid: _clean_gene_id(gid) for gid in gene_ids}
    clean_ids = list(set(id_mapping.values()))

    # Load cache
    cache = _load_cache(organism, gene_id_type) if use_cache else {}

    # Find IDs not in cache or mapped to themselves (stale cache)
    if not use_cache or refresh_all:
        uncached_ids = list(clean_ids)
    else:
        uncached_ids = []
        for gid in clean_ids:
            cached = cache.get(gid)
            if cached is None:
                uncached_ids.append(gid)
            elif refresh_identity_cache and cached == gid:
                uncached_ids.append(gid)

    # Strict offline mode: never query remote services for uncached IDs.
    if uncached_ids:
        for gid in uncached_ids:
            if not _is_valid_symbol(cache.get(gid)):
                cache[gid] = gid

    # Build result mapping (original ID -> symbol)
    result = {}
    for original_id, clean_id in id_mapping.items():
        symbol = cache.get(clean_id)
        symbol_str = str(symbol).strip() if symbol is not None else ""
        if symbol is None or symbol != symbol or not symbol_str or symbol_str.lower() == "nan":
            symbol = original_id
        result[original_id] = symbol

    return result


def annotate_gene_results(
    genes: List[Dict[str, Any]],
    organism: str = "mmusculus",
    gene_id_type: str = "ensembl",
    use_cache: bool = True,
    refresh_identity_cache: bool = False,
    allow_online: bool = False,
    refresh_all: bool = False
) -> List[Dict[str, Any]]:
    """
    Annotate gene results with symbols.

    Args:
        genes: List of gene result dicts (must have 'gene_id' field)
        organism: Organism for lookup
        gene_id_type: Type of gene ID - "ensembl", "entrez", "uniprot", or "uniprot_swissprot"
        use_cache: Whether to use cache
        refresh_identity_cache: Requery IDs mapped to themselves in cache
        allow_online: Reserved for compatibility; runtime is offline-only
        refresh_all: Requery all provided IDs (ignores cached values)

    Returns:
        Updated gene list with 'gene_symbol' field populated
    """
    if not genes:
        return genes

    # Extract gene IDs
    gene_ids = [g['gene_id'] for g in genes if 'gene_id' in g]

    # Get symbols
    symbols = get_gene_symbols(
        gene_ids,
        organism=organism,
        gene_id_type=gene_id_type,
        use_cache=use_cache,
        refresh_identity_cache=refresh_identity_cache,
        allow_online=allow_online,
        refresh_all=refresh_all
    )

    # Update genes
    for gene in genes:
        gene_id = gene.get('gene_id', '')
        gene['gene_symbol'] = symbols.get(gene_id, gene_id)

    return genes


def create_bundled_cache(
    gene_ids: List[str],
    organism: str = "mmusculus",
    gene_id_type: str = "ensembl",
    output_path: Optional[str] = None
) -> str:
    """
    Create bundled cache file for distribution.

    This helper now writes from local cache only.
    Use scripts/generate_rnaseq_gene_caches.py to fetch/refresh bundled data.

    Args:
        gene_ids: List of gene IDs to cache
        organism: Organism for lookup
        gene_id_type: Type of gene ID
        output_path: Optional custom output path

    Returns:
        Path to created cache file
    """
    _ensure_cache_dir()

    # Runtime helper remains offline-only.
    symbols = get_gene_symbols(
        gene_ids,
        organism=organism,
        gene_id_type=gene_id_type,
        use_cache=False
    )

    # Save to file
    if output_path:
        cache_file = Path(output_path)
    else:
        cache_file = _get_cache_file(organism, gene_id_type)

    with open(cache_file, 'w') as f:
        json.dump(symbols, f, indent=2)

    return str(cache_file)
