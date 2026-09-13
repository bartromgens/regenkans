from __future__ import annotations

from pathlib import Path

from django.conf import settings


def radar_frames_dir() -> Path:
    return Path(settings.KNMI_RADAR_FORECAST_DATA_DIR) / "frames"


def ensemble_frames_dir() -> Path:
    return Path(settings.KNMI_ENSEMBLE_FORECAST_DATA_DIR) / "frames"


def radar_frame_files(filename: str) -> list[Path]:
    """Every file rendered from one radar forecast."""
    return _frame_files(radar_frames_dir(), filename)


def ensemble_frame_files(filename: str) -> list[Path]:
    """Every file rendered from one ensemble forecast, both modes."""
    return _frame_files(ensemble_frames_dir(), filename)


def delete_frame_files(paths: list[Path]) -> tuple[int, list[str]]:
    """Delete rendered frames, returning the bytes freed and any errors."""
    freed_bytes = 0
    errors: list[str] = []

    for path in paths:
        try:
            freed_bytes += path.stat().st_size
            path.unlink()
        except OSError as exc:
            errors.append(f"{path}: {exc}")

    return freed_bytes, errors


def _frame_files(directory: Path, filename: str) -> list[Path]:
    """Match on the source filename's stem, which every renderer prefixes.

    This catches all of them at once -- intensity, probability and expected
    PNGs, their `.bbox` sidecars, and any `.tmp-` file left behind by an
    interrupted write. The stem is followed by `_`, so a forecast whose name
    ends with another forecast's name cannot take that one's frames with it.
    """
    if not directory.is_dir():
        return []
    return sorted(directory.glob(f"{Path(filename).stem}_*"))
