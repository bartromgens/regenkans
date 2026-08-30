from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import netCDF4
import numpy as np
from netCDF4 import num2date

from radar.knmi import parse_ensemble_filename_issued_at

MEMBER_DIM_NAMES = ("ens_number", "member", "ensemble", "ens", "number", "realization")
TIME_DIM_NAMES = ("time", "forecast_time", "lead_time")
SPATIAL_DIM_NAMES = (("y", "x"), ("latitude", "longitude"), ("lat", "lon"), ("nlat", "nlon"))
GEOGRAPHIC_SPATIAL_DIMS = frozenset({("lat", "lon"), ("latitude", "longitude")})
PRECIP_VAR_CANDIDATES = (
    "precip_intensity",
    "precipitation",
    "precipitation_intensity",
    "precipitation_rate",
    "rainfall_rate",
    "rainfall_intensity",
)
WGS84_PROJ4 = "+proj=longlat +datum=WGS84 +no_defs"
PROJ4_ATTR_NAMES = (
    "proj4_params",
    "projection_proj4_params",
    "spatial_ref",
    "crs_wkt",
    "proj4",
)
KNMI_ENSEMBLE_PROJ4 = (
    "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 "
    "+a=6378137 +b=6356752 +x_0=0 +y_0=0 +units=km"
)


@dataclass(frozen=True)
class EnsembleForecastStepInfo:
    lead_minutes: int
    valid_at: datetime


@dataclass(frozen=True)
class EnsembleForecastMetadata:
    rows: int
    cols: int
    proj4: str
    member_count: int
    steps: list[EnsembleForecastStepInfo]


@dataclass(frozen=True)
class EnsembleGridInfo:
    rows: int
    cols: int
    proj4: str
    x_coords_km: tuple[float, ...]
    y_coords_km: tuple[float, ...]
    geographic: bool = False


DEFAULT_POP_THRESHOLD_MM_HR = 0.1


def parse_ensemble_forecast_netcdf(path: Path | str) -> EnsembleForecastMetadata:
    file_path = Path(path)
    issued_at = parse_ensemble_filename_issued_at(file_path.name)

    with netCDF4.Dataset(file_path, "r") as dataset:
        data_var = _find_precipitation_variable(dataset)
        member_dim = _find_member_dimension(data_var)
        time_dim = _find_time_dimension(data_var)
        row_dim, col_dim = _find_spatial_dimensions(data_var)

        member_count = len(dataset.dimensions[member_dim])
        rows = len(dataset.dimensions[row_dim])
        cols = len(dataset.dimensions[col_dim])
        proj4 = _read_proj4(dataset, data_var)
        steps = _read_steps(dataset, time_dim, issued_at)

    if not steps:
        raise ValueError(f"No forecast time steps found in {file_path}")

    return EnsembleForecastMetadata(
        rows=rows,
        cols=cols,
        proj4=proj4,
        member_count=member_count,
        steps=steps,
    )


