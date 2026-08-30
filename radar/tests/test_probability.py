from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.test import TestCase, override_settings

from radar.models import EnsembleForecast, EnsembleForecastStep, RadarForecast, RadarForecastStep
from radar.netcdf import read_probability_of_precipitation
from radar.probability import render_probability_frame
from radar.tests.fixtures import (
    create_live_ensemble_forecast_nc,
    create_sample_ensemble_forecast_nc,
    create_sample_radar_forecast_h5,
)
from radar.timeline import build_probability_timeline


@override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-pop-test"))
class ProbabilityAggregationTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-pop-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.filename = (
            "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        )

    def test_read_probability_of_precipitation_matches_wet_member_fraction(self):
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=20,
            wet_member_count=10,
        )

        pop, grid = read_probability_of_precipitation(path, lead_minutes=5)

        self.assertEqual(grid.rows, 10)
        self.assertEqual(grid.cols, 12)
        self.assertAlmostEqual(float(pop[4, 6]), 0.5)
        self.assertAlmostEqual(float(pop[0, 0]), 0.0)

    def test_read_live_format_probability_of_precipitation(self):
        path = create_live_ensemble_forecast_nc(
            self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=3,
            member_count=20,
            wet_member_count=10,
        )

        pop, grid = read_probability_of_precipitation(path, lead_minutes=5)

        self.assertTrue(grid.geographic)
        self.assertAlmostEqual(float(pop[4, 6]), 0.5)

    def test_render_probability_frame_creates_cached_png(self):
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        EnsembleForecastStep.objects.create(
            forecast=forecast,
            lead_minutes=5,
            valid_at=datetime(2026, 8, 23, 21, 25, tzinfo=timezone.utc),
        )

        rendered = render_probability_frame(forecast, 5)

        self.assertTrue(rendered.path.exists())
        self.assertEqual(len(rendered.bbox), 4)
        self.assertTrue(rendered.path.with_suffix(".bbox").exists())

    def test_render_live_format_geographic_frame(self):
        path = create_live_ensemble_forecast_nc(
            self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 17, 55, tzinfo=timezone.utc),
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )

        rendered = render_probability_frame(forecast, 10)

        self.assertTrue(rendered.path.exists())
        west, south, east, north = rendered.bbox
        self.assertLess(west, east)
        self.assertLess(south, north)


@override_settings(
    KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-prob-timeline-radar"),
    KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-prob-timeline-ensemble"),
)
class ProbabilityTimelineTests(TestCase):
    def setUp(self):
        self.radar_dir = Path("/tmp/regenkans-prob-timeline-radar")
        self.ensemble_dir = Path("/tmp/regenkans-prob-timeline-ensemble")
        self.radar_dir.mkdir(parents=True, exist_ok=True)
        self.ensemble_dir.mkdir(parents=True, exist_ok=True)

    def test_build_probability_timeline_composes_past_intensity_and_future_pop(self):
        radar_path = create_sample_radar_forecast_h5(
            self.radar_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )
        ensemble_path = create_sample_ensemble_forecast_nc(
            self.ensemble_dir
            / "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc",
            step_count=72,
            member_count=20,
        )
        radar_issued = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        ensemble_issued = datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)

        radar = RadarForecast.objects.create(
            filename=radar_path.name,
            issued_at=radar_issued,
            file_path=str(radar_path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        for lead in range(0, 125, 5):
            RadarForecastStep.objects.create(
                forecast=radar,
                image_name=f"image{lead // 5 + 1}",
                lead_minutes=lead,
                valid_at=radar_issued + timedelta(minutes=lead),
            )

        ensemble = EnsembleForecast.objects.create(
            filename=ensemble_path.name,
            issued_at=ensemble_issued,
            file_path=str(ensemble_path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=20,
        )
        for lead in range(5, 365, 5):
            EnsembleForecastStep.objects.create(
                forecast=ensemble,
                lead_minutes=lead,
                valid_at=ensemble_issued + timedelta(minutes=lead),
            )

        now, frames, ensemble_available = build_probability_timeline(hours=6)

        self.assertTrue(ensemble_available)
        self.assertEqual(now, radar_issued)
        self.assertEqual(len(frames), 73)
        self.assertEqual(frames[0].overlay, "intensity")
        self.assertEqual(frames[1].overlay, "probability")
        self.assertTrue(frames[0].image_url.startswith("/api/radar/frames/"))
        self.assertTrue(frames[1].image_url.startswith("/api/ensemble/frames/"))
