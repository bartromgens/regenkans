from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

import h5py
import netCDF4
import numpy as np
from pyproj import Transformer

from radar.hdf5 import (
    KNMI_PROJ4_METERS,
    KnmiGridInfo,
    _read_nodata_threshold,
    pixel_to_mm_hr,
    read_knmi_grid_info,
)
from radar.models import EnsembleForecast, RadarForecast
from radar.netcdf import (
    DEFAULT_POP_THRESHOLD_MM_HR,
    EnsembleGridInfo,
    _find_member_dimension,
    _find_precipitation_variable,
    _find_spatial_dimensions,
    _find_time_dimension,
    _is_geographic_grid,
    _read_proj4,
    _read_spatial_coordinate,
    _time_index_for_lead,
    parse_ensemble_filename_issued_at,
)
from radar.probability import _proj4_in_meters
from radar.timeline import TimelineSlot, build_unified_timeline

RADAR_FRAME_URL = re.compile(r"^/api/radar/frames/(?P<filename>[^/]+)/(?P<lead>\d+)\.png$")
ENSEMBLE_FRAME_URL = re.compile(
    r"^/api/ensemble/frames/(?P<filename>[^/]+)/(?P<lead>\d+)\.png$"
)


@dataclass(frozen=True)
class PointSample:
    valid_at: str
    kind: str
    intensity: float | None
    probability: float | None
    expected: float | None


def build_point_series(lat: float, lng: float, *, hours: int = 24) -> dict:
    now, slots, _ = build_unified_timeline(hours=hours)
    radar_samplers: dict[str, _RadarFileSampler] = {}
    ensemble_sampler: _EnsemblePointSampler | None = None
    points: list[PointSample] = []

    try:
        for slot in slots:
            intensity = _sample_intensity(slot, lng, lat, radar_samplers)
            probability = None
            expected = None
            if slot.probability is not None:
                ensemble_sampler = _ensure_ensemble_sampler(
                    slot.probability.image_url,
                    lng,
                    lat,
                    ensemble_sampler,
                )
                if ensemble_sampler is not None:
                    probability = ensemble_sampler.probability_at_lead(
                        slot.probability.lead_minutes
                    )
                    expected = ensemble_sampler.expected_at_lead(
                        slot.probability.lead_minutes
                    )

            points.append(
                PointSample(
                    valid_at=slot.valid_at.isoformat(),
                    kind=slot.kind,
                    intensity=intensity,
                    probability=probability,
                    expected=expected,
                )
            )
    finally:
        for sampler in radar_samplers.values():
            sampler.close()
        if ensemble_sampler is not None:
            ensemble_sampler.close()

    return {
        "lat": lat,
        "lng": lng,
        "now": now.isoformat() if now else None,
        "points": [_serialize_point(point) for point in points],
    }


def _serialize_point(point: PointSample) -> dict:
    return {
        "valid_at": point.valid_at,
        "kind": point.kind,
        "intensity": point.intensity,
        "probability": point.probability,
        "expected": point.expected,
    }


def _sample_intensity(
    slot: TimelineSlot,
    lng: float,
    lat: float,
    radar_samplers: dict[str, _RadarFileSampler],
) -> float | None:
    if slot.intensity is None:
        return None

    match = RADAR_FRAME_URL.match(slot.intensity.image_url)
    if match is None:
        return None

    forecast = RadarForecast.objects.filter(
        filename=match.group("filename"),
        status=RadarForecast.Status.PARSED,
    ).first()
    if forecast is None:
        return None

    sampler = radar_samplers.get(forecast.file_path)
    if sampler is None:
        sampler = _RadarFileSampler(Path(forecast.file_path))
        radar_samplers[forecast.file_path] = sampler

    return sampler.sample(int(match.group("lead")), lng, lat)


