from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from django.conf import settings
from PIL import Image
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject

from radar.colormap import apply_colormap
from radar.hdf5 import KNMI_PROJ4_METERS, read_step_array
from radar.models import RadarForecast


@dataclass(frozen=True)
class RenderedFrame:
    path: Path
    bbox: tuple[float, float, float, float]


# MapLibre's `image` source stretches the PNG linearly over the quad formed by
# the four corner coordinates *after* projecting them to Web Mercator. A frame
# rendered in EPSG:4326 is linear in latitude, not in Mercator y, so that
# stretch misplaces every interior pixel: over the Netherlands it pushed rain
# about 16 km too far north (worst around 52.5N, zero at the bbox edges).
# Rendering the frame in Web Mercator makes MapLibre's linear mapping exact.
WEB_MERCATOR_CRS = CRS.from_epsg(3857)

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
    return (
        Path(settings.KNMI_RADAR_FORECAST_DATA_DIR)
        / "frames"
        / f"{stem}_{lead_minutes}_3857.png"
    )


def warp_to_web_mercator(
    values: np.ndarray,
    src_crs: CRS,
    src_transform,
    rows: int,
    cols: int,
) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    """Reproject a source grid to Web Mercator.

    Returns the warped array plus its extent as (west, south, east, north) in
    degrees, which is what MapLibre wants for the image source corners.
    """
    transform, width, height = calculate_default_transform(
        src_crs,
        WEB_MERCATOR_CRS,
        cols,
        rows,
        *rasterio.transform.array_bounds(rows, cols, src_transform),
    )

    destination = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=np.ascontiguousarray(values, dtype=np.float32),
        destination=destination,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=transform,
        dst_crs=WEB_MERCATOR_CRS,
        resampling=Resampling.bilinear,
        src_nodata=np.nan,
        dst_nodata=np.nan,
    )

    bounds = rasterio.transform.array_bounds(height, width, transform)
    return destination, mercator_bounds_to_lnglat(bounds)


def mercator_bounds_to_lnglat(
    bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west_m, south_m, east_m, north_m = bounds
    transformer = Transformer.from_crs(WEB_MERCATOR_CRS, "EPSG:4326", always_xy=True)
    west, south = transformer.transform(west_m, south_m)
    east, north = transformer.transform(east_m, north_m)
    return (west, south, east, north)


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
    destination, bbox = warp_to_web_mercator(
        mm_hr,
        src_crs,
        src_transform,
        grid.rows,
        grid.cols,
    )
    return _apply_colormap(destination), bbox


def _apply_colormap(values: np.ndarray) -> np.ndarray:
    return apply_colormap(values, COLOR_STOPS, min_visible=MIN_VISIBLE_MM_HR)


def _bbox_sidecar_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(".bbox")


def _write_cached_bbox(cache_path: Path, bbox: tuple[float, float, float, float]) -> None:
    _bbox_sidecar_path(cache_path).write_text(",".join(str(v) for v in bbox))


def _read_cached_bbox(cache_path: Path) -> tuple[float, float, float, float]:
    values = _bbox_sidecar_path(cache_path).read_text().split(",")
    return float(values[0]), float(values[1]), float(values[2]), float(values[3])


def read_cached_bbox(cache_path: Path) -> tuple[float, float, float, float]:
    return _read_cached_bbox(cache_path)
