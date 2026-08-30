from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.test import TestCase, override_settings
from django.urls import reverse

from radar.models import RadarForecast, RadarForecastStep
from radar.tests.fixtures import create_sample_radar_forecast_h5


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-api-test"))
class RadarApiTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-api-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_timeline_endpoint_returns_composed_frames(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
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

        response = self.client.get(reverse("radar-timeline"), {"hours": 6})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["now"], issued_at.isoformat())
        self.assertEqual(len(payload["frames"]), 25)
        self.assertEqual(payload["frames"][0]["kind"], "observed")
        self.assertEqual(payload["frames"][-1]["kind"], "forecast")

    def test_frame_endpoint_renders_png(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=3,
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=issued_at,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=issued_at,
        )

        response = self.client.get(
            reverse("radar-frame", args=[path.name, 0]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertIn("X-Radar-BBox", response)
