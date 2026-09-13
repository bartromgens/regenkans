from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from radar.frames import delete_frame_files, radar_frame_files
from radar.models import RadarForecast


class Command(BaseCommand):
    help = (
        "Delete radar forecast records, their downloaded HDF5 files and their "
        "rendered frames older than --days. The most recently issued forecast "
        "is always kept, even if it is older than the cutoff, so the map never "
        "ends up with zero data if ingestion has stalled."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=float,
            default=1,
            help="Delete forecasts issued more than this many days ago (default: 1).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be deleted without deleting anything.",
        )

    def handle(self, *args, **options):
        days = options["days"]
        dry_run = options["dry_run"]
        cutoff = timezone.now() - timedelta(days=days)

        latest = RadarForecast.objects.order_by("-issued_at").first()

        queryset = RadarForecast.objects.filter(issued_at__lt=cutoff)
        if latest is not None:
            queryset = queryset.exclude(pk=latest.pk)

        forecasts = list(queryset)
        if not forecasts:
            self.stdout.write("No radar forecasts older than cutoff to clean up.")
            return

        total_bytes = 0
        missing_files = 0
        frame_count = 0
        frames_by_forecast: dict[int, list[Path]] = {}
        for forecast in forecasts:
            file_path = Path(forecast.file_path) if forecast.file_path else None
            if file_path and file_path.exists():
                total_bytes += file_path.stat().st_size
            else:
                missing_files += 1

            frames = radar_frame_files(forecast.filename)
            frames_by_forecast[forecast.pk] = frames
            frame_count += len(frames)
            total_bytes += sum(frame.stat().st_size for frame in frames)

        freed_mb = total_bytes / (1024 * 1024)
        action = "Would delete" if dry_run else "Deleting"
        self.stdout.write(
            f"{action} {len(forecasts)} radar forecast(s) issued before "
            f"{cutoff.isoformat()} and {frame_count} rendered frame(s) "
            f"(~{freed_mb:.1f} MB on disk, "
            f"{missing_files} file(s) already missing)."
        )

        if dry_run:
            return

        for forecast in forecasts:
            file_path = Path(forecast.file_path) if forecast.file_path else None
            if file_path and file_path.exists():
                try:
                    file_path.unlink()
                except OSError as exc:
                    self.stderr.write(
                        self.style.WARNING(f"Could not delete {file_path}: {exc}")
                    )

            _freed, errors = delete_frame_files(frames_by_forecast[forecast.pk])
            for error in errors:
                self.stderr.write(self.style.WARNING(f"Could not delete {error}"))

        RadarForecast.objects.filter(
            pk__in=[forecast.pk for forecast in forecasts]
        ).delete()

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {len(forecasts)} radar forecast record(s) "
                f"and {frame_count} rendered frame(s)."
            )
        )
