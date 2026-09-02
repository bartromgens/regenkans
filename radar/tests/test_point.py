from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from pyproj import Transformer

from radar.hdf5 import DEFAULT_NODATA_THRESHOLD, KNMI_PROJ4_METERS, pixel_to_mm_hr
from radar.models import RadarForecast, RadarForecastStep
from radar.netcdf import read_expected_precipitation, read_probability_of_precipitation
from radar.point import _EnsemblePointSampler, _radar_indices
from radar.tests.fixtures import create_live_ensemble_forecast_nc, create_sample_radar_forecast_h5


class RadarIndicesTests(TestCase):
    """Regression tests for the WGS84 -> grid pixel conversion.

    The source grid places pixel *corners* at multiples of 1000 m (see the
    `from_origin` call in radar/render.py), so converting a coordinate to a
    pixel index must floor, not round: rounding pushes the "far half" of
    every pixel into the wrong neighboring cell, which showed up as
    intensity values for a location close to, but not exactly at, the
    clicked point.
    """

    class _FakeGrid:
        def __init__(self, rows: int, cols: int, geo_row_offset: float):
            self.rows = rows
            self.cols = cols
            self.geo_row_offset = geo_row_offset

    def setUp(self):
        self.grid = self._FakeGrid(rows=765, cols=700, geo_row_offset=3650.0)
        self.transformer = Transformer.from_crs(
            KNMI_PROJ4_METERS, "EPSG:4326", always_xy=True
        )

    def _lng_lat_for_native(self, x: float, y: float) -> tuple[float, float]:
        return self.transformer.transform(x, y)

    def test_pixel_center_resolves_to_itself(self):
        row, col = 400, 300
        north = -self.grid.geo_row_offset * 1000
        x_center = col * 1000 + 500
        y_center = north - (row * 1000 + 500)
        lng, lat = self._lng_lat_for_native(x_center, y_center)

        indices = _radar_indices(self.grid, lng, lat)

        self.assertEqual(indices, (row, col))

    def test_far_edge_of_pixel_still_resolves_to_same_pixel(self):
        """A point 90% into a pixel (toward higher col/row) must not round
        into the neighboring pixel."""
        row, col = 400, 300
        north = -self.grid.geo_row_offset * 1000
        x_far = col * 1000 + 900
        y_far = north - (row * 1000 + 900)
        lng, lat = self._lng_lat_for_native(x_far, y_far)

        indices = _radar_indices(self.grid, lng, lat)

        self.assertEqual(indices, (row, col))

    def test_near_edge_of_pixel_still_resolves_to_same_pixel(self):
        """A point 10% into a pixel (toward lower col/row) must not round
        into the neighboring pixel either."""
        row, col = 400, 300
        north = -self.grid.geo_row_offset * 1000
        x_near = col * 1000 + 100
        y_near = north - (row * 1000 + 100)
        lng, lat = self._lng_lat_for_native(x_near, y_near)

        indices = _radar_indices(self.grid, lng, lat)

        self.assertEqual(indices, (row, col))

    def test_out_of_bounds_returns_none(self):
        indices = _radar_indices(self.grid, lng=-50.0, lat=80.0)
        self.assertIsNone(indices)


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-point-pixel-test"))
class RadarPointPixelAlignmentTests(TestCase):
    """End-to-end regression test: querying near the far edge of a distinct
    pixel must return that pixel's value, not a neighbor's (which is zero
    here), matching the exact bug reported ("close, but not correct")."""

    ROW = 400
    COL = 300
    RAW_VALUE = 42

    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-point-pixel-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.geo_row_offset = 3650.0

    def _lng_lat_for_native(self, x: float, y: float) -> tuple[float, float]:
        transformer = Transformer.from_crs(KNMI_PROJ4_METERS, "EPSG:4326", always_xy=True)
        return transformer.transform(x, y)

    def test_far_edge_click_returns_correct_pixel_value(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=1,
            pixel_value_at=(self.ROW, self.COL, self.RAW_VALUE),
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=issued_at,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=issued_at,
        )

        north = -self.geo_row_offset * 1000
        x_far = self.COL * 1000 + 900
        y_far = north - (self.ROW * 1000 + 900)
        lng, lat = self._lng_lat_for_native(x_far, y_far)

        response = self.client.get(reverse("radar-point"), {"lat": lat, "lng": lng, "hours": 1})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertAlmostEqual(
            payload["points"][0]["intensity"],
            pixel_to_mm_hr(self.RAW_VALUE),
            places=5,
        )


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-point-heavy-rain-test"))
class RadarPointHeavyRainTests(TestCase):
    """Regression test: real KNMI radar files store 16-bit pixel values with
    `calibration_missing_data`/`calibration_out_of_image` sentinels at
    65534/65535 -- legitimate heavy-rain values regularly exceed 255 (e.g. a
    raw value of 417 is a valid ~50 mm/h reading). Treating any value >= 255
    as "no data" (an 8-bit assumption) silently erased the heaviest rain from
    both the map overlay and the point chart."""

    ROW = 400
    COL = 300
    HEAVY_RAIN_RAW_VALUE = 417  # real observed value, ~50.04 mm/h

    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-point-heavy-rain-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.geo_row_offset = 3650.0

    def _lng_lat_for_native(self, x: float, y: float) -> tuple[float, float]:
        transformer = Transformer.from_crs(KNMI_PROJ4_METERS, "EPSG:4326", always_xy=True)
        return transformer.transform(x, y)

    def test_heavy_rain_value_above_255_is_not_treated_as_missing(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=1,
            pixel_value_at=(self.ROW, self.COL, self.HEAVY_RAIN_RAW_VALUE),
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=issued_at,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=issued_at,
        )

        north = -self.geo_row_offset * 1000
        x_center = self.COL * 1000 + 500
        y_center = north - (self.ROW * 1000 + 500)
        lng, lat = self._lng_lat_for_native(x_center, y_center)

        response = self.client.get(reverse("radar-point"), {"lat": lat, "lng": lng, "hours": 1})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertAlmostEqual(
            payload["points"][0]["intensity"],
            pixel_to_mm_hr(self.HEAVY_RAIN_RAW_VALUE),
            places=5,
        )

    def test_true_missing_data_sentinel_still_returns_none(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301446.h5",
            step_count=1,
            pixel_value_at=(self.ROW, self.COL, int(DEFAULT_NODATA_THRESHOLD)),
        )
        issued_at = datetime(2026, 8, 30, 14, 46, tzinfo=timezone.utc)
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=issued_at,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=issued_at,
        )

        north = -self.geo_row_offset * 1000
        x_center = self.COL * 1000 + 500
        y_center = north - (self.ROW * 1000 + 500)
        lng, lat = self._lng_lat_for_native(x_center, y_center)

        response = self.client.get(reverse("radar-point"), {"lat": lat, "lng": lng, "hours": 1})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIsNone(payload["points"][0]["intensity"])