def _ensure_ensemble_sampler(
    image_url: str,
    lng: float,
    lat: float,
    current: _EnsemblePointSampler | None,
) -> _EnsemblePointSampler | None:
    match = ENSEMBLE_FRAME_URL.match(image_url)
    if match is None:
        return current

    forecast = EnsembleForecast.objects.filter(
        filename=match.group("filename"),
        status=EnsembleForecast.Status.PARSED,
    ).first()
    if forecast is None:
        return current

    path = Path(forecast.file_path)
    if current is not None and current.path == path:
        return current

    if current is not None:
        current.close()

    return _EnsemblePointSampler(path, lng, lat)


class _RadarFileSampler:
    def __init__(self, path: Path):
        self.path = path
        self.grid = read_knmi_grid_info(path)
        self._handle = h5py.File(path, "r")

    def close(self) -> None:
        self._handle.close()

    def sample(self, lead_minutes: int, lng: float, lat: float) -> float | None:
        indices = _radar_indices(self.grid, lng, lat)
        if indices is None:
            return None

        row, col = indices
        image_name = f"image{lead_minutes // 5 + 1}"
        if image_name not in self._handle:
            return None

        image_group = self._handle[image_name]
        raw = float(image_group["image_data"][row, col])
        if raw >= _read_nodata_threshold(image_group):
            return None
        return pixel_to_mm_hr(raw)


class _EnsemblePointSampler:
    def __init__(self, path: Path, lng: float, lat: float):
        self.path = path
        self.issued_at = parse_ensemble_filename_issued_at(path.name)
        self._dataset = netCDF4.Dataset(path, "r")
        self._data_var = _find_precipitation_variable(self._dataset)
        self._member_dim = _find_member_dimension(self._data_var)
        self._time_dim = _find_time_dimension(self._data_var)
        self._row_dim, self._col_dim = _find_spatial_dimensions(self._data_var)
        self._geographic = _is_geographic_grid(self._row_dim, self._col_dim)

        row_size = len(self._dataset.dimensions[self._row_dim])
        col_size = len(self._dataset.dimensions[self._col_dim])
        x_coords = _read_spatial_coordinate(self._dataset, self._col_dim, col_size)
        y_coords = _read_spatial_coordinate(self._dataset, self._row_dim, row_size)
        self._grid = EnsembleGridInfo(
            rows=row_size,
            cols=col_size,
            proj4=_read_proj4(self._dataset, self._data_var),
            x_coords_km=tuple(float(value) for value in x_coords),
            y_coords_km=tuple(float(value) for value in y_coords),
            geographic=self._geographic,
        )
        self._indices = _ensemble_indices(self._grid, lng, lat)

    def close(self) -> None:
        self._dataset.close()

    def probability_at_lead(
        self,
        lead_minutes: int,
        *,
        threshold_mm_hr: float = DEFAULT_POP_THRESHOLD_MM_HR,
    ) -> float | None:
        if self._indices is None:
            return None

        row, col = self._indices
        time_index = _time_index_for_lead(
            self._dataset,
            self._time_dim,
            self.issued_at,
            lead_minutes,
        )

        index: list[int | slice] = []
        for dim_name in self._data_var.dimensions:
            if dim_name == self._time_dim:
                index.append(time_index)
            elif dim_name == self._member_dim:
                index.append(slice(None))
            elif dim_name == self._row_dim:
                index.append(row)
            elif dim_name == self._col_dim:
                index.append(col)
            else:
                index.append(slice(None))

        # netCDF4 already applies scale_factor/add_offset and masks _FillValue.
        member_slice = self._data_var[tuple(index)]
        if np.ma.isMaskedArray(member_slice):
            members = np.ma.filled(member_slice, np.nan).astype(np.float32)
        else:
            members = np.asarray(member_slice, dtype=np.float32)
        if members.ndim != 1:
            raise ValueError(f"Expected 1-D member slice, got shape {members.shape}")

        valid = np.isfinite(members)
        if not np.any(valid):
            return None

        wet_count = np.count_nonzero(valid & (members >= threshold_mm_hr))
        return float(wet_count / len(members))

    def expected_at_lead(self, lead_minutes: int) -> float | None:
        if self._indices is None:
            return None

        row, col = self._indices
        time_index = _time_index_for_lead(
            self._dataset,
            self._time_dim,
            self.issued_at,
            lead_minutes,
        )

        index: list[int | slice] = []
        for dim_name in self._data_var.dimensions:
            if dim_name == self._time_dim:
                index.append(time_index)
            elif dim_name == self._member_dim:
                index.append(slice(None))
            elif dim_name == self._row_dim:
                index.append(row)
            elif dim_name == self._col_dim:
                index.append(col)
            else:
                index.append(slice(None))

        member_slice = self._data_var[tuple(index)]
        if np.ma.isMaskedArray(member_slice):
            members = np.ma.filled(member_slice, np.nan).astype(np.float32)
        else:
            members = np.asarray(member_slice, dtype=np.float32)
        if members.ndim != 1:
            raise ValueError(f"Expected 1-D member slice, got shape {members.shape}")

        valid = np.isfinite(members)
        if not np.any(valid):
            return None

        return float(np.nanmean(members))


