from __future__ import annotations

from dataclasses import dataclass, field

from django.conf import settings

from radar.expected import render_expected_frame
from radar.models import EnsembleForecast, RadarForecast
from radar.probability import render_probability_frame
from radar.render import render_forecast_frame


@dataclass(frozen=True)
class PrerenderResult:
    """How a pre-render pass over one forecast went.

    Errors are collected rather than raised: a frame that cannot be rendered
    now will simply be rendered on demand later, so it must never fail the
    ingest that produced an otherwise valid forecast.
    """

    rendered: int = 0
    errors: list[str] = field(default_factory=list)


def prerender_radar_forecast(forecast: RadarForecast) -> PrerenderResult:
    """Render every intensity frame the slider can request for this forecast.

    Rendering at ingest keeps the cost off the request path. Without it the
    first visitor after each five-minute ingest pays a cold render (~0.3s of
    CPU) for every frame they scrub past, on the same gunicorn workers that
    serve the rest of the API.
    """
    rendered = 0
    errors: list[str] = []

    for lead_minutes in _leads_within_horizon(forecast):
        try:
            render_forecast_frame(forecast, lead_minutes)
            rendered += 1
        except (ValueError, OSError) as exc:
            errors.append(f"intensity +{lead_minutes}m: {exc}")

    return PrerenderResult(rendered=rendered, errors=errors)


def prerender_ensemble_forecast(forecast: EnsembleForecast) -> PrerenderResult:
    """Render the probability and expected frames for this ensemble forecast.

    Both are rendered because the mode toggle switches between them without
    any further data load, so either can be the first thing a visitor sees.
    """
    rendered = 0
    errors: list[str] = []

    for lead_minutes in _leads_within_horizon(forecast):
        try:
            render_probability_frame(forecast, lead_minutes)
            rendered += 1
        except (ValueError, OSError) as exc:
            errors.append(f"probability +{lead_minutes}m: {exc}")

        try:
            render_expected_frame(forecast, lead_minutes)
            rendered += 1
        except (ValueError, OSError) as exc:
            errors.append(f"expected +{lead_minutes}m: {exc}")

    return PrerenderResult(rendered=rendered, errors=errors)


def _leads_within_horizon(forecast: RadarForecast | EnsembleForecast) -> list[int]:
    """Lead times that can end up on the slider, in ascending order.

    Steps beyond the horizon are outside the timeline window the client asks
    for, so rendering them would be pure waste.
    """
    horizon_minutes = settings.FRAME_PRERENDER_HOURS * 60
    return sorted(
        step.lead_minutes
        for step in forecast.steps.all()
        if step.lead_minutes <= horizon_minutes
    )
