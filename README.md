# Regenkans

Full-stack web application with a Django + Django REST Framework backend and an Angular + Angular Material frontend.

## Prerequisites

- Python 3.12
- Node.js (see [Angular CLI requirements](https://angular.dev/reference/versions))
- `virtualenv`

## Backend setup

```bash
virtualenv --python=python3.12 env
source env/bin/activate
pip install -r requirements.txt
cp config/settings_local.py.example config/settings_local.py
python manage.py migrate
python manage.py runserver
```

The API runs at http://localhost:8000. Health check: http://localhost:8000/api/health/

## Frontend setup

```bash
cd client
npm install
npm start
```

The frontend runs at http://localhost:4200 and proxies `/api` requests to the Django backend during development.

## Project structure

```
regenkans/
├── manage.py
├── requirements.txt
├── config/          # Django project settings
├── api/             # Django REST API
└── client/          # Angular frontend
```
