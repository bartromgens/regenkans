from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings

import radar.render as render_module
from radar.models import EnsembleForecast, EnsembleForecastStep, RadarForecast, RadarForecastStep
from radar.netcdf import read_probability_of_precipitation
from radar.probability import probability_frame_cache_path, render_probability_frame
from radar.tests.fixtures import (
    create_live_ensemble_forecast_nc,
    create_sample_ensemble_forecast_nc,
    create_sample_radar_forecast_h5,
)
from radar.timeline import build_probability_timeline, build_unified_timeline


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

    def test_bbox_sidecar_is_never_missing_while_png_is_visible(self):
        """Regression test for the race behind the /api/ensemble/frames/ 500s.

        A concurrent request only checks `cache_path.exists()` before
        reading the `.bbox` sidecar. If the PNG became visible before its
        sidecar was written, that concurrent request would hit a
        `FileNotFoundError`.
        """
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
            lead_minutes=10,
            valid_at=datetime(2026, 8, 23, 21, 30, tzinfo=timezone.utc),
        )

        # Make sure this test always exercises a fresh render, even on a
        # rerun where a previous pass already populated the on-disk cache.
        cache_path = probability_frame_cache_path(forecast.filename, 10)
        cache_path.unlink(missing_ok=True)
        cache_path.with_suffix(".bbox").unlink(missing_ok=True)

        observed_png_replace = False
        real_replace = render_module.os.replace

        def spying_replace(src, dst):
            nonlocal observed_png_replace
            dst_path = Path(dst)
            if dst_path.suffix == ".png":
                observed_png_replace = True
                self.assertTrue(
                    dst_path.with_suffix(".bbox").exists(),
                    "PNG became visible before its .bbox sidecar existed",
                )
            return real_replace(src, dst)

        # Use a lead time not exercised by other tests in this class so we
        # don't hit an already-cached frame left over from a previous run.
        with patch.object(render_module.os, "replace", side_effect=spying_replace):
            render_probability_frame(forecast, 10)

        self.assertTrue(observed_png_replace, "expected the PNG to be rendered")

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

    def _seed_radar_and_ensemble(self):
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
        ensemble_issued = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)

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

        return radar_issued, ensemble_issued

    def test_build_probability_timeline_composes_past_intensity_and_future_pop(self):
        radar_issued, ensemble_issued = self._seed_radar_and_ensemble()

        now, slots, ensemble_available = build_probability_timeline(hours=24)

        self.assertTrue(ensemble_available)
        self.assertEqual(now, radar_issued)
        self.assertEqual(len(slots), 73)
        self.assertEqual(slots[0].kind, "observed")
        self.assertIsNotNone(slots[0].intensity)
        self.assertIsNone(slots[0].probability)
        self.assertTrue(slots[0].intensity.image_url.startswith("/api/radar/frames/"))

        first_forecast = slots[1]
        self.assertEqual(first_forecast.kind, "forecast")
        self.assertIsNotNone(first_forecast.intensity)
        self.assertIsNotNone(first_forecast.probability)
        self.assertIsNotNone(first_forecast.expected)
        self.assertTrue(
            first_forecast.probability.image_url.startswith("/api/ensemble/frames/")
        )
        self.assertTrue(
            first_forecast.expected.image_url.startswith("/api/ensemble/expected/frames/")
        )

    def test_far_future_slots_have_probability_only(self):
        radar_issued, _ = self._seed_radar_and_ensemble()

        _, slots, _ = build_unified_timeline(hours=24)

        radar_max_valid_at = radar_issued + timedelta(minutes=120)
        far_future = [slot for slot in slots if slot.valid_at > radar_max_valid_at]

        self.assertTrue(far_future)
        self.assertTrue(all(slot.intensity is None for slot in far_future))
        self.assertTrue(all(slot.probability is not None for slot in far_future))
        self.assertTrue(all(slot.expected is not None for slot in far_future))

    def test_stale_ensemble_steps_are_not_included(self):
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

        _, slots, _ = build_unified_timeline(hours=24)

        self.assertTrue(all(slot.valid_at >= radar_issued for slot in slots if slot.kind == "forecast"))
        self.assertTrue(all(slot.probability is None for slot in slots))
