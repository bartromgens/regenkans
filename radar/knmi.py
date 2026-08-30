from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import requests


class KnmiApiError(Exception):
    """Raised when the KNMI Open Data API returns an error response."""


RATE_LIMIT_ERROR = "Rate Limit Exceeded"
DEFAULT_MAX_RETRIES = 5
DEFAULT_BACKOFF_BASE_SECONDS = 1.0


@dataclass(frozen=True)
class KnmiFileInfo:
    filename: str
    size: int
    created: datetime
    last_modified: datetime


class KnmiOpenDataClient:
    BASE_URL = "https://api.dataplatform.knmi.nl/open-data/v1"

    def __init__(
        self,
        api_key: str,
        dataset_name: str,
        dataset_version: str,
        *,
        max_retries: int = DEFAULT_MAX_RETRIES,
        backoff_base_seconds: float = DEFAULT_BACKOFF_BASE_SECONDS,
    ):
        self.api_key = api_key
        self.dataset_name = dataset_name
        self.dataset_version = dataset_version
        self.max_retries = max_retries
        self.backoff_base_seconds = backoff_base_seconds
        self.session = requests.Session()
        self.session.headers.update({"Authorization": api_key})

    @property
    def _files_url(self) -> str:
        return (
            f"{self.BASE_URL}/datasets/{self.dataset_name}"
            f"/versions/{self.dataset_version}/files"
        )

    def _request_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        attempt = 0
        while True:
            response = self.session.get(url, params=params, timeout=60)

            if response.status_code == 429 and attempt < self.max_retries:
                self._sleep_backoff(response, attempt)
                attempt += 1
                continue

            response.raise_for_status()
            payload = response.json()
            if "error" in payload:
                error = payload["error"]
                if _is_rate_limit_error(error) and attempt < self.max_retries:
                    self._sleep_backoff(response, attempt)
                    attempt += 1
                    continue
                raise KnmiApiError(error)
            return payload

    def _sleep_backoff(self, response: requests.Response, attempt: int) -> None:
        retry_after = response.headers.get("Retry-After")
        if retry_after is not None:
            try:
                time.sleep(float(retry_after))
                return
            except ValueError:
                pass
        time.sleep(self.backoff_base_seconds * (2**attempt))

    def list_files(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request_json(self._files_url, params=params or {})

    def iter_files(
        self,
        params: dict[str, Any] | None = None,
        *,
        max_files: int | None = None,
    ) -> Iterator[KnmiFileInfo]:
        query = dict(params or {})
        fetched = 0

        while True:
            payload = self.list_files(query)
            for item in payload.get("files", []):
                yield KnmiFileInfo(
                    filename=item["filename"],
                    size=item["size"],
                    created=_parse_iso_datetime(item["created"]),
                    last_modified=_parse_iso_datetime(item["lastModified"]),
                )
                fetched += 1
                if max_files is not None and fetched >= max_files:
                    return

            next_page_token = payload.get("nextPageToken")
            if not payload.get("isTruncated") or not next_page_token:
                return
            query["nextPageToken"] = next_page_token

    def get_latest_file(self) -> KnmiFileInfo:
        files = list(
            self.iter_files(
                {
                    "maxKeys": 1,
                    "orderBy": "created",
                    "sorting": "desc",
                }
            )
        )
        if not files:
            raise KnmiApiError("No files found in dataset")
        return files[0]

    def get_file_url(self, filename: str) -> str:
        url = f"{self._files_url}/{filename}/url"
        payload = self._request_json(url)
        download_url = payload.get("temporaryDownloadUrl")
        if not download_url:
            raise KnmiApiError(f"No download URL returned for {filename}")
        return download_url

    def download_file(self, filename: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        download_url = self.get_file_url(filename)
        # Presigned S3 URLs must not include the KNMI Authorization header.
        with requests.get(download_url, stream=True, timeout=120) as response:
            response.raise_for_status()
            with destination.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        handle.write(chunk)
        return destination


def parse_filename_issued_at(filename: str) -> datetime:
    """Parse issue time from RAD_NL25_RAC_FM_YYYYMMDDHHMM.h5 filenames."""
    stem = Path(filename).stem
    parts = stem.split("_")
    if len(parts) < 5:
        raise ValueError(f"Unexpected KNMI filename format: {filename}")
    timestamp = parts[-1]
    issued_at = datetime.strptime(timestamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return issued_at


def _parse_iso_datetime(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    if len(normalized) >= 5 and normalized[-5] in {"+", "-"} and normalized[-3] != ":":
        normalized = f"{normalized[:-2]}:{normalized[-2:]}"
    return datetime.fromisoformat(normalized)


def _is_rate_limit_error(error: str) -> bool:
    return error.strip().lower() == RATE_LIMIT_ERROR.lower()
