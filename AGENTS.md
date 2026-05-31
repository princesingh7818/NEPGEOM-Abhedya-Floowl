# Agent Notes

## Fast setup
- Use `nix-shell` for local work; it provides Python + Flask + sqlite3.
- `shell.nix` has an interactive `shellHook` prompt (`Would you like to run the website now?`). Reply `n` if you just want a shell.
- Run the app with `python backend/server.py` (binds `0.0.0.0:3000`; open `http://localhost:3000`).

## Required local files
- `api/config.json` must exist with `{"MAPBOX_KEY": "pk...."}` or the frontend will show a token warning and skip map init.
- `api/config.json` is gitignored; treat it as local-only config.
- `backend/database.sqlite` is created automatically on server startup and is gitignored.

## Architecture that matters
- Backend entrypoint: `backend/server.py` (Flask).
- Frontend is static vanilla files in `frontend/` and is served directly by Flask (`/` and `/<path>` routes).
- API routes are in `backend/server.py`: `GET /api/config`, `GET|POST /api/locations`, `DELETE /api/locations/<id>`.

## Repo constraints
- Do not add Node/npm tooling (`package.json`, bundlers, `npm install`); this repo runs without Node.
- Location data schema is fixed by `init_db()` in `backend/server.py` (`locations`: `id`, `name`, `lng`, `lat`). Keep frontend/backend field names aligned.

## Verification
- No test/lint config is present; verify by running `python backend/server.py` and exercising add/delete location flows in the browser.
- Focused DB check: `sqlite3 backend/database.sqlite 'select id,name,lng,lat from locations;'`.
