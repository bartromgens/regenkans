# Regenkans

Regenkans is a rain radar map for the Netherlands. Like other radar apps, it shows where it is raining right now and how heavy the rain is. What makes it different is the **probability view**: instead of showing one forecast, it shows how likely rain is at each location, based on many forecast runs combined. That helps answer not just "will it rain?" but "how sure are we?"

The backend downloads weather data from KNMI (the Dutch weather institute), processes it, and serves it through an API. The frontend shows the data on an interactive map with a time slider, so you can move through time and switch between intensity and probability.

## How it works

1. **Download** — Django management commands fetch the latest files from the KNMI Open Data API.
2. **Process** — Radar files (HDF5) and ensemble forecast files (NetCDF) are parsed. Metadata is stored in the database. Map images are rendered on demand as PNG overlays.
3. **Serve** — The API combines past radar observations, a short-term rain forecast (nowcast), and rain probability into one timeline.
4. **Show** — The Angular app loads the timeline and draws frames on a MapLibre map. Use the slider to move through time, and switch between **intensity** (how hard it rains) and **probability** (how likely rain is).

## Data

All weather data comes from the [KNMI Data Platform Open Data API](https://api.dataplatform.knmi.nl).

| Dataset | What it is | Used for |
| --- | --- | --- |
| `radar_forecast` v2.0 | Real radar images and a short rain forecast (HDF5) | Intensity view — how hard it is raining |
| `seamless_precipitation_ensemble_forecast_members` v1.0 | Many forecast runs combined (NetCDF) | Probability view — how likely rain is |

You need a free API key from [developer.dataplatform.knmi.nl](https://developer.dataplatform.knmi.nl). Put it in `config/settings_local.py` as `KNMI_OPEN_DATA_API_KEY`.

Downloaded files are stored in `data/radar_forecast/` and `data/ensemble_forecast/` (these folders are not in git). The database keeps track of which files have been ingested.

To fetch data locally:

```bash
python manage.py ingest_radar_forecast
python manage.py ingest_ensemble_forecast
```

## For developers

### Prerequisites

- Python 3.12
- Node.js (see [Angular CLI requirements](https://angular.dev/reference/versions))
- `virtualenv`

### Backend

```bash
virtualenv --python=python3.12 env
source env/bin/activate
pip install -r requirements.txt
cp config/settings_local.py.example config/settings_local.py
```

Edit `config/settings_local.py` and set your KNMI API key.

```bash
python manage.py migrate
python manage.py ingest_radar_forecast
python manage.py ingest_ensemble_forecast
python manage.py runserver
```

The API runs at http://localhost:8000. Health check: http://localhost:8000/api/health/

### Frontend

In a second terminal:

```bash
cd client
npm install
npm start
```

The app runs at http://localhost:4200. During development, `/api` requests are proxied to the Django backend on port 8000.

## Deployment

Production runs as Docker Compose services (`db`, `api`, `client`) with a VPS-level nginx reverse proxy and TLS termination.

**Stack:** Django + Gunicorn (API) · Angular + nginx (client) · PostgreSQL (database)

### One-time VPS setup

1. Clone the repo to `/home/bart/regenkans` and create required directories:

```bash
git clone <repo-url> /home/bart/regenkans
cd /home/bart/regenkans
mkdir -p data/radar_forecast data/ensemble_forecast log
```

2. Create `config/settings_local.py` (not in git) with production values:

```python
DEBUG = False
SECRET_KEY = "generate-a-long-random-secret-key"
ALLOWED_HOSTS = ["regenkans.nl", "www.regenkans.nl"]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "regenkans",
        "USER": "regenkans",
        "HOST": "db",
        "PORT": "5432",
    }
}

KNMI_OPEN_DATA_API_KEY = "your-knmi-open-data-api-key"
```

3. Start the stack and run initial migrations:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec api python manage.py migrate
docker compose -f docker-compose.prod.yml exec api python manage.py createsuperuser
```

4. Configure VPS nginx and TLS using `nginx/regenkans.conf` (see comments at the top of that file for certbot setup).

5. Install cron jobs for data ingestion:

```bash
crontab -e
```

```
*/5 * * * * /home/bart/regenkans/scripts/ingest_radar.sh >> /home/bart/regenkans/log/radar_ingest.log 2>&1
*/6 * * * * /home/bart/regenkans/scripts/ingest_ensemble.sh >> /home/bart/regenkans/log/ensemble_ingest.log 2>&1
0 3 * * * /home/bart/regenkans/scripts/cleanup_ensemble.sh >> /home/bart/regenkans/log/ensemble_cleanup.log 2>&1
```

The cleanup job deletes ensemble forecast records and NetCDF files older than 1 day (only the latest ensemble forecast is ever served, so older ones are pure disk usage). It always keeps the most recently issued forecast, even if ingestion has stalled.

Log output goes to the project's own `log/` directory (already writable by the deploy user), not `/var/log`.

### Deploying updates

Before deploying, make sure all local commits are pushed to `origin/master`. Then run:

```bash
./deploy.sh
```

This SSHes into the production server, pulls the latest code, rebuilds the Docker images, restarts the containers, and runs `migrate` and `collectstatic`.

### Management commands on production

Run management commands inside the `api` container:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py <command>
```

For example, to trigger a manual data ingestion:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py ingest_radar_forecast
docker compose -f docker-compose.prod.yml exec api python manage.py ingest_ensemble_forecast
```

### Viewing production logs

Application log files are written to `./log/` on the host (mounted into the container at `/app/log`):

```bash
tail -f log/management.log   # management commands
tail -f log/django.log       # Django app / API
```

Container stdout (gunicorn and console logging):

```bash
# Follow logs from all containers
docker compose -f docker-compose.prod.yml logs -f

# Follow logs from a specific container (api, client, or db)
docker compose -f docker-compose.prod.yml logs -f api
```

### Database backups

Download a production database dump to your local machine:

```bash
./backup-db.sh
```

Backups are saved to `./backups/regenkans_<timestamp>.dump`.

