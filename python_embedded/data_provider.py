"""
Data Provider - Phase 5 (DuckDB Hybrid Cache)

Provides lazy data access for large datasets using Polars/DuckDB.
For small datasets (< 1M rows), uses existing pandas path.
For large datasets (>= 1M rows), uses lazy Polars/DuckDB queries.

This module enables statistical tests to work on 50M+ row datasets without OOM.
"""

import os
from typing import Dict, List, Any, Optional, Union
import numpy as np

# =========================================================================
# SQL IDENTIFIER ESCAPING (Phase 1 Fix #3)
# =========================================================================

def quote_identifier(name: str) -> str:
    """
    Escape SQL identifier for DuckDB to prevent SQL injection.

    Handles column names with special characters, quotes, SQL keywords, etc.

    Args:
        name: Column name or identifier to escape

    Returns:
        Properly quoted identifier string
    """
    # Escape any embedded double quotes by doubling them
    escaped = name.replace('"', '""')
    return f'"{escaped}"'


def numeric_expr(column: str) -> str:
    """
    Build a DuckDB-safe numeric expression for a column.

    Uses TRY_CAST so non-numeric values become NULL instead of throwing.
    """
    return f"TRY_CAST(TRIM(CAST({quote_identifier(column)} AS VARCHAR)) AS DOUBLE)"


def is_duckdb_source(path: str) -> bool:
    """
    Treat both .duckdb and .ecpdb files as DuckDB sources.
    (.ecpdb is easyCris's user-facing extension.)
    """
    return path.endswith('.duckdb') or path.endswith('.ecpdb')


# Lazy imports to avoid loading heavy libraries when not needed
_polars = None
_duckdb = None


def _get_polars():
    """Lazy import of Polars."""
    global _polars
    if _polars is None:
        try:
            import polars as pl
            _polars = pl
        except ImportError:
            raise ImportError(
                "Polars is required for large dataset support. "
                "Install with: pip install polars"
            )
    return _polars


def _get_duckdb():
    """Lazy import of DuckDB."""
    global _duckdb
    if _duckdb is None:
        try:
            import duckdb
            _duckdb = duckdb
        except ImportError:
            raise ImportError(
                "DuckDB is required for large dataset support. "
                "Install with: pip install duckdb"
            )
    return _duckdb


