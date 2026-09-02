from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from radar.models import EnsembleForecast


class Command(BaseCommand):
    help = (
        "Delete ensemble forecast records and their downloaded NetCDF files "
        "older than --days. The most recently issued forecast is always kept, "
        "even if it is older than the cutoff, so the probability view never "
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

        latest = EnsembleForecast.objects.order_by("-issued_at").first()

        queryset = EnsembleForecast.objects.filter(issued_at__lt=cutoff)
        if latest is not None:
            queryset = queryset.exclude(pk=latest.pk)

        forecasts = list(queryset)
        if not forecasts:
            self.stdout.write("No ensemble forecasts older than cutoff to clean up.")
            return

        total_bytes = 0
        missing_files = 0
        for forecast in forecasts:
            file_path = Path(forecast.file_path) if forecast.file_path else None
            if file_path and file_path.exists():
                total_bytes += file_path.stat().st_size
            else:
                missing_files += 1

        freed_mb = total_bytes / (1024 * 1024)
        action = "Would delete" if dry_run else "Deleting"
        self.stdout.write(
            f"{action} {len(forecasts)} ensemble forecast(s) issued before "
            f"{cutoff.isoformat()} (~{freed_mb:.1f} MB on disk, "
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

        deleted_count, _ = EnsembleForecast.objects.filter(
            pk__in=[forecast.pk for forecast in forecasts]
        ).delete()

        self.stdout.write(
            self.style.SUCCESS(f"Deleted {len(forecasts)} ensemble forecast record(s).")
        )
