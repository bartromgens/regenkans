from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from django.conf import settings
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject

from radar.hdf5 import KNMI_PROJ4_METERS, read_step_array
from radar.models import RadarForecast


@dataclass(frozen=True)
class RenderedFrame:
    path: Path
    bbox: tuple[float, float, float, float]


MIN_VISIBLE_MM_HR = 0.1
COLOR_STOPS = (
    (0.1, (0, 160, 246, 120)),
    (1.0, (0, 120, 215, 160)),
    (2.0, (0, 80, 180, 190)),
    (5.0, (120, 0, 180, 210)),
    (10.0, (220, 0, 80, 230)),
    (20.0, (255, 80, 0, 240)),
    (50.0, (255, 220, 0, 255)),
)


def frame_cache_path(filename: str, lead_minutes: int) -> Path:
    stem = Path(filename).stem
    return Path(settings.KNMI_RADAR_FORECAST_DATA_DIR) / "frames" / f"{stem}_{lead_minutes}.png"


def render_forecast_frame(forecast: RadarForecast, lead_minutes: int) -> RenderedFrame:
    cache_path = frame_cache_path(forecast.filename, lead_minutes)
    if cache_path.exists():
        return RenderedFrame(path=cache_path, bbox=_read_cached_bbox(cache_path))

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    mm_hr, grid = read_step_array(forecast.file_path, lead_minutes)
    rgba, bbox = _warp_and_colormap(mm_hr, grid)
    Image.fromarray(rgba, mode="RGBA").save(cache_path)
    _write_cached_bbox(cache_path, bbox)
    return RenderedFrame(path=cache_path, bbox=bbox)


def _warp_and_colormap(
    mm_hr: np.ndarray,
    grid,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    src_crs = CRS.from_proj4(KNMI_PROJ4_METERS)
    src_transform = from_origin(
        0,
        -grid.geo_row_offset * 1000,
        1000,
        1000,
    )
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
        source=mm_hr,
        destination=destination,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=transform,
        dst_crs=dst_crs,
        resampling=Resampling.bilinear,
        src_nodata=np.nan,
        dst_nodata=np.nan,
    )

    rgba = _apply_colormap(destination)
    bounds = rasterio.transform.array_bounds(height, width, transform)
    bbox = (bounds[0], bounds[1], bounds[2], bounds[3])
    return rgba, bbox


def _apply_colormap(values: np.ndarray) -> np.ndarray:
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    valid = np.isfinite(values) & (values >= MIN_VISIBLE_MM_HR)
    if not np.any(valid):
        return rgba

    channel_values = values[valid]
    for index, (stop, color) in enumerate(COLOR_STOPS):
        lower = stop
        upper = COLOR_STOPS[index + 1][0] if index + 1 < len(COLOR_STOPS) else np.inf
        mask = valid & (values >= lower) & (values < upper)
        if not np.any(mask):
            continue

        if np.isfinite(upper):
            weight = (values[mask] - lower) / (upper - lower)
            base = np.array(color, dtype=np.float32)
            next_color = np.array(COLOR_STOPS[index + 1][1], dtype=np.float32)
            blended = base + (next_color - base) * weight[:, None]
            rgba[mask] = blended.astype(np.uint8)
        else:
            rgba[mask] = color

    return rgba


def _bbox_sidecar_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(".bbox")


def _write_cached_bbox(cache_path: Path, bbox: tuple[float, float, float, float]) -> None:
    _bbox_sidecar_path(cache_path).write_text(",".join(str(v) for v in bbox))


def _read_cached_bbox(cache_path: Path) -> tuple[float, float, float, float]:
    values = _bbox_sidecar_path(cache_path).read_text().split(",")
    return float(values[0]), float(values[1]), float(values[2]), float(values[3])


def read_cached_bbox(cache_path: Path) -> tuple[float, float, float, float]:
    return _read_cached_bbox(cache_path)