def _radar_indices(grid: KnmiGridInfo, lng: float, lat: float) -> tuple[int, int] | None:
    # The source grid uses `from_origin(0, -geo_row_offset * 1000, 1000, 1000)`
    # (see radar/render.py), which places pixel *corners* at multiples of 1000 m:
    # pixel `col` covers x in [col * 1000, (col + 1) * 1000). Converting a
    # physical coordinate to a pixel index therefore requires floor, not round
    # (round would push the "far half" of every pixel into the wrong neighbor).
    transformer = Transformer.from_crs("EPSG:4326", KNMI_PROJ4_METERS, always_xy=True)
    x, y = transformer.transform(lng, lat)
    col = math.floor(x / 1000)
    row = math.floor((-grid.geo_row_offset * 1000 - y) / 1000)
    if row < 0 or row >= grid.rows or col < 0 or col >= grid.cols:
        return None
    return row, col


def _ensemble_indices(
    grid: EnsembleGridInfo,
    lng: float,
    lat: float,
) -> tuple[int, int] | None:
    if grid.geographic:
        lon_arr = np.asarray(grid.x_coords_km, dtype=np.float64)
        lat_arr = np.asarray(grid.y_coords_km, dtype=np.float64)
        lon_res = abs(float(lon_arr[1] - lon_arr[0])) if len(lon_arr) > 1 else 0.01
        lat_res = abs(float(lat_arr[1] - lat_arr[0])) if len(lat_arr) > 1 else 0.01
        west = float(np.min(lon_arr)) - lon_res / 2
        east = float(np.max(lon_arr)) + lon_res / 2
        south = float(np.min(lat_arr)) - lat_res / 2
        north = float(np.max(lat_arr)) + lat_res / 2
        if not (west <= lng <= east and south <= lat <= north):
            return None
        col = int(np.argmin(np.abs(lon_arr - lng)))
        row = int(np.argmin(np.abs(lat_arr - lat)))
        if row < 0 or row >= grid.rows or col < 0 or col >= grid.cols:
            return None
        return row, col

    transformer = Transformer.from_crs(
        "EPSG:4326",
        _proj4_in_meters(grid.proj4),
        always_xy=True,
    )
    x_m, y_m = transformer.transform(lng, lat)
    x_km = x_m / 1000
    y_km = y_m / 1000
    x_arr = np.asarray(grid.x_coords_km, dtype=np.float64)
    y_arr = np.asarray(grid.y_coords_km, dtype=np.float64)
    x_res = abs(float(x_arr[1] - x_arr[0])) if len(x_arr) > 1 else 1.0
    y_res = abs(float(y_arr[1] - y_arr[0])) if len(y_arr) > 1 else 1.0
    west = float(np.min(x_arr)) - x_res / 2
    east = float(np.max(x_arr)) + x_res / 2
    south = float(np.min(y_arr)) - y_res / 2
    north = float(np.max(y_arr)) + y_res / 2
    if not (west <= x_km <= east and south <= y_km <= north):
        return None
    col = int(np.argmin(np.abs(x_arr - x_km)))
    row = int(np.argmin(np.abs(y_arr - y_km)))
    if row < 0 or row >= grid.rows or col < 0 or col >= grid.cols:
        return None
    return row, col
