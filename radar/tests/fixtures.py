from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import h5py
import numpy as np


def create_sample_radar_forecast_h5(
    path: Path,
    *,
    step_count: int = 3,
    issued_at: datetime | None = None,
) -> Path:
    """Create a minimal KNMI-style radar forecast HDF5 file for tests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if issued_at is None:
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)

    with h5py.File(path, "w") as handle:
        geographic = handle.create_group("geographic")
        geographic.attrs["geo_row_offset"] = np.array([3650.0])
        geographic.attrs["geo_number_columns"] = np.array([700])
        geographic.attrs["geo_number_rows"] = np.array([765])

        map_projection = geographic.create_group("map_projection")
        map_projection.attrs["projection_proj4_params"] = (
            b"+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 +a=6378137 +b=6356752 +x_0=0 +y_0=0 +units=km"
        )

        for index in range(1, step_count + 1):
            image_name = f"image{index}"
            image_group = handle.create_group(image_name)
            image_group.create_dataset("image_data", data=np.zeros((765, 700), dtype=np.uint8))
            valid_at = issued_at + timedelta(minutes=(index - 1) * 5)
            image_group.attrs["image_datetime_valid"] = valid_at.strftime(
                "%d-%b-%Y;%H:%M:%S.%f"
            ).encode("utf-8")

    return path
