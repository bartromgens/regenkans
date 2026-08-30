from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from django.conf import settings
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject

from radar.models import EnsembleForecast
from radar.netcdf import EnsembleGridInfo, read_probability_of_precipitation
from radar.render import read_cached_bbox

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
        / f"{stem}_{lead_minutes}_pop01.png"
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
        Image.fromarray(rgba, mode="RGBA").save(cache_path)
        _write_cached_bbox(cache_path, bbox)
        return RenderedProbabilityFrame(path=cache_path, bbox=bbox)


def _warp_and_colormap(
    pop: np.ndarray,
    grid: EnsembleGridInfo,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    if grid.geographic:
        return _colormap_geographic(pop, grid)

    src_crs = CRS.from_proj4(_proj4_in_meters(grid.proj4))
    src_transform = _transform_from_coords(grid.x_coords_km, grid.y_coords_km)
    dst_crs = CRS.from_epsg(4326)
    transform, width, height = calculate_default_transform(
        src_crs,
        dst_crs,
        grid.cols,
        grid.rows,
        *rasterio.transform.array_bounds(grid.rows, grid.cols, src_transform),
    )

    destination = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=pop,
        destination=destination,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=transform,
        dst_crs=dst_crs,
        resampling=Resampling.bilinear,
        src_nodata=np.nan,
        dst_nodata=np.nan,
    )

    rgba = _apply_pop_colormap(destination)
    bounds = rasterio.transform.array_bounds(height, width, transform)
    bbox = (bounds[0], bounds[1], bounds[2], bounds[3])
    return rgba, bbox


def _colormap_geographic(
    pop: np.ndarray,
    grid: EnsembleGridInfo,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    lon = np.asarray(grid.x_coords_km, dtype=np.float64)
    lat = np.asarray(grid.y_coords_km, dtype=np.float64)
    values = pop
    if len(lat) > 1 and lat[0] < lat[-1]:
        values = np.flipud(values)
    rgba = _apply_pop_colormap(values)
    lon_res = abs(float(lon[1] - lon[0])) if len(lon) > 1 else 0.01
    lat_res = abs(float(lat[1] - lat[0])) if len(lat) > 1 else 0.01
    west = float(np.min(lon)) - lon_res / 2
    east = float(np.max(lon)) + lon_res / 2
    south = float(np.min(lat)) - lat_res / 2
    north = float(np.max(lat)) + lat_res / 2
    return rgba, (west, south, east, north)


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
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    valid = np.isfinite(values) & (values >= MIN_VISIBLE_POP)
    if not np.any(valid):
        return rgba

    for index, (stop, color) in enumerate(POP_COLOR_STOPS):
        lower = stop
        upper = POP_COLOR_STOPS[index + 1][0] if index + 1 < len(POP_COLOR_STOPS) else np.inf
        mask = valid & (values >= lower) & (values < upper)
        if not np.any(mask):
            continue

        if np.isfinite(upper):
            weight = (values[mask] - lower) / (upper - lower)
            base = np.array(color, dtype=np.float32)
            next_color = np.array(POP_COLOR_STOPS[index + 1][1], dtype=np.float32)
            blended = base + (next_color - base) * weight[:, None]
            rgba[mask] = blended.astype(np.uint8)
        else:
            rgba[mask] = color

    return rgba


def _bbox_sidecar_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(".bbox")


def _write_cached_bbox(cache_path: Path, bbox: tuple[float, float, float, float]) -> None:
    _bbox_sidecar_path(cache_path).write_text(",".join(str(value) for value in bbox))
