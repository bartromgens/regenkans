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
    pixel_value_at: tuple[int, int, int] | None = None,
) -> Path:
    """Create a minimal KNMI-style radar forecast HDF5 file for tests.

    `pixel_value_at`, if given, is `(row, col, raw_value)` and sets that pixel's
    raw value on every step's image_data (default is an all-zero grid).
    """
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
            image_data = np.zeros((765, 700), dtype=np.uint16)
            if pixel_value_at is not None:
                row, col, raw_value = pixel_value_at
                image_data[row, col] = raw_value
            image_group.create_dataset("image_data", data=image_data)
            valid_at = issued_at + timedelta(minutes=(index - 1) * 5)
            image_group.attrs["image_datetime_valid"] = valid_at.strftime(
                "%d-%b-%Y;%H:%M:%S.%f"
            ).encode("utf-8")

            calibration = image_group.create_group("calibration")
            calibration.attrs["calibration_flag"] = b"Y"
            calibration.attrs["calibration_formulas"] = b"GEO=0.010000*PV+0.000000"
            calibration.attrs["calibration_missing_data"] = np.array([65534], dtype=np.int32)
            calibration.attrs["calibration_out_of_image"] = np.array([65535], dtype=np.int32)

    return path


def create_sample_ensemble_forecast_nc(
    path: Path,
    *,
    step_count: int = 3,
    member_count: int = 2,
    wet_member_count: int = 0,
    issued_at: datetime | None = None,
) -> Path:
    """Create a minimal KNMI-style ensemble forecast NetCDF file for tests."""
    import netCDF4 as nc
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    if issued_at is None:
        issued_at = datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)

    rows = 10
    cols = 12
    data = np.zeros((step_count, member_count, rows, cols), dtype=np.float32)
    if wet_member_count > 0:
        data[:, :wet_member_count, 4, 6] = 0.2

    with nc.Dataset(path, "w") as dataset:
        dataset.createDimension("time", step_count)
        dataset.createDimension("member", member_count)
        dataset.createDimension("y", rows)
        dataset.createDimension("x", cols)

        times = dataset.createVariable("time", "f8", ("time",))
        times.units = f"minutes since {issued_at.strftime('%Y-%m-%d %H:%M:%S')}"
        times.calendar = "standard"
        times[:] = np.arange(5, 5 + step_count * 5, 5, dtype=float)

        members = dataset.createVariable("member", "i4", ("member",))
        members[:] = np.arange(1, member_count + 1, dtype=int)

        y = dataset.createVariable("y", "f8", ("y",))
        y.units = "km"
        y[:] = np.linspace(3650.0, 3650.0 - (rows - 1), rows)

        x = dataset.createVariable("x", "f8", ("x",))
        x.units = "km"
        x[:] = np.linspace(0, cols - 1, cols)

        precipitation = dataset.createVariable(
            "precipitation",
            "f4",
            ("time", "member", "y", "x"),
            fill_value=-9999.0,
        )
        precipitation.units = "mm/h"
        precipitation.long_name = "Precipitation intensity"
        precipitation[:] = data

        dataset.proj4_params = (
            "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 "
            "+a=6378137 +b=6356752 +x_0=0 +y_0=0 +units=km"
        )

    return path


def create_live_ensemble_forecast_nc(
    path: Path,
    *,
    step_count: int = 3,
    member_count: int = 20,
    wet_member_count: int = 0,
    issued_at: datetime | None = None,
) -> Path:
    """Create a NetCDF file matching the live KNMI ensemble member schema."""
    import netCDF4 as nc

    path.parent.mkdir(parents=True, exist_ok=True)
    if issued_at is None:
        issued_at = datetime(2026, 8, 30, 17, 55, tzinfo=timezone.utc)

    rows = 10
    cols = 12
    scale_factor = 0.01
    raw = np.zeros((member_count, step_count, rows, cols), dtype=np.uint16)
    if wet_member_count > 0:
        wet_value = int(round(0.2 / scale_factor))
        raw[:wet_member_count, :, 4, 6] = wet_value

    with nc.Dataset(path, "w") as dataset:
        dataset.createDimension("ens_number", member_count)
        dataset.createDimension("time", step_count)
        dataset.createDimension("lat", rows)
        dataset.createDimension("lon", cols)

        members = dataset.createVariable("ens_number", "i8", ("ens_number",))
        members.standard_name = "realization"
        members.long_name = "ensemble member"
        members[:] = np.arange(1, member_count + 1, dtype=int)

        times = dataset.createVariable("time", "i8", ("time",))
        times.units = f"seconds since {issued_at.strftime('%Y-%m-%d %H:%M:%S')}"
        times.long_name = "forecast time"
        times[:] = np.arange(300, 300 + step_count * 300, 300, dtype=int)

        ref_time = dataset.createVariable("forecast_reference_time", "i8")
        ref_time.units = times.units
        ref_time.long_name = "forecast reference time"
        ref_time.assignValue(0)

        lat = dataset.createVariable("lat", "f8", ("lat",))
        lat.units = "degrees_north"
        lat.standard_name = "latitude"
        lat[:] = np.linspace(48.9955, 56.0065, rows)

        lon = dataset.createVariable("lon", "f8", ("lon",))
        lon.units = "degrees_east"
        lon.standard_name = "longitude"
        lon[:] = np.linspace(-0.00725, 11.28825, cols)

        precip = dataset.createVariable(
            "precip_intensity",
            "u2",
            ("ens_number", "time", "lat", "lon"),
            fill_value=np.uint16(65535),
        )
        precip.units = "mm/h"
        precip.long_name = "instantaneous precipitation rate"
        precip.grid_mapping = "latitude_longitude"
        precip.scale_factor = scale_factor
        precip.add_offset = 0.0
        precip[:] = raw

        mapping = dataset.createVariable("latitude_longitude", "f8")
        mapping.grid_mapping_name = "latitude_longitude"

    return path
