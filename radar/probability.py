from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from django.conf import settings
from rasterio.crs import CRS
from rasterio.transform import from_origin

from radar.colormap import apply_colormap
from radar.models import EnsembleForecast
from radar.netcdf import EnsembleGridInfo, read_probability_of_precipitation
from radar.render import _atomic_save_png, read_cached_bbox, warp_to_web_mercator
from radar.render import write_cached_bbox as _write_cached_bbox

_RENDER_LOCK = threading.Lock()


@dataclass(frozen=True)
class RenderedProbabilityFrame:
    path: Path
    bbox: tuple[float, float, float, float]


MIN_VISIBLE_POP = 0.05
POP_COLOR_STOPS = (
    (0.05, (255, 247, 188, 100)),
    (0.25, (254, 224, 139, 140)),
    (0.50, (253, 174, 97, 180)),
    (0.75, (244, 109, 67, 220)),
    (1.00, (215, 48, 39, 240)),
)


def probability_frame_cache_path(filename: str, lead_minutes: int) -> Path:
    stem = Path(filename).stem
    return (
        Path(settings.KNMI_ENSEMBLE_FORECAST_DATA_DIR)
        / "frames"
        / f"{stem}_{lead_minutes}_pop01_3857.png"
    )


def render_probability_frame(
    forecast: EnsembleForecast,
    lead_minutes: int,
) -> RenderedProbabilityFrame:
    cache_path = probability_frame_cache_path(forecast.filename, lead_minutes)
    if cache_path.exists():
        return RenderedProbabilityFrame(path=cache_path, bbox=read_cached_bbox(cache_path))

    with _RENDER_LOCK:
        if cache_path.exists():
            return RenderedProbabilityFrame(
                path=cache_path, bbox=read_cached_bbox(cache_path)
            )
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        pop, grid = read_probability_of_precipitation(forecast.file_path, lead_minutes)
        rgba, bbox = _warp_and_colormap(pop, grid)
        _write_cached_bbox(cache_path, bbox)
        _atomic_save_png(rgba, cache_path)
        return RenderedProbabilityFrame(path=cache_path, bbox=bbox)


def _warp_and_colormap(
    pop: np.ndarray,
    grid: EnsembleGridInfo,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    if grid.geographic:
        src_crs = CRS.from_epsg(4326)
        values, src_transform = _geographic_source(pop, grid)
    else:
        src_crs = CRS.from_proj4(_proj4_in_meters(grid.proj4))
        values = pop
        src_transform = _transform_from_coords(grid.x_coords_km, grid.y_coords_km)

    destination, bbox = warp_to_web_mercator(
        values,
        src_crs,
        src_transform,
        grid.rows,
        grid.cols,
    )
    return _apply_pop_colormap(destination), bbox


def _geographic_source(pop: np.ndarray, grid: EnsembleGridInfo):
    """Build a north-up EPSG:4326 array + transform for a native lon/lat grid."""
    lon = np.asarray(grid.x_coords_km, dtype=np.float64)
    lat = np.asarray(grid.y_coords_km, dtype=np.float64)
    values = pop
    if len(lat) > 1 and lat[0] < lat[-1]:
        values = np.flipud(values)
    lon_res = abs(float(lon[1] - lon[0])) if len(lon) > 1 else 0.01
    lat_res = abs(float(lat[1] - lat[0])) if len(lat) > 1 else 0.01
    west = float(np.min(lon)) - lon_res / 2
    north = float(np.max(lat)) + lat_res / 2
    return values, from_origin(west, north, lon_res, lat_res)


def _transform_from_coords(
    x_coords_km: tuple[float, ...],
    y_coords_km: tuple[float, ...],
):
    x = np.asarray(x_coords_km, dtype=np.float64)
    y = np.asarray(y_coords_km, dtype=np.float64)
    x_res_m = abs(float(x[1] - x[0])) * 1000 if len(x) > 1 else 1000.0
    y_res_m = abs(float(y[1] - y[0])) * 1000 if len(y) > 1 else 1000.0
    geo_row_offset = float(y[0])
    return from_origin(0, -geo_row_offset * 1000, x_res_m, y_res_m)


def _proj4_in_meters(proj4: str) -> str:
    return proj4.replace("+units=km", "+units=m").replace("units=km", "units=m")


def _apply_pop_colormap(values: np.ndarray) -> np.ndarray:
    return apply_colormap(values, POP_COLOR_STOPS, min_visible=MIN_VISIBLE_POP)