class DataProvider:
    """
    Unified data provider for both small and large datasets.

    For small datasets: Uses pandas DataFrame (current validated path)
    For large datasets: Uses lazy Polars/DuckDB queries

    All statistical formulas remain unchanged - only data access is different.
    """

    def __init__(
        self,
        source: str,
        mode: str = 'auto',
        columns: Optional[List[str]] = None
    ):
        """
        Initialize DataProvider.

        Args:
            source: Path to data source (Arrow IPC, DuckDB file, or CSV)
            mode: 'pandas' for small datasets, 'lazy' for large, 'auto' to detect
            columns: Optional list of columns to load (for selective access)
        """
        self.source = source
        self.mode = mode
        self.columns = columns
        self._df = None  # Cached pandas DataFrame (small datasets only)
        self._lf = None  # Lazy frame reference (large datasets)
        self._conn = None  # DuckDB connection (large datasets)

        # Detect mode based on file extension if auto
        if mode == 'auto':
            if is_duckdb_source(source):
                self.mode = 'lazy'
            elif source.endswith('.arrow') or source.endswith('.ipc') or source.endswith('.parquet'):
                # Arrow/Parquet files could be either - check size
                file_size = os.path.getsize(source) if os.path.exists(source) else 0
                self.mode = 'lazy' if file_size > 500_000_000 else 'pandas'
            else:
                self.mode = 'pandas'

    def _ensure_pandas_df(self):
        """Load data into pandas DataFrame (small datasets)."""
        if self._df is not None:
            return self._df

        import pandas as pd
        import pyarrow.ipc as ipc

        if self.source.endswith('.arrow') or self.source.endswith('.ipc'):
            with open(self.source, 'rb') as f:
                reader = ipc.open_file(f)
                table = reader.read_all()
                self._df = table.to_pandas()
        elif self.source.endswith('.parquet'):
            import pyarrow.parquet as pq
            table = pq.read_table(self.source)
            self._df = table.to_pandas()
        elif self.source.endswith('.csv'):
            self._df = pd.read_csv(self.source)
        elif is_duckdb_source(self.source):
            # Read from DuckDB into pandas (only for small datasets!)
            duckdb = _get_duckdb()
            conn = duckdb.connect(self.source, read_only=True)
            self._df = conn.execute("SELECT * FROM data").fetchdf()
            conn.close()
        else:
            raise ValueError(f"Unsupported file format: {self.source}")

        # Filter columns if specified
        if self.columns:
            self._df = self._df[self.columns]

        return self._df

    def _get_duckdb_conn(self):
        """Get or create DuckDB connection (large datasets)."""
        if self._conn is None:
            duckdb = _get_duckdb()
            self._conn = duckdb.connect(self.source, read_only=True)
        return self._conn

    def _get_lazy_frame(self):
        """
        Get lazy frame for large dataset operations.

        Phase 1 Fix #2: For DuckDB sources, this method is DEPRECATED.
        Use direct SQL aggregation methods instead (get_group_stats, get_contingency_counts, etc.)
        to avoid full materialization.

        For Arrow/IPC files, returns a true lazy scan that doesn't load data.
        """
        if self._lf is not None:
            return self._lf

        pl = _get_polars()

        if is_duckdb_source(self.source):
            # Phase 1 Fix #2: DO NOT use fetchdf() for DuckDB - it defeats lazy loading!
            # For 50M rows, this would cause OOM.
            # Raise error to direct callers to use SQL aggregation paths instead.
            raise RuntimeError(
                "_get_lazy_frame() is not supported for DuckDB sources with large datasets. "
                "Use direct SQL aggregation methods (get_group_stats, get_contingency_counts, "
                "get_column, get_columns) instead to avoid full materialization."
            )
        elif self.source.endswith('.arrow') or self.source.endswith('.ipc'):
            # Arrow/IPC files: true lazy scan (no data loaded yet)
            self._lf = pl.scan_ipc(self.source)
            if self.columns:
                self._lf = self._lf.select(self.columns)
        elif self.source.endswith('.parquet'):
            # Parquet files: true lazy scan (no data loaded yet)
            self._lf = pl.scan_parquet(self.source)
            if self.columns:
                self._lf = self._lf.select(self.columns)
        else:
            raise ValueError(f"Unsupported format for lazy loading: {self.source}")

        return self._lf

    # =========================================================================
    # PUBLIC API - Same interface for both modes
    # =========================================================================

    def get_column(self, column: str) -> np.ndarray:
        """
        Get column data as numpy array.

        For small datasets: Returns full array (current behavior)
        For large datasets: Materializes column lazily via SQL
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            return df[column].values
        else:
            # Large dataset: use DuckDB directly
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                quoted_col = quote_identifier(column)
                result = conn.execute(f'SELECT {quoted_col} FROM data').fetchdf()
                return result[column].to_numpy()

            # Arrow/IPC: use Polars lazy scan
            pl = _get_polars()
            lf = self._get_lazy_frame()
            result = lf.select(pl.col(column)).collect()
            return result[column].to_numpy()

    def get_columns(self, columns: List[str]) -> Dict[str, np.ndarray]:
        """
        Get multiple columns as dict of numpy arrays.

        For small datasets: Returns full arrays (current behavior)
        For large datasets: Materializes columns lazily via SQL
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            return {col: df[col].values for col in columns}
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                cols = ", ".join([quote_identifier(c) for c in columns])
                result = conn.execute(f"SELECT {cols} FROM data").fetchdf()
                return {col: result[col].to_numpy() for col in columns}

            # Arrow/IPC: use Polars lazy scan
            pl = _get_polars()
            lf = self._get_lazy_frame()
            result = lf.select([pl.col(c) for c in columns]).collect()
            return {col: result[col].to_numpy() for col in columns}

    def get_dataframe(self, columns: Optional[List[str]] = None):
        """
        Get data as pandas DataFrame.

        Phase 5: Used by stats.py for data transformation in large dataset mode.

        For small datasets: Returns full DataFrame (current behavior)
        For large datasets: Materializes selected columns lazily into pandas

        WARNING: For large DuckDB datasets, this will materialize selected columns.
        Prefer using SQL aggregation methods (get_group_stats, get_contingency_counts)
        when possible to avoid memory issues.

        Args:
            columns: Optional list of columns to fetch. If None, uses instance columns or all.

        Returns:
            pandas DataFrame with the requested columns
        """
        import pandas as pd

        cols_to_fetch = columns or self.columns

        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            if cols_to_fetch:
                return df[cols_to_fetch].copy()
            return df.copy()
        else:
            # Large dataset: materialize selected columns via SQL
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                if cols_to_fetch:
                    cols = ", ".join([quote_identifier(c) for c in cols_to_fetch])
                else:
                    cols = "*"
                return conn.execute(f"SELECT {cols} FROM data").fetchdf()

            # Arrow/IPC: use Polars lazy scan
            pl = _get_polars()
            lf = self._get_lazy_frame()

            if cols_to_fetch:
                result = lf.select([pl.col(c) for c in cols_to_fetch]).collect()
            else:
                result = lf.collect()

            return result.to_pandas()

    def get_group_stats(
        self,
        value_column: str,
        group_column: str
    ) -> Dict[str, Dict[str, float]]:
        """
        Get group statistics (n, mean, std) for a value column grouped by another column.

        Uses lazy SQL aggregation for large datasets - never materializes full data.

        Returns:
            Dict[group_name, {n, mean, std, std_error}]
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            result = {}
            for group, group_df in df.groupby(group_column):
                vals = group_df[value_column].dropna()
                n = len(vals)
                mean = vals.mean()
                std = vals.std(ddof=1)
                result[str(group)] = {
                    'n': n,
                    'mean': float(mean),
                    'std': float(std),
                    'std_error': float(std / np.sqrt(n)) if n > 0 else float('nan')
                }
            return result
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                value_col = numeric_expr(value_column)
                group_col = quote_identifier(group_column)
                sql = f"""
                    SELECT {group_col} AS group_val,
                           COUNT({value_col}) AS n,
                           AVG({value_col}) AS mean,
                           STDDEV_SAMP({value_col}) AS std
                    FROM data
                    WHERE {value_col} IS NOT NULL
                    GROUP BY {group_col}
                """
                rows = conn.execute(sql).fetchall()
                result = {}
                for row in rows:
                    group = str(row[0])
                    n = row[1]
                    mean = row[2]
                    std = row[3]
                    result[group] = {
                        'n': n,
                        'mean': float(mean) if mean is not None else float('nan'),
                        'std': float(std) if std is not None else float('nan'),
                        'std_error': float(std / np.sqrt(n)) if n > 0 and std is not None else float('nan')
                    }
                return result

            # Arrow/IPC: use Polars lazy scan
            pl = _get_polars()
            lf = self._get_lazy_frame()

            stats = (
                lf.group_by(group_column)
                .agg([
                    pl.count().alias('n'),
                    pl.mean(value_column).alias('mean'),
                    pl.std(value_column, ddof=1).alias('std'),
                ])
                .collect()
            )

            result = {}
            for row in stats.iter_rows(named=True):
                group = str(row[group_column])
                n = row['n']
                mean = row['mean']
                std = row['std']
                result[group] = {
                    'n': n,
                    'mean': float(mean) if mean is not None else float('nan'),
                    'std': float(std) if std is not None else float('nan'),
                    'std_error': float(std / np.sqrt(n)) if n > 0 and std is not None else float('nan')
                }
            return result

    def get_correlation_data(
        self,
        x_column: str,
        y_column: str
    ) -> tuple:
        """
        Get paired data for correlation analysis.

        Returns:
            Tuple of (x_values, y_values) as numpy arrays
        """
        cols = self.get_columns([x_column, y_column])
        x = cols[x_column]
        y = cols[y_column]

        # Coerce to numeric (invalid values become NaN)
        import pandas as pd
        x = pd.to_numeric(x, errors='coerce').to_numpy()
        y = pd.to_numeric(y, errors='coerce').to_numpy()

        # Remove NaN pairs
        mask = ~(np.isnan(x) | np.isnan(y))
        return x[mask], y[mask]

    def get_anova_data(
        self,
        value_column: str,
        factor_columns: List[str]
    ) -> Dict[str, Any]:
        """
        Get data for ANOVA analysis.

        For large datasets, computes group sums/counts lazily.

        Returns:
            Dict with values and factor levels
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            result = {
                'values': df[value_column].values,
            }
            for factor in factor_columns:
                result[factor] = df[factor].values
            return result
        else:
            # Large dataset: materialize only needed columns
            all_cols = [value_column] + factor_columns
            data = self.get_columns(all_cols)
            result = {'values': data[value_column]}
            for factor in factor_columns:
                result[factor] = data[factor]
            return result

    def get_contingency_counts(
        self,
        row_column: str,
        col_column: str
    ) -> Dict[str, Any]:
        """
        Get contingency table counts for chi-square analysis.

        Uses lazy SQL aggregation for large datasets - never materializes full data.

        Returns:
            Dict with observed counts matrix and labels
        """
        if self.mode == 'pandas':
            import pandas as pd
            df = self._ensure_pandas_df()
            ct = pd.crosstab(df[row_column], df[col_column])
            return {
                'observed': ct.values,
                'row_labels': list(ct.index),
                'col_labels': list(ct.columns)
            }
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                row_col = quote_identifier(row_column)
                col_col = quote_identifier(col_column)
                sql = f"""
                    SELECT {row_col} AS row_val,
                           {col_col} AS col_val,
                           COUNT(*) AS count
                    FROM data
                    WHERE {row_col} IS NOT NULL AND {col_col} IS NOT NULL
                    GROUP BY {row_col}, {col_col}
                """
                import pandas as pd
                df = conn.execute(sql).fetchdf()
                ct = df.pivot(index='row_val', columns='col_val', values='count').fillna(0)
                return {
                    'observed': ct.values.astype(int),
                    'row_labels': list(ct.index),
                    'col_labels': list(ct.columns)
                }

            # Arrow/IPC: use Polars lazy scan
            pl = _get_polars()
            lf = self._get_lazy_frame()

            counts = (
                lf.group_by([row_column, col_column])
                .agg(pl.count().alias('count'))
                .collect()
            )

            # Pivot to matrix form
            import pandas as pd
            df = counts.to_pandas()
            ct = df.pivot(index=row_column, columns=col_column, values='count').fillna(0)

            return {
                'observed': ct.values.astype(int),
                'row_labels': list(ct.index),
                'col_labels': list(ct.columns)
            }

    # =========================================================================
    # PHASE 3: SQL AGGREGATE PATHS FOR PERFORMANCE
    # =========================================================================

    def get_descriptive_stats(self, column: str) -> Dict[str, float]:
        """
        Get descriptive statistics for a column via SQL aggregation.

        Phase 3: Uses SQL for large datasets - never materializes full data.

        Returns:
            Dict with n, mean, std, min, max, median, q1, q3, skewness, kurtosis
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            vals = df[column].dropna()
            from scipy import stats as scipy_stats
            n = len(vals)
            if n == 0:
                return {k: float('nan') for k in ['n', 'mean', 'std', 'min', 'max', 'median', 'q1', 'q3', 'skewness', 'kurtosis']}
            return {
                'n': n,
                'mean': float(vals.mean()),
                'std': float(vals.std(ddof=1)),
                'min': float(vals.min()),
                'max': float(vals.max()),
                'median': float(vals.median()),
                'q1': float(vals.quantile(0.25)),
                'q3': float(vals.quantile(0.75)),
                'skewness': float(scipy_stats.skew(vals)),
                'kurtosis': float(scipy_stats.kurtosis(vals)),
            }
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                col = numeric_expr(column)
                sql = f"""
                    SELECT
                        COUNT({col}) AS n,
                        AVG({col}) AS mean,
                        STDDEV_SAMP({col}) AS std,
                        MIN({col}) AS min_val,
                        MAX({col}) AS max_val,
                        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {col}) AS median,
                        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY {col}) AS q1,
                        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY {col}) AS q3,
                        SKEWNESS({col}) AS skewness,
                        KURTOSIS({col}) AS kurtosis
                    FROM data
                    WHERE {col} IS NOT NULL
                """
                row = conn.execute(sql).fetchone()
                if row is None or row[0] == 0:
                    return {k: float('nan') for k in ['n', 'mean', 'std', 'min', 'max', 'median', 'q1', 'q3', 'skewness', 'kurtosis']}
                return {
                    'n': row[0],
                    'mean': float(row[1]) if row[1] is not None else float('nan'),
                    'std': float(row[2]) if row[2] is not None else float('nan'),
                    'min': float(row[3]) if row[3] is not None else float('nan'),
                    'max': float(row[4]) if row[4] is not None else float('nan'),
                    'median': float(row[5]) if row[5] is not None else float('nan'),
                    'q1': float(row[6]) if row[6] is not None else float('nan'),
                    'q3': float(row[7]) if row[7] is not None else float('nan'),
                    'skewness': float(row[8]) if row[8] is not None else float('nan'),
                    'kurtosis': float(row[9]) if row[9] is not None else float('nan'),
                }

            # Arrow/IPC/Parquet: use Polars lazy aggregation (no full materialization)
            pl = _get_polars()
            lf = self._get_lazy_frame()
            expr = pl.col(column).cast(pl.Float64, strict=False)
            clean = pl.when(expr.is_finite()).then(expr).otherwise(None)

            agg = lf.select([
                clean.count().alias("n"),
                clean.mean().alias("mean"),
                clean.std(ddof=1).alias("std"),
                clean.min().alias("min"),
                clean.max().alias("max"),
                clean.median().alias("median"),
                clean.quantile(0.25, "linear").alias("q1"),
                clean.quantile(0.75, "linear").alias("q3"),
                clean.skew().alias("skewness"),
                clean.kurtosis().alias("kurtosis"),
            ]).collect()

            row = agg.to_dicts()[0] if agg.height > 0 else {}
            n = row.get("n") or 0
            if n == 0:
                return {k: float('nan') for k in ['n', 'mean', 'std', 'min', 'max', 'median', 'q1', 'q3', 'skewness', 'kurtosis']}

            def _to_float(value):
                return float(value) if value is not None else float('nan')

            return {
                'n': int(n),
                'mean': _to_float(row.get("mean")),
                'std': _to_float(row.get("std")),
                'min': _to_float(row.get("min")),
                'max': _to_float(row.get("max")),
                'median': _to_float(row.get("median")),
                'q1': _to_float(row.get("q1")),
                'q3': _to_float(row.get("q3")),
                'skewness': _to_float(row.get("skewness")),
                'kurtosis': _to_float(row.get("kurtosis")),
            }

    def get_mode_stats(self, column: str) -> Dict[str, Any]:
        """
        Get mode statistics for a column without full materialization.

        Returns:
            Dict with has_mode, mode, mode_count, is_multimodal, all_modes
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            vals = df[column].dropna().values
            if len(vals) == 0:
                return {
                    'has_mode': False,
                    'mode': None,
                    'mode_count': 0,
                    'is_multimodal': False,
                    'all_modes': []
                }
            unique_vals, counts = np.unique(vals, return_counts=True)
            max_count = int(np.max(counts))
            min_count = int(np.min(counts))
            if max_count == min_count:
                return {
                    'has_mode': False,
                    'mode': None,
                    'mode_count': max_count,
                    'is_multimodal': False,
                    'all_modes': []
                }
            modes = unique_vals[counts == max_count]
            return {
                'has_mode': True,
                'mode': modes[0] if len(modes) > 0 else None,
                'mode_count': max_count,
                'is_multimodal': len(modes) > 1,
                'all_modes': modes.tolist()
            }

        if is_duckdb_source(self.source):
            conn = self._get_duckdb_conn()
            col = quote_identifier(column)
            stats_sql = f"""
                WITH counts AS (
                    SELECT {col} AS val, COUNT(*) AS cnt
                    FROM data
                    WHERE {col} IS NOT NULL
                    GROUP BY {col}
                )
                SELECT MIN(cnt) AS min_cnt, MAX(cnt) AS max_cnt
                FROM counts
            """
            stats_row = conn.execute(stats_sql).fetchone()
            if not stats_row or stats_row[1] is None:
                return {
                    'has_mode': False,
                    'mode': None,
                    'mode_count': 0,
                    'is_multimodal': False,
                    'all_modes': []
                }
            min_cnt = int(stats_row[0]) if stats_row[0] is not None else 0
            max_cnt = int(stats_row[1]) if stats_row[1] is not None else 0
            if max_cnt == min_cnt:
                return {
                    'has_mode': False,
                    'mode': None,
                    'mode_count': max_cnt,
                    'is_multimodal': False,
                    'all_modes': []
                }
            mode_sql = f"""
                WITH counts AS (
                    SELECT {col} AS val, COUNT(*) AS cnt
                    FROM data
                    WHERE {col} IS NOT NULL
                    GROUP BY {col}
                )
                SELECT val
                FROM counts
                WHERE cnt = {max_cnt}
                ORDER BY val
            """
            rows = conn.execute(mode_sql).fetchall()
            modes = [row[0] for row in rows]
            return {
                'has_mode': True,
                'mode': modes[0] if modes else None,
                'mode_count': max_cnt,
                'is_multimodal': len(modes) > 1,
                'all_modes': modes
            }

        # Arrow/IPC/Parquet: use Polars lazy aggregation
        pl = _get_polars()
        lf = self._get_lazy_frame()
        counts = (
            lf.select(pl.col(column).alias("val"))
            .drop_nulls()
            .group_by("val")
            .agg(pl.len().alias("cnt"))
        )

        stats = counts.select(
            pl.col("cnt").min().alias("min_cnt"),
            pl.col("cnt").max().alias("max_cnt")
        ).collect()
        stats_row = stats.to_dicts()[0] if stats.height > 0 else {}
        min_cnt = stats_row.get("min_cnt")
        max_cnt = stats_row.get("max_cnt")

        if max_cnt is None:
            return {
                'has_mode': False,
                'mode': None,
                'mode_count': 0,
                'is_multimodal': False,
                'all_modes': []
            }
        if max_cnt == min_cnt:
            return {
                'has_mode': False,
                'mode': None,
                'mode_count': int(max_cnt),
                'is_multimodal': False,
                'all_modes': []
            }

        modes_df = counts.filter(pl.col("cnt") == max_cnt).select("val").sort("val").collect()
        modes = modes_df["val"].to_list() if "val" in modes_df.columns else []
        return {
            'has_mode': True,
            'mode': modes[0] if len(modes) > 0 else None,
            'mode_count': int(max_cnt),
            'is_multimodal': len(modes) > 1,
            'all_modes': modes
        }

    def get_correlation_aggregates(
        self,
        x_column: str,
        y_column: str
    ) -> Dict[str, float]:
        """
        Get sums needed for correlation computation via SQL aggregation.

        Phase 3: Computes SUM(x), SUM(y), SUM(x*y), SUM(x^2), SUM(y^2), COUNT(*)
        via SQL to avoid loading full columns into memory.

        Returns:
            Dict with n, sum_x, sum_y, sum_xy, sum_x2, sum_y2
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            x = df[x_column].values
            y = df[y_column].values
            mask = ~(np.isnan(x) | np.isnan(y))
            x, y = x[mask], y[mask]
            n = len(x)
            if n == 0:
                return {k: float('nan') for k in ['n', 'sum_x', 'sum_y', 'sum_xy', 'sum_x2', 'sum_y2']}
            return {
                'n': n,
                'sum_x': float(np.sum(x)),
                'sum_y': float(np.sum(y)),
                'sum_xy': float(np.sum(x * y)),
                'sum_x2': float(np.sum(x * x)),
                'sum_y2': float(np.sum(y * y)),
            }
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                x_col = numeric_expr(x_column)
                y_col = numeric_expr(y_column)
                sql = f"""
                    SELECT
                        COUNT(*) AS n,
                        SUM({x_col}) AS sum_x,
                        SUM({y_col}) AS sum_y,
                        SUM({x_col} * {y_col}) AS sum_xy,
                        SUM({x_col} * {x_col}) AS sum_x2,
                        SUM({y_col} * {y_col}) AS sum_y2
                    FROM data
                    WHERE {x_col} IS NOT NULL AND {y_col} IS NOT NULL
                """
                row = conn.execute(sql).fetchone()
                if row is None or row[0] == 0:
                    return {k: float('nan') for k in ['n', 'sum_x', 'sum_y', 'sum_xy', 'sum_x2', 'sum_y2']}
                return {
                    'n': row[0],
                    'sum_x': float(row[1]) if row[1] is not None else float('nan'),
                    'sum_y': float(row[2]) if row[2] is not None else float('nan'),
                    'sum_xy': float(row[3]) if row[3] is not None else float('nan'),
                    'sum_x2': float(row[4]) if row[4] is not None else float('nan'),
                    'sum_y2': float(row[5]) if row[5] is not None else float('nan'),
                }

            # Arrow/IPC/Parquet: use Polars lazy aggregation
            pl = _get_polars()
            lf = self._get_lazy_frame()
            x_expr = pl.col(x_column).cast(pl.Float64, strict=False)
            y_expr = pl.col(y_column).cast(pl.Float64, strict=False)
            valid = x_expr.is_finite() & y_expr.is_finite()
            x_clean = pl.when(valid).then(x_expr).otherwise(None)
            y_clean = pl.when(valid).then(y_expr).otherwise(None)

            agg = lf.select([
                x_clean.count().alias("n"),
                x_clean.sum().alias("sum_x"),
                y_clean.sum().alias("sum_y"),
                (x_clean * y_clean).sum().alias("sum_xy"),
                (x_clean * x_clean).sum().alias("sum_x2"),
                (y_clean * y_clean).sum().alias("sum_y2"),
            ]).collect()

            row = agg.to_dicts()[0] if agg.height > 0 else {}
            n = row.get("n") or 0
            if n == 0:
                return {k: float('nan') for k in ['n', 'sum_x', 'sum_y', 'sum_xy', 'sum_x2', 'sum_y2']}
            return {
                'n': int(n),
                'sum_x': float(row.get("sum_x")) if row.get("sum_x") is not None else float('nan'),
                'sum_y': float(row.get("sum_y")) if row.get("sum_y") is not None else float('nan'),
                'sum_xy': float(row.get("sum_xy")) if row.get("sum_xy") is not None else float('nan'),
                'sum_x2': float(row.get("sum_x2")) if row.get("sum_x2") is not None else float('nan'),
                'sum_y2': float(row.get("sum_y2")) if row.get("sum_y2") is not None else float('nan'),
            }

    def get_ttest_aggregates(
        self,
        value_column: str,
        group_column: str
    ) -> Dict[str, Dict[str, float]]:
        """
        Get aggregates needed for t-test via SQL.

        Phase 3: Uses get_group_stats internally but adds variance for t-test formula.

        Returns:
            Dict[group_name, {n, mean, std, var, sum, sum_sq, min, max}]
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            result = {}
            for group, group_df in df.groupby(group_column):
                vals = group_df[value_column].dropna()
                n = len(vals)
                if n == 0:
                    result[str(group)] = {k: float('nan') for k in ['n', 'mean', 'std', 'var', 'sum', 'sum_sq', 'min', 'max']}
                    continue
                mean = float(vals.mean())
                std = float(vals.std(ddof=1))
                result[str(group)] = {
                    'n': n,
                    'mean': mean,
                    'std': std,
                    'var': std ** 2,
                    'sum': float(vals.sum()),
                    'sum_sq': float((vals ** 2).sum()),
                    'min': float(vals.min()),
                    'max': float(vals.max()),
                }
            return result
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                value_col = numeric_expr(value_column)
                group_col = quote_identifier(group_column)
                sql = f"""
                    SELECT {group_col} AS group_val,
                           MIN(_row_index) AS first_row,
                           COUNT({value_col}) AS n,
                           AVG({value_col}) AS mean,
                           STDDEV_SAMP({value_col}) AS std,
                           VAR_SAMP({value_col}) AS var,
                           SUM({value_col}) AS sum_val,
                           SUM({value_col} * {value_col}) AS sum_sq,
                           MIN({value_col}) AS min_val,
                           MAX({value_col}) AS max_val
                    FROM data
                    WHERE {value_col} IS NOT NULL
                    GROUP BY {group_col}
                    ORDER BY first_row
                """
                rows = conn.execute(sql).fetchall()
                result = {}
                for row in rows:
                    group = str(row[0])
                    result[group] = {
                        'n': row[2],
                        'mean': float(row[3]) if row[3] is not None else float('nan'),
                        'std': float(row[4]) if row[4] is not None else float('nan'),
                        'var': float(row[5]) if row[5] is not None else float('nan'),
                        'sum': float(row[6]) if row[6] is not None else float('nan'),
                        'sum_sq': float(row[7]) if row[7] is not None else float('nan'),
                        'min': float(row[8]) if row[8] is not None else float('nan'),
                        'max': float(row[9]) if row[9] is not None else float('nan'),
                    }
                return result

            # Arrow/IPC/Parquet: use Polars lazy aggregation
            pl = _get_polars()
            lf = self._get_lazy_frame()
            value_expr = pl.col(value_column).cast(pl.Float64, strict=False)
            clean = pl.when(value_expr.is_finite()).then(value_expr).otherwise(None)
            group_expr = pl.col(group_column)

            agg = (
                lf.select([
                    group_expr.alias("group_val"),
                    clean.alias("val")
                ])
                .group_by("group_val")
                .agg([
                    pl.count("val").alias("n"),
                    pl.mean("val").alias("mean"),
                    pl.col("val").std(ddof=1).alias("std"),
                    pl.col("val").var(ddof=1).alias("var"),
                    pl.sum("val").alias("sum_val"),
                    (pl.col("val") * pl.col("val")).sum().alias("sum_sq"),
                    pl.min("val").alias("min_val"),
                    pl.max("val").alias("max_val"),
                ])
                .collect()
            )

            result = {}
            for row in agg.to_dicts():
                group = str(row.get("group_val"))
                result[group] = {
                    'n': int(row.get("n") or 0),
                    'mean': float(row.get("mean")) if row.get("mean") is not None else float('nan'),
                    'std': float(row.get("std")) if row.get("std") is not None else float('nan'),
                    'var': float(row.get("var")) if row.get("var") is not None else float('nan'),
                    'sum': float(row.get("sum_val")) if row.get("sum_val") is not None else float('nan'),
                    'sum_sq': float(row.get("sum_sq")) if row.get("sum_sq") is not None else float('nan'),
                    'min': float(row.get("min_val")) if row.get("min_val") is not None else float('nan'),
                    'max': float(row.get("max_val")) if row.get("max_val") is not None else float('nan'),
                }
            return result

    def get_paired_ttest_aggregates(
        self,
        column_a: str,
        column_b: str
    ) -> Dict[str, float]:
        """
        Get aggregates needed for paired t-test via SQL.

        Returns:
            Dict with n, mean, std, sum, sum_sq, min, max for differences (A - B).
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            import pandas as pd
            series_a = pd.to_numeric(df[column_a], errors="coerce")
            series_b = pd.to_numeric(df[column_b], errors="coerce")
            mask = series_a.notna() & series_b.notna()
            diffs = (series_a[mask] - series_b[mask]).astype(float)
            n = int(len(diffs))
            if n == 0:
                return {k: float('nan') for k in ['n', 'mean', 'std', 'sum', 'sum_sq', 'min', 'max']}
            mean = float(diffs.mean())
            std = float(diffs.std(ddof=1)) if n > 1 else float('nan')
            return {
                'n': n,
                'mean': mean,
                'std': std,
                'sum': float(diffs.sum()),
                'sum_sq': float((diffs ** 2).sum()),
                'min': float(diffs.min()),
                'max': float(diffs.max()),
            }
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                col_a = numeric_expr(column_a)
                col_b = numeric_expr(column_b)
                sql = f"""
                    SELECT
                        COUNT(*) AS n,
                        AVG(diff) AS mean,
                        STDDEV_SAMP(diff) AS std,
                        SUM(diff) AS sum_val,
                        SUM(diff * diff) AS sum_sq,
                        MIN(diff) AS min_val,
                        MAX(diff) AS max_val
                    FROM (
                        SELECT ({col_a} - {col_b}) AS diff
                        FROM data
                        WHERE {col_a} IS NOT NULL AND {col_b} IS NOT NULL
                    ) t
                """
                row = conn.execute(sql).fetchone()
                if row is None or row[0] == 0:
                    return {k: float('nan') for k in ['n', 'mean', 'std', 'sum', 'sum_sq', 'min', 'max']}
                return {
                    'n': row[0],
                    'mean': float(row[1]) if row[1] is not None else float('nan'),
                    'std': float(row[2]) if row[2] is not None else float('nan'),
                    'sum': float(row[3]) if row[3] is not None else float('nan'),
                    'sum_sq': float(row[4]) if row[4] is not None else float('nan'),
                    'min': float(row[5]) if row[5] is not None else float('nan'),
                    'max': float(row[6]) if row[6] is not None else float('nan'),
                }

            # Arrow/IPC/Parquet: use Polars lazy aggregation
            pl = _get_polars()
            lf = self._get_lazy_frame()
            a_expr = pl.col(column_a).cast(pl.Float64, strict=False)
            b_expr = pl.col(column_b).cast(pl.Float64, strict=False)
            diff = a_expr - b_expr
            clean = pl.when(diff.is_finite()).then(diff).otherwise(None)

            agg = lf.select([
                clean.count().alias("n"),
                clean.mean().alias("mean"),
                clean.std(ddof=1).alias("std"),
                clean.sum().alias("sum"),
                (clean * clean).sum().alias("sum_sq"),
                clean.min().alias("min"),
                clean.max().alias("max"),
            ]).collect()

            row = agg.to_dicts()[0] if agg.height > 0 else {}
            n = row.get("n") or 0
            if n == 0:
                return {k: float('nan') for k in ['n', 'mean', 'std', 'sum', 'sum_sq', 'min', 'max']}
            return {
                'n': int(n),
                'mean': float(row.get("mean")) if row.get("mean") is not None else float('nan'),
                'std': float(row.get("std")) if row.get("std") is not None else float('nan'),
                'sum': float(row.get("sum")) if row.get("sum") is not None else float('nan'),
                'sum_sq': float(row.get("sum_sq")) if row.get("sum_sq") is not None else float('nan'),
                'min': float(row.get("min")) if row.get("min") is not None else float('nan'),
                'max': float(row.get("max")) if row.get("max") is not None else float('nan'),
            }

    def get_anova_aggregates(
        self,
        value_column: str,
        factor_column: str
    ) -> Dict[str, Any]:
        """
        Get aggregates needed for one-way ANOVA via SQL.

        Phase 3: Computes grand mean, group means, SS_between, SS_within via SQL.

        Returns:
            Dict with grand_n, grand_mean, grand_ss, groups: {name: {n, mean, ss}}
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            vals = df[value_column].dropna()
            grand_n = len(vals)
            grand_mean = float(vals.mean()) if grand_n > 0 else float('nan')
            grand_ss = float(((vals - grand_mean) ** 2).sum()) if grand_n > 0 else float('nan')

            groups = {}
            for group, group_df in df.groupby(factor_column):
                group_vals = group_df[value_column].dropna()
                n = len(group_vals)
                mean = float(group_vals.mean()) if n > 0 else float('nan')
                ss = float(((group_vals - mean) ** 2).sum()) if n > 0 else float('nan')
                groups[str(group)] = {'n': n, 'mean': mean, 'ss': ss}

            return {
                'grand_n': grand_n,
                'grand_mean': grand_mean,
                'grand_ss': grand_ss,
                'groups': groups,
            }
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                value_col = numeric_expr(value_column)
                factor_col = quote_identifier(factor_column)

                # Grand statistics
                grand_sql = f"""
                    SELECT COUNT({value_col}) AS n,
                           AVG({value_col}) AS mean,
                           SUM(({value_col} - (SELECT AVG({value_col}) FROM data WHERE {value_col} IS NOT NULL)) *
                               ({value_col} - (SELECT AVG({value_col}) FROM data WHERE {value_col} IS NOT NULL))) AS ss
                    FROM data
                    WHERE {value_col} IS NOT NULL
                """
                grand_row = conn.execute(grand_sql).fetchone()
                grand_n = grand_row[0] if grand_row else 0
                grand_mean = float(grand_row[1]) if grand_row and grand_row[1] is not None else float('nan')
                grand_ss = float(grand_row[2]) if grand_row and grand_row[2] is not None else float('nan')

                # Group statistics (n, mean, within-group SS)
                group_sql = f"""
                    SELECT {factor_col} AS group_val,
                           COUNT({value_col}) AS n,
                           AVG({value_col}) AS mean,
                           SUM(({value_col} - AVG({value_col}) OVER (PARTITION BY {factor_col})) *
                               ({value_col} - AVG({value_col}) OVER (PARTITION BY {factor_col}))) AS ss
                    FROM data
                    WHERE {value_col} IS NOT NULL
                    GROUP BY {factor_col}
                """
                # Note: The above SS calculation within GROUP BY is tricky in SQL
                # Simpler approach: compute group means first, then SS
                group_stats_sql = f"""
                    SELECT {factor_col} AS group_val,
                           COUNT({value_col}) AS n,
                           AVG({value_col}) AS mean
                    FROM data
                    WHERE {value_col} IS NOT NULL
                    GROUP BY {factor_col}
                """
                rows = conn.execute(group_stats_sql).fetchall()

                groups = {}
                for row in rows:
                    raw_group = row[0]
                    group = str(raw_group)
                    n = row[1]
                    mean = float(row[2]) if row[2] is not None else float('nan')
                    # Compute within-group SS via parameterized query to avoid injection/quoting issues
                    if raw_group is None:
                        ss_sql = f"""
                            SELECT SUM(({value_col} - ?) * ({value_col} - ?))
                            FROM data
                            WHERE {value_col} IS NOT NULL AND {factor_col} IS NULL
                        """
                        ss_row = conn.execute(ss_sql, [mean, mean]).fetchone()
                    else:
                        ss_sql = f"""
                            SELECT SUM(({value_col} - ?) * ({value_col} - ?))
                            FROM data
                            WHERE {value_col} IS NOT NULL AND {factor_col} = ?
                        """
                        ss_row = conn.execute(ss_sql, [mean, mean, raw_group]).fetchone()
                    ss = float(ss_row[0]) if ss_row and ss_row[0] is not None else float('nan')
                    groups[group] = {'n': n, 'mean': mean, 'ss': ss}

                return {
                    'grand_n': grand_n,
                    'grand_mean': grand_mean,
                    'grand_ss': grand_ss,
                    'groups': groups,
                }

            # Arrow/IPC/Parquet: use Polars lazy aggregation
            pl = _get_polars()
            lf = self._get_lazy_frame()
            value_expr = pl.col(value_column).cast(pl.Float64, strict=False)
            clean = pl.when(value_expr.is_finite()).then(value_expr).otherwise(None)
            factor_expr = pl.col(factor_column)

            grand_agg = lf.select([
                clean.count().alias("n"),
                clean.sum().alias("sum"),
                (clean * clean).sum().alias("sum_sq"),
                clean.mean().alias("mean"),
            ]).collect()
            grand_row = grand_agg.to_dicts()[0] if grand_agg.height > 0 else {}
            grand_n = int(grand_row.get("n") or 0)
            grand_mean = float(grand_row.get("mean")) if grand_row.get("mean") is not None else float('nan')
            if grand_n > 0 and grand_row.get("sum") is not None and grand_row.get("sum_sq") is not None:
                grand_sum = float(grand_row.get("sum"))
                grand_sum_sq = float(grand_row.get("sum_sq"))
                grand_ss = grand_sum_sq - (grand_sum * grand_sum / grand_n)
            else:
                grand_ss = float('nan')

            group_agg = (
                lf.select([
                    factor_expr.alias("group_val"),
                    clean.alias("val")
                ])
                .group_by("group_val")
                .agg([
                    pl.count("val").alias("n"),
                    pl.sum("val").alias("sum"),
                    (pl.col("val") * pl.col("val")).sum().alias("sum_sq"),
                    pl.mean("val").alias("mean"),
                ])
                .collect()
            )

            groups = {}
            for row in group_agg.to_dicts():
                n = int(row.get("n") or 0)
                sum_val = row.get("sum")
                sum_sq = row.get("sum_sq")
                mean = float(row.get("mean")) if row.get("mean") is not None else float('nan')
                if n > 0 and sum_val is not None and sum_sq is not None:
                    ss = float(sum_sq) - (float(sum_val) * float(sum_val) / n)
                else:
                    ss = float('nan')
                groups[str(row.get("group_val"))] = {'n': n, 'mean': mean, 'ss': ss}

            return {
                'grand_n': grand_n,
                'grand_mean': grand_mean,
                'grand_ss': grand_ss,
                'groups': groups,
            }

    def get_row_count(self) -> int:
        """Get total row count."""
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            return len(df)
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                result = conn.execute("SELECT COUNT(*) FROM data").fetchone()
                return result[0] if result else 0
            pl = _get_polars()
            lf = self._get_lazy_frame()
            result = lf.select(pl.len().alias("count")).collect()
            row = result.to_dicts()[0] if result.height > 0 else {}
            return int(row.get("count") or 0)

    def get_column_names(self) -> List[str]:
        """Get list of column names."""
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            return list(df.columns)
        else:
            if is_duckdb_source(self.source):
                conn = self._get_duckdb_conn()
                result = conn.execute("DESCRIBE data").fetchall()
                # Exclude internal _row_index column
                return [row[0] for row in result if row[0] != '_row_index']
            lf = self._get_lazy_frame()
            names = list(lf.schema.keys())
            return [name for name in names if name != '_row_index']

    def sample(
        self,
        n: int,
        seed: int = 42
    ) -> 'DataProvider':
        """
        Get a random sample of the data.

        For Tier 3 tests that require sampling on large datasets.

        Args:
            n: Number of rows to sample (capped at total row count)
            seed: Random seed for reproducibility

        Returns:
            New DataProvider with sampled data (always in pandas mode)
        """
        if self.mode == 'pandas':
            df = self._ensure_pandas_df()
            actual_n = min(n, len(df))
            sampled = df.sample(n=actual_n, random_state=seed)
            # Return as in-memory provider
            provider = DataProvider.__new__(DataProvider)
            provider.source = self.source
            provider.mode = 'pandas'
            provider.columns = self.columns
            provider._df = sampled
            provider._lf = None
            provider._conn = None
            return provider
        else:
            if is_duckdb_source(self.source):
                # Large dataset: sample via SQL
                conn = self._get_duckdb_conn()

                # Get row count to cap sample size
                total_rows = self.get_row_count()
                actual_n = min(n, total_rows)

                if self.columns:
                    cols = ", ".join([quote_identifier(c) for c in self.columns])
                else:
                    cols = "*"

                # DuckDB sampling with seed
                sql = f"""
                    SELECT {cols}
                    FROM data
                    USING SAMPLE {actual_n} ROWS (RESERVOIR, {seed})
                """

                sampled_df = conn.execute(sql).fetchdf()
            else:
                # Arrow/IPC/Parquet: sample via Polars lazy
                pl = _get_polars()
                lf = self._get_lazy_frame()
                total_rows = self.get_row_count()
                actual_n = min(n, total_rows)
                sampled_df = lf.sample(n=actual_n, seed=seed).collect().to_pandas()

            # Return as pandas-mode provider
            provider = DataProvider.__new__(DataProvider)
            provider.source = self.source
            provider.mode = 'pandas'
            provider.columns = self.columns
            provider._df = sampled_df
            provider._lf = None
            provider._conn = None
            return provider

    def close(self):
        """Close any open connections."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        self._lf = None
        self._df = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


def create_provider(
    arrow_path: Optional[str] = None,
    duckdb_path: Optional[str] = None,
    analysis_mode: str = 'small',
    columns: Optional[List[str]] = None
) -> DataProvider:
    """
    Factory function to create appropriate DataProvider.

    Args:
        arrow_path: Path to Arrow IPC file (small datasets)
        duckdb_path: Path to DuckDB file (large datasets)
        analysis_mode: 'small' or 'large'
        columns: Optional list of columns to load

    Returns:
        DataProvider instance configured for the dataset size
    """
    if analysis_mode == 'large' and duckdb_path:
        return DataProvider(duckdb_path, mode='lazy', columns=columns)
    elif arrow_path:
        return DataProvider(arrow_path, mode='pandas', columns=columns)
    else:
        raise ValueError("Either arrow_path or duckdb_path must be provided")