class EnsemblePointSamplerScaleTests(SimpleTestCase):
    """Live KNMI files store packed uint16 precip with scale_factor=0.01.

    netCDF4 unpacks on read. Multiplying by scale_factor again made 0.2 mm/h
    look like 0.002, so only members >= 10 mm/h counted as wet and the
    location-plot PoP line stayed at or below 10%.
    """

    WET_ROW = 4
    WET_COL = 6

    def setUp(self):
        import tempfile

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)

    def test_live_format_probability_matches_pop_grid_and_wet_fraction(self):
        path = create_live_ensemble_forecast_nc(
            Path(self.tempdir.name) / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=3,
            member_count=20,
            wet_member_count=10,
        )
        pop, grid = read_probability_of_precipitation(path, lead_minutes=5)
        lat = grid.y_coords_km[self.WET_ROW]
        lng = grid.x_coords_km[self.WET_COL]

        sampler = _EnsemblePointSampler(path, lng, lat)
        self.addCleanup(sampler.close)

        self.assertAlmostEqual(sampler.probability_at_lead(5), 0.5)
        self.assertAlmostEqual(
            sampler.probability_at_lead(5),
            float(pop[self.WET_ROW, self.WET_COL]),
        )

    def test_live_format_expected_matches_grid_mean(self):
        path = create_live_ensemble_forecast_nc(
            Path(self.tempdir.name) / "KNMI_PYSTEPS_BLEND_ENS_202608301800.nc",
            step_count=3,
            member_count=20,
            wet_member_count=10,
            issued_at=datetime(2026, 8, 30, 18, 0, tzinfo=timezone.utc),
        )
        expected, grid = read_expected_precipitation(path, lead_minutes=5)
        lat = grid.y_coords_km[self.WET_ROW]
        lng = grid.x_coords_km[self.WET_COL]

        sampler = _EnsemblePointSampler(path, lng, lat)
        self.addCleanup(sampler.close)

        self.assertAlmostEqual(sampler.expected_at_lead(5), 0.1)
        self.assertAlmostEqual(
            sampler.expected_at_lead(5),
            float(expected[self.WET_ROW, self.WET_COL]),
        )
        self.assertNotEqual(
            sampler.expected_at_lead(5),
            sampler.probability_at_lead(5),
        )
