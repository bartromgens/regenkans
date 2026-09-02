from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from django.conf import settings
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin

from radar.colormap import apply_colormap
from radar.models import EnsembleForecast
from radar.netcdf import EnsembleGridInfo, read_expected_precipitation
from radar.probability import _geographic_source, _proj4_in_meters, _transform_from_coords
from radar.render import (
    COLOR_STOPS,
    MIN_VISIBLE_MM_HR,
    read_cached_bbox,
    warp_to_web_mercator,
)

_RENDER_LOCK = threading.Lock()


@dataclass(frozen=True)
class RenderedExpectedFrame:
    path: Path
    bbox: tuple[float, float, float, float]


def expected_frame_cache_path(filename: str, lead_minutes: int) -> Path:
    stem = Path(filename).stem
    return (
        Path(settings.KNMI_ENSEMBLE_FORECAST_DATA_DIR)
        / "frames"
        / f"{stem}_{lead_minutes}_expected_3857.png"
    )


def render_expected_frame(
    forecast: EnsembleForecast,
    lead_minutes: int,
) -> RenderedExpectedFrame:
    cache_path = expected_frame_cache_path(forecast.filename, lead_minutes)
    if cache_path.exists():
        return RenderedExpectedFrame(path=cache_path, bbox=read_cached_bbox(cache_path))

    with _RENDER_LOCK:
        if cache_path.exists():
            return RenderedExpectedFrame(
                path=cache_path, bbox=read_cached_bbox(cache_path)
            )
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        expected, grid = read_expected_precipitation(forecast.file_path, lead_minutes)
        rgba, bbox = _warp_and_colormap(expected, grid)
        Image.fromarray(rgba, mode="RGBA").save(cache_path)
        _write_cached_bbox(cache_path, bbox)
        return RenderedExpectedFrame(path=cache_path, bbox=bbox)


def _warp_and_colormap(
    expected: np.ndarray,
    grid: EnsembleGridInfo,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    if grid.geographic:
        src_crs = CRS.from_epsg(4326)
        values, src_transform = _geographic_source(expected, grid)
    else:
        src_crs = CRS.from_proj4(_proj4_in_meters(grid.proj4))
        values = expected
        src_transform = _transform_from_coords(grid.x_coords_km, grid.y_coords_km)

    destination, bbox = warp_to_web_mercator(
        values,
        src_crs,
        src_transform,
        grid.rows,
        grid.cols,
    )
    return apply_colormap(destination, COLOR_STOPS, min_visible=MIN_VISIBLE_MM_HR), bbox


def _bbox_sidecar_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(".bbox")


def _write_cached_bbox(cache_path: Path, bbox: tuple[float, float, float, float]) -> None:
    _bbox_sidecar_path(cache_path).write_text(",".join(str(value) for value in bbox))
