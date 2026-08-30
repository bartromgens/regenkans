from __future__ import annotations

from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.dateparse import parse_datetime

from radar.knmi import KnmiApiError, KnmiOpenDataClient, parse_ensemble_filename_issued_at
from radar.models import EnsembleForecast, EnsembleForecastStep
from radar.netcdf import parse_ensemble_forecast_netcdf


class Command(BaseCommand):
    help = (
        "Ingest KNMI seamless_precipitation_ensemble_forecast_members 1.0 "
        "NetCDF ensemble files."
    )

    def add_arguments(self, parser):
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument(
            "--since",
            type=str,
            help="Ingest files created on or after this ISO8601 timestamp.",
        )
        mode.add_argument(
            "--filename",
            type=str,
            help="Ingest one specific KNMI filename.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Maximum number of files to ingest in this run.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-download and re-parse files even if already ingested.",
        )

    def handle(self, *args, **options):
        api_key = getattr(settings, "KNMI_OPEN_DATA_API_KEY", "")
        if not api_key:
            raise CommandError(
                "KNMI_OPEN_DATA_API_KEY is not configured. "
                "Set it in config/settings_local.py."
            )

        data_dir = Path(settings.KNMI_ENSEMBLE_FORECAST_DATA_DIR)
        client = KnmiOpenDataClient(
            api_key=api_key,
            dataset_name=settings.KNMI_ENSEMBLE_FORECAST_DATASET,
            dataset_version=settings.KNMI_ENSEMBLE_FORECAST_VERSION,
        )

        if options["filename"]:
            files = self._files_for_filename(client, options["filename"])
        elif options["since"]:
            files = self._files_since(client, options["since"], options["limit"])
        else:
            files = self._files_latest(client, options["limit"])

        if not files:
            self.stdout.write("No files to ingest.")
            return

        ingested = 0
        skipped = 0
        failed = 0

        for file_info in files:
            result = self._ingest_file(
                client=client,
                data_dir=data_dir,
                file_info=file_info,
                force=options["force"],
            )
            if result == "ingested":
                ingested += 1
            elif result == "skipped":
                skipped += 1
            else:
                failed += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Done. ingested={ingested} skipped={skipped} failed={failed}"
            )
        )

    def _files_latest(self, client: KnmiOpenDataClient, limit: int | None):
        params = {"maxKeys": limit or 1, "orderBy": "created", "sorting": "desc"}
        return list(client.iter_files(params, max_files=limit or 1))

    def _files_for_filename(self, client: KnmiOpenDataClient, filename: str):
        payload = client.list_files({"maxKeys": 1, "begin": filename})
        files = payload.get("files", [])
        if not files or files[0]["filename"] != filename:
            raise CommandError(f"File not found in dataset: {filename}")
        return list(
            client.iter_files(
                {"maxKeys": 1, "begin": filename},
                max_files=1,
            )
        )

    def _files_since(self, client: KnmiOpenDataClient, since: str, limit: int | None):
        since_dt = parse_datetime(since)
        if since_dt is None:
            raise CommandError(f"Invalid --since timestamp: {since}")
        if since_dt.tzinfo is None:
            raise CommandError(
                "--since must include a timezone offset, e.g. 2026-08-30T00:00:00Z"
            )

        params = {
            "orderBy": "created",
            "sorting": "asc",
            "begin": since_dt.isoformat(),
        }
        return list(client.iter_files(params, max_files=limit))

    def _ingest_file(self, client, data_dir: Path, file_info, force: bool) -> str:
        existing = EnsembleForecast.objects.filter(filename=file_info.filename).first()
        destination = data_dir / file_info.filename

        if existing and existing.status == EnsembleForecast.Status.PARSED and not force:
            self.stdout.write(f"Skipping {file_info.filename} (already parsed)")
            return "skipped"

        try:
            issued_at = parse_ensemble_filename_issued_at(file_info.filename)

            if not destination.exists() or force:
                self.stdout.write(f"Downloading {file_info.filename}...")
                client.download_file(file_info.filename, destination)
            else:
                self.stdout.write(f"Using existing file {destination}")

            metadata = parse_ensemble_forecast_netcdf(destination)

            with transaction.atomic():
                forecast, _created = EnsembleForecast.objects.update_or_create(
                    filename=file_info.filename,
                    defaults={
                        "issued_at": issued_at,
                        "knmi_created": file_info.created,
                        "knmi_last_modified": file_info.last_modified,
                        "size": file_info.size,
                        "file_path": str(destination),
                        "status": EnsembleForecast.Status.PARSED,
                        "error": "",
                        "rows": metadata.rows,
                        "cols": metadata.cols,
                        "proj4": metadata.proj4,
                        "member_count": metadata.member_count,
                    },
                )
                forecast.steps.all().delete()
                EnsembleForecastStep.objects.bulk_create(
                    [
                        EnsembleForecastStep(
                            forecast=forecast,
                            lead_minutes=step.lead_minutes,
                            valid_at=step.valid_at,
                        )
                        for step in metadata.steps
                    ]
                )

            self.stdout.write(self.style.SUCCESS(f"Ingested {file_info.filename}"))
            return "ingested"
        except (KnmiApiError, ValueError, OSError) as exc:
            try:
                issued_at = parse_ensemble_filename_issued_at(file_info.filename)
            except ValueError:
                issued_at = file_info.created

            EnsembleForecast.objects.update_or_create(
                filename=file_info.filename,
                defaults={
                    "issued_at": issued_at,
                    "knmi_created": file_info.created,
                    "knmi_last_modified": file_info.last_modified,
                    "size": file_info.size,
                    "file_path": str(destination),
                    "status": EnsembleForecast.Status.FAILED,
                    "error": str(exc),
                },
            )
            self.stderr.write(
                self.style.ERROR(f"Failed {file_info.filename}: {exc}")
            )
            return "failed"
