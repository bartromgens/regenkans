from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.test import TestCase, override_settings

from radar.models import RadarForecast, RadarForecastStep
from radar.render import render_forecast_frame
from radar.tests.fixtures import create_sample_radar_forecast_h5
from radar.timeline import build_timeline, build_unified_timeline


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-timeline-test"))
class TimelineTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-timeline-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_build_timeline_composes_past_and_future(self):
        older_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301435.h5",
            step_count=25,
            issued_at=datetime(2026, 8, 30, 14, 35, tzinfo=timezone.utc),
        )
        latest_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )

        for path, issued_at in (
            (older_path, datetime(2026, 8, 30, 14, 35, tzinfo=timezone.utc)),
            (latest_path, datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)),
        ):
            forecast = RadarForecast.objects.create(
                filename=path.name,
                issued_at=issued_at,
                file_path=str(path),
                status=RadarForecast.Status.PARSED,
                rows=700,
                cols=765,
            )
            for lead in range(0, 125, 5):
                RadarForecastStep.objects.create(
                    forecast=forecast,
                    image_name=f"image{lead // 5 + 1}",
                    lead_minutes=lead,
                    valid_at=issued_at + timedelta(minutes=lead),
                )

        now, slots = build_timeline(hours=24)

        self.assertEqual(now, datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc))
        self.assertEqual(len(slots), 26)
        self.assertEqual(sum(1 for slot in slots if slot.kind == "observed"), 2)
        self.assertEqual(sum(1 for slot in slots if slot.kind == "forecast"), 24)
        self.assertTrue(
            all(slot.intensity and slot.intensity.lead_minutes == 0 for slot in slots[:2])
        )
        self.assertTrue(
            all(
                slot.intensity and slot.intensity.lead_minutes > 0
                for slot in slots[2:]
            )
        )
        self.assertTrue(all(slot.probability is None for slot in slots))


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-render-test"))
class RenderTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-render-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_render_forecast_frame_creates_cached_png(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=3,
        )
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=forecast.issued_at,
        )

        rendered = render_forecast_frame(forecast, 0)

        self.assertTrue(rendered.path.exists())
        self.assertEqual(len(rendered.bbox), 4)
        self.assertTrue(rendered.path.with_suffix(".bbox").exists())