def read_probability_of_precipitation(
    path: Path | str,
    lead_minutes: int,
    *,
    threshold_mm_hr: float = DEFAULT_POP_THRESHOLD_MM_HR,
) -> tuple[np.ndarray, EnsembleGridInfo]:
    """Return PoP grid and grid metadata for one ensemble lead time."""
    file_path = Path(path)
    issued_at = parse_ensemble_filename_issued_at(file_path.name)

    with netCDF4.Dataset(file_path, "r") as dataset:
        data_var = _find_precipitation_variable(dataset)
        member_dim = _find_member_dimension(data_var)
        time_dim = _find_time_dimension(data_var)
        row_dim, col_dim = _find_spatial_dimensions(data_var)
        time_index = _time_index_for_lead(dataset, time_dim, issued_at, lead_minutes)

        member_slice = _read_member_slice_at_lead(
            data_var,
            time_dim=time_dim,
            member_dim=member_dim,
            time_index=time_index,
        )
        if np.ma.isMaskedArray(member_slice):
            members = np.ma.filled(member_slice, np.nan).astype(np.float32)
        else:
            members = np.asarray(member_slice, dtype=np.float32)
        if members.ndim != 3:
            raise ValueError(
                f"Expected member slice with 3 dimensions, got shape {members.shape}"
            )

        valid = np.isfinite(members)

        wet_count = np.count_nonzero(valid & (members >= threshold_mm_hr), axis=0)
        member_count = members.shape[0]
        pop = np.where(valid.any(axis=0), wet_count / member_count, np.nan).astype(
            np.float32
        )

        x_coords = _read_spatial_coordinate(dataset, col_dim, len(dataset.dimensions[col_dim]))
        y_coords = _read_spatial_coordinate(dataset, row_dim, len(dataset.dimensions[row_dim]))
        geographic = _is_geographic_grid(row_dim, col_dim)
        proj4 = WGS84_PROJ4 if geographic else _read_proj4(dataset, data_var)

    grid = EnsembleGridInfo(
        rows=len(y_coords),
        cols=len(x_coords),
        proj4=proj4,
        x_coords_km=tuple(float(value) for value in x_coords),
        y_coords_km=tuple(float(value) for value in y_coords),
        geographic=geographic,
    )
    return pop, grid


def _find_precipitation_variable(dataset: netCDF4.Dataset) -> netCDF4.Variable:
    for name in PRECIP_VAR_CANDIDATES:
        if name in dataset.variables:
            return dataset.variables[name]

    best: netCDF4.Variable | None = None
    best_rank = -1
    for variable in dataset.variables.values():
        if variable.ndim < 3:
            continue
        dims = set(variable.dimensions)
        has_member = any(name in dims for name in MEMBER_DIM_NAMES)
        has_time = any(name in dims for name in TIME_DIM_NAMES)
        has_spatial = any(all(axis in dims for axis in pair) for pair in SPATIAL_DIM_NAMES)
        if not has_spatial:
            continue
        rank = variable.ndim + int(has_member) + int(has_time)
        if rank > best_rank:
            best = variable
            best_rank = rank

    if best is None:
        raise ValueError("No precipitation variable found in NetCDF file")
    return best


def _find_member_dimension(variable: netCDF4.Variable) -> str:
    for name in MEMBER_DIM_NAMES:
        if name in variable.dimensions:
            return name
    raise ValueError("No ensemble member dimension found in NetCDF file")


def _find_time_dimension(variable: netCDF4.Variable) -> str:
    for name in TIME_DIM_NAMES:
        if name in variable.dimensions:
            return name
    raise ValueError("No forecast time dimension found in NetCDF file")


def _find_spatial_dimensions(variable: netCDF4.Variable) -> tuple[str, str]:
    dims = set(variable.dimensions)
    for row_name, col_name in SPATIAL_DIM_NAMES:
        if row_name in dims and col_name in dims:
            return row_name, col_name
    raise ValueError("No spatial dimensions found in NetCDF file")


def _is_geographic_grid(row_dim: str, col_dim: str) -> bool:
    return (row_dim, col_dim) in GEOGRAPHIC_SPATIAL_DIMS


def _read_proj4(dataset: netCDF4.Dataset, data_var: netCDF4.Variable) -> str:
    for attr_name in PROJ4_ATTR_NAMES:
        if hasattr(dataset, attr_name):
            value = getattr(dataset, attr_name)
            if isinstance(value, bytes):
                value = value.decode("utf-8")
            if isinstance(value, str) and value.strip():
                return _normalize_proj4(value)

    if hasattr(data_var, "grid_mapping") and data_var.grid_mapping in dataset.variables:
        mapping = dataset.variables[data_var.grid_mapping]
        for attr_name in PROJ4_ATTR_NAMES:
            if hasattr(mapping, attr_name):
                value = getattr(mapping, attr_name)
                if isinstance(value, bytes):
                    value = value.decode("utf-8")
                if isinstance(value, str) and value.strip():
                    return _normalize_proj4(value)

    return KNMI_ENSEMBLE_PROJ4


