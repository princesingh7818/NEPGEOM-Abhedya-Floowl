# Agent Notes

## Fast setup
- Enter dev shell with `nix-shell` (Python + Flask deps + sqlite3 are provided).
- `shell.nix` asks `Would you like to run the website now?`; answer `n` to avoid auto-start.
- Run server with `python backend/server.py` (serves on `0.0.0.0:3000`, browse `http://localhost:3000`).

## Required local files
- Create `api/config.json` with `{"MAPBOX_KEY": "pk...."}`; without it, frontend shows token warning and map never initializes.
- `api/config.json` is gitignored; treat it as local-only config.
- `backend/database.sqlite` is created on startup and is gitignored.

## Architecture that matters
- Single backend entrypoint: `backend/server.py` (Flask) also serves static `frontend/` via `/` and `/<path>`.
- Frontend is plain static files (`frontend/index.html`, `frontend/app.js`, `frontend/style.css`); no frontend package/tooling is currently present.
- Region river overlay path is `frontend/app.js`: selecting/editing a region triggers live ArcGIS river fetch (`POST /api/rivers` for bounds while editing, `GET /api/regions/<id>/rivers` for persisted regions), then renders GeoJSON lines in both Mapbox source and Three.js custom layer.

## Repo constraints
- Database schema is GeoJSON-based now: `locations(id, name, geometry TEXT)` and `region(id, name, geometry TEXT)`.
- API contract is GeoJSON, not raw `lng/lat` responses:
  - `GET /api/locations`, `GET /api/regions` return `FeatureCollection`.
  - `POST /api/locations` accepts `{name, geometry: Point}` or legacy `{name, lng, lat}`.
  - `POST /api/regions` and `PUT /api/regions/<id>` accept `{name, geometry: Polygon}` or bounds `{minLng,minLat,maxLng,maxLat}`.
- Rivers endpoints are live ArcGIS FeatureServer queries returning GeoJSON `LineString` features: `GET /api/regions/<id>/rivers` (saved region geometry) and `POST /api/rivers` (ad-hoc bounds/polygon). There is no file cache and no `/api/cache-status` endpoint.

## Verification
- No test/lint/typecheck config exists; verify behavior manually while server is running.
- Minimum regression pass: add/delete a location, create/update/delete a region, click a region to load rivers, then drag region edit handles and confirm river overlay updates dynamically.
- Focused DB checks:
  - `sqlite3 backend/database.sqlite 'select id,name,json_extract(geometry, "$.type") from locations;'`
  - `sqlite3 backend/database.sqlite 'select id,name,json_extract(geometry, "$.type") from region;'`
