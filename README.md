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

You need a free API key from [developer.dataplatform.knmi.nl](https://developer.dataplatform.knmi.nl/open-data-api). Put it in `config/settings_local.py` as `KNMI_OPEN_DATA_API_KEY`.

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

