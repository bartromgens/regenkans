from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from django.utils import timezone

from radar.models import EnsembleForecast, RadarForecast
from radar.probability import probability_frame_cache_path
from radar.render import frame_cache_path, read_cached_bbox


FrameKind = Literal["observed", "forecast"]


@dataclass(frozen=True)
class TimelineFrame:
    valid_at: datetime
    kind: FrameKind
    issued_at: datetime
    lead_minutes: int
    filename: str
    bbox: tuple[float, float, float, float] | None = None
    overlay: Literal["intensity", "probability"] = "intensity"

    @property
    def image_url(self) -> str:
        if self.overlay == "probability":
            return f"/api/ensemble/frames/{self.filename}/{self.lead_minutes}.png"
        return f"/api/radar/frames/{self.filename}/{self.lead_minutes}.png"


def build_timeline(*, hours: int = 6) -> tuple[datetime | None, list[TimelineFrame]]:
    latest = (
        RadarForecast.objects.filter(status=RadarForecast.Status.PARSED)
        .order_by("-issued_at")
        .prefetch_related("steps")
        .first()
    )
    if latest is None:
        return None, []

    cutoff = latest.issued_at - timedelta(hours=hours)
    past_forecasts = (
        RadarForecast.objects.filter(
            status=RadarForecast.Status.PARSED,
            issued_at__gte=cutoff,
            issued_at__lte=latest.issued_at,
        )
        .prefetch_related("steps")
        .order_by("issued_at")
    )

    frames: list[TimelineFrame] = []
    for forecast in past_forecasts:
        step = _step_for_lead(forecast, 0)
        if step is None:
            continue
        frames.append(
            TimelineFrame(
                valid_at=step.valid_at,
                kind="observed",
                issued_at=forecast.issued_at,
                lead_minutes=0,
                filename=forecast.filename,
                bbox=_cached_intensity_bbox(forecast.filename, 0),
            )
        )

    for step in latest.steps.all():
        if step.lead_minutes == 0:
            continue
        frames.append(
            TimelineFrame(
                valid_at=step.valid_at,
                kind="forecast",
                issued_at=latest.issued_at,
                lead_minutes=step.lead_minutes,
                filename=latest.filename,
                bbox=_cached_intensity_bbox(latest.filename, step.lead_minutes),
            )
        )

    return latest.issued_at, frames


def build_probability_timeline(*, hours: int = 6) -> tuple[datetime | None, list[TimelineFrame], bool]:
    latest_radar = (
        RadarForecast.objects.filter(status=RadarForecast.Status.PARSED)
        .order_by("-issued_at")
        .prefetch_related("steps")
        .first()
    )
    latest_ensemble = (
        EnsembleForecast.objects.filter(status=EnsembleForecast.Status.PARSED)
        .order_by("-issued_at")
        .prefetch_related("steps")
        .first()
    )

    if latest_radar is None:
        return None, [], latest_ensemble is not None

    cutoff = latest_radar.issued_at - timedelta(hours=hours)
    past_forecasts = (
        RadarForecast.objects.filter(
            status=RadarForecast.Status.PARSED,
            issued_at__gte=cutoff,
            issued_at__lte=latest_radar.issued_at,
        )
        .prefetch_related("steps")
        .order_by("issued_at")
    )

    frames: list[TimelineFrame] = []
    for forecast in past_forecasts:
        step = _step_for_lead(forecast, 0)
        if step is None:
            continue
        frames.append(
            TimelineFrame(
                valid_at=step.valid_at,
                kind="observed",
                issued_at=forecast.issued_at,
                lead_minutes=0,
                filename=forecast.filename,
                bbox=_cached_intensity_bbox(forecast.filename, 0),
                overlay="intensity",
            )
        )

    if latest_ensemble is not None:
        for step in latest_ensemble.steps.all():
            frames.append(
                TimelineFrame(
                    valid_at=step.valid_at,
                    kind="forecast",
                    issued_at=latest_ensemble.issued_at,
                    lead_minutes=step.lead_minutes,
                    filename=latest_ensemble.filename,
                    bbox=_cached_probability_bbox(latest_ensemble.filename, step.lead_minutes),
                    overlay="probability",
                )
            )

    return latest_radar.issued_at, frames, latest_ensemble is not None


def serialize_timeline(*, hours: int = 6) -> dict:
    now, frames = build_timeline(hours=hours)
    return {
        "generated_at": timezone.now().isoformat(),
        "now": now.isoformat() if now else None,
        "frames": [
            {
                "valid_at": frame.valid_at.isoformat(),
                "kind": frame.kind,
                "issued_at": frame.issued_at.isoformat(),
                "lead_minutes": frame.lead_minutes,
                "image_url": frame.image_url,
                "overlay": frame.overlay,
                "bbox": (
                    list(frame.bbox)
                    if frame.bbox is not None
                    else None
                ),
            }
            for frame in frames
        ],
    }


def serialize_probability_timeline(*, hours: int = 6) -> dict:
    now, frames, ensemble_available = build_probability_timeline(hours=hours)
    return {
        "generated_at": timezone.now().isoformat(),
        "now": now.isoformat() if now else None,
        "ensemble_available": ensemble_available,
        "frames": [
            {
                "valid_at": frame.valid_at.isoformat(),
                "kind": frame.kind,
                "issued_at": frame.issued_at.isoformat(),
                "lead_minutes": frame.lead_minutes,
                "image_url": frame.image_url,
                "overlay": frame.overlay,
                "bbox": (
                    list(frame.bbox)
                    if frame.bbox is not None
                    else None
                ),
            }
            for frame in frames
        ],
    }


def _step_for_lead(forecast: RadarForecast, lead_minutes: int):
    for step in forecast.steps.all():
        if step.lead_minutes == lead_minutes:
            return step
    return None


def _cached_intensity_bbox(
    filename: str,
    lead_minutes: int,
) -> tuple[float, float, float, float] | None:
    cache_path = frame_cache_path(filename, lead_minutes)
    sidecar = cache_path.with_suffix(".bbox")
    if not sidecar.exists():
        return None
    return read_cached_bbox(cache_path)


def _cached_probability_bbox(
    filename: str,
    lead_minutes: int,
) -> tuple[float, float, float, float] | None:
    cache_path = probability_frame_cache_path(filename, lead_minutes)
    sidecar = cache_path.with_suffix(".bbox")
    if not sidecar.exists():
        return None
    return read_cached_bbox(cache_path)
