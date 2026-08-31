from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from django.test import SimpleTestCase

from radar.hdf5 import DEFAULT_NODATA_THRESHOLD, pixel_to_mm_hr, read_step_array
from radar.tests.fixtures import create_sample_radar_forecast_h5


class ReadStepArrayNodataTests(SimpleTestCase):
    """Regression tests for the map-overlay rendering path: real KNMI radar
    files store 16-bit pixel values with dedicated missing-data sentinels
    (65534/65535), so values up to that range -- including heavy rain well
    above the old, incorrect 255 cutoff -- must survive as real intensities."""

    ROW = 100
    COL = 50

    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-hdf5-nodata-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_heavy_rain_value_above_255_is_kept(self):
        heavy_rain_raw_value = 417  # real observed value, ~50.04 mm/h
        path = create_sample_radar_forecast_h5(
            self.data_dir / "heavy_rain.h5",
            step_count=1,
            pixel_value_at=(self.ROW, self.COL, heavy_rain_raw_value),
        )

        mm_hr, _grid = read_step_array(path, lead_minutes=0)

        self.assertAlmostEqual(
            float(mm_hr[self.ROW, self.COL]),
            pixel_to_mm_hr(heavy_rain_raw_value),
            places=5,
        )

    def test_true_missing_data_sentinel_becomes_nan(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "missing_data.h5",
            step_count=1,
            pixel_value_at=(self.ROW, self.COL, int(DEFAULT_NODATA_THRESHOLD)),
        )

        mm_hr, _grid = read_step_array(path, lead_minutes=0)

        self.assertTrue(math.isnan(mm_hr[self.ROW, self.COL]))

    def test_zero_rain_pixels_remain_zero(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "dry.h5",
            step_count=1,
        )

        mm_hr, _grid = read_step_array(path, lead_minutes=0)

        self.assertTrue(np.all(mm_hr == 0.0))