def _normalize_proj4(value: str) -> str:
    normalized = value.strip()
    if normalized.upper().startswith("PROJ.4+"):
        normalized = normalized.split("+", 1)[1]
        normalized = f"+{normalized}"
    if normalized.upper().startswith("PROJ4+"):
        normalized = normalized.split("+", 1)[1]
        normalized = f"+{normalized}"
    return normalized


def _read_steps(
    dataset: netCDF4.Dataset,
    time_dim: str,
    issued_at: datetime,
) -> list[EnsembleForecastStepInfo]:
    if time_dim not in dataset.variables:
        raise ValueError(f"Missing coordinate variable for time dimension: {time_dim}")

    time_var = dataset.variables[time_dim]
    if not hasattr(time_var, "units"):
        raise ValueError("Time coordinate is missing CF units")

    valid_times = num2date(
        time_var[:],
        units=time_var.units,
        calendar=getattr(time_var, "calendar", "standard"),
        only_use_cftime_datetimes=False,
        only_use_python_datetimes=True,
    )

    steps: list[EnsembleForecastStepInfo] = []
    for valid_at in valid_times:
        if not isinstance(valid_at, datetime):
            valid_at = valid_at.strftime("%Y-%m-%d %H:%M:%S")
            valid_at = datetime.fromisoformat(valid_at)
        if valid_at.tzinfo is None:
            valid_at = valid_at.replace(tzinfo=timezone.utc)
        else:
            valid_at = valid_at.astimezone(timezone.utc)

        lead_minutes = int(round((valid_at - issued_at).total_seconds() / 60))
        if lead_minutes <= 0:
            continue
        steps.append(
            EnsembleForecastStepInfo(
                lead_minutes=lead_minutes,
                valid_at=valid_at,
            )
        )

    return steps


def _read_spatial_coordinate(
    dataset: netCDF4.Dataset,
    dim_name: str,
    size: int,
) -> np.ndarray:
    if dim_name in dataset.variables:
        return np.array(dataset.variables[dim_name][:], dtype=np.float64)

    return np.arange(size, dtype=np.float64)


def _time_index_for_lead(
    dataset: netCDF4.Dataset,
    time_dim: str,
    issued_at: datetime,
    lead_minutes: int,
) -> int:
    if time_dim not in dataset.variables:
        raise ValueError(f"Missing coordinate variable for time dimension: {time_dim}")

    time_var = dataset.variables[time_dim]
    if not hasattr(time_var, "units"):
        raise ValueError("Time coordinate is missing CF units")

    valid_times = num2date(
        time_var[:],
        units=time_var.units,
        calendar=getattr(time_var, "calendar", "standard"),
        only_use_cftime_datetimes=False,
        only_use_python_datetimes=True,
    )

    for index, valid_at in enumerate(valid_times):
        if not isinstance(valid_at, datetime):
            valid_at = valid_at.strftime("%Y-%m-%d %H:%M:%S")
            valid_at = datetime.fromisoformat(valid_at)
        if valid_at.tzinfo is None:
            valid_at = valid_at.replace(tzinfo=timezone.utc)
        else:
            valid_at = valid_at.astimezone(timezone.utc)

        step_lead = int(round((valid_at - issued_at).total_seconds() / 60))
        if step_lead == lead_minutes:
            return index

    raise ValueError(f"Lead time +{lead_minutes}m not found in {dataset.filepath}")


def _read_member_slice_at_lead(
    data_var: netCDF4.Variable,
    *,
    time_dim: str,
    member_dim: str,
    time_index: int,
) -> np.ndarray:
    index: list[int | slice] = []
    for dim_name in data_var.dimensions:
        if dim_name == time_dim:
            index.append(time_index)
        elif dim_name == member_dim:
            index.append(slice(None))
        else:
            index.append(slice(None))
    return data_var[tuple(index)]
