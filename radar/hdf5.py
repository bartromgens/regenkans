from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np


@dataclass(frozen=True)
class RadarForecastStepInfo:
    image_name: str
    lead_minutes: int
    valid_at: datetime


@dataclass(frozen=True)
class RadarForecastMetadata:
    rows: int
    cols: int
    proj4: str
    steps: list[RadarForecastStepInfo]


@dataclass(frozen=True)
class KnmiGridInfo:
    rows: int
    cols: int
    geo_row_offset: float
    proj4: str


IMAGE_NAME_PATTERN = re.compile(r"^image(\d+)$")
H5_DATETIME_FORMAT = "%d-%b-%Y;%H:%M:%S.%f"
KNMI_PROJ4_METERS = (
    "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 "
    "+a=6378140 +b=6356750 +x_0=0 +y_0=0 +units=m"
)

# Real KNMI radar composites store 16-bit pixel values (`image_bytes_per_pixel: 2`)
# with dedicated "missing"/"out of image" sentinels given by each image's own
# `calibration_missing_data` / `calibration_out_of_image` attributes (observed as
# 65534 / 65535). Legitimate heavy-rain pixel values regularly exceed 255 (e.g. a
# raw value of 417 is a valid ~50 mm/h), so 255 is *not* a safe no-data cutoff.
DEFAULT_NODATA_THRESHOLD = 65534.0


def _read_nodata_threshold(image_group) -> float:
    calibration = image_group.get("calibration")
    if calibration is None:
        return DEFAULT_NODATA_THRESHOLD

    thresholds: list[float] = []
    for attr_name in ("calibration_missing_data", "calibration_out_of_image"):
        if attr_name in calibration.attrs:
            thresholds.append(float(np.asarray(calibration.attrs[attr_name]).reshape(-1)[0]))

    return min(thresholds) if thresholds else DEFAULT_NODATA_THRESHOLD


def _decode_attr(value: bytes | str) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def pixel_to_mm_hr(pixel_value: float) -> float:
    """Convert a raw pixel value to precipitation intensity in mm/h."""
    return float(pixel_value) * 0.01 * 12


def parse_h5_datetime(value: str) -> datetime:
    naive = datetime.strptime(value, H5_DATETIME_FORMAT)
    return naive.replace(tzinfo=timezone.utc)


def read_knmi_grid_info(path: Path | str) -> KnmiGridInfo:
    file_path = Path(path)
    with h5py.File(file_path, "r") as handle:
        geographic = handle["geographic"]
        return KnmiGridInfo(
            rows=int(geographic.attrs["geo_number_rows"][0]),
            cols=int(geographic.attrs["geo_number_columns"][0]),
            geo_row_offset=float(geographic.attrs["geo_row_offset"][0]),
            proj4=_decode_attr(
                geographic["map_projection"].attrs["projection_proj4_params"]
            ),
        )


def read_step_array(path: Path | str, lead_minutes: int) -> tuple[np.ndarray, KnmiGridInfo]:
    image_name = f"image{lead_minutes // 5 + 1}"
    file_path = Path(path)
    with h5py.File(file_path, "r") as handle:
        if image_name not in handle:
            raise ValueError(f"{image_name} not found in {file_path}")

        geographic = handle["geographic"]
        grid = KnmiGridInfo(
            rows=int(geographic.attrs["geo_number_rows"][0]),
            cols=int(geographic.attrs["geo_number_columns"][0]),
            geo_row_offset=float(geographic.attrs["geo_row_offset"][0]),
            proj4=_decode_attr(
                geographic["map_projection"].attrs["projection_proj4_params"]
            ),
        )
        image_group = handle[image_name]
        raw = np.array(image_group["image_data"], dtype=np.float32)
        nodata_threshold = _read_nodata_threshold(image_group)
        masked = np.where(raw >= nodata_threshold, np.nan, raw)
        mm_hr = masked * 0.01 * 12
        return mm_hr, grid


def parse_radar_forecast_hdf5(path: Path | str) -> RadarForecastMetadata:
    file_path = Path(path)
    with h5py.File(file_path, "r") as handle:
        geographic = handle["geographic"]
        rows = int(geographic.attrs["geo_number_rows"][0])
        cols = int(geographic.attrs["geo_number_columns"][0])
        proj4 = _decode_attr(
            geographic["map_projection"].attrs["projection_proj4_params"]
        )

        steps: list[RadarForecastStepInfo] = []
        for key in sorted(handle.keys(), key=_image_sort_key):
            match = IMAGE_NAME_PATTERN.match(key)
            if not match:
                continue

            image_group = handle[key]
            valid_at_raw = _decode_attr(image_group.attrs["image_datetime_valid"])

            image_index = int(match.group(1))
            steps.append(
                RadarForecastStepInfo(
                    image_name=key,
                    lead_minutes=(image_index - 1) * 5,
                    valid_at=parse_h5_datetime(valid_at_raw),
                )
            )

    if not steps:
        raise ValueError(f"No forecast image groups found in {file_path}")

    return RadarForecastMetadata(rows=rows, cols=cols, proj4=proj4, steps=steps)


def _image_sort_key(name: str) -> tuple[int, str]:
    match = IMAGE_NAME_PATTERN.match(name)
    if match:
        return (int(match.group(1)), name)
    return (9999, name)
