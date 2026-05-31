from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3
import json
import os
import csv
import shutil
from datetime import datetime, timezone
from urllib import request as urlrequest
from urllib import parse as urlparse
from urllib.error import URLError, HTTPError

try:
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
except ImportError:
    np = None
    rasterio = None
    from_bounds = None

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../frontend')
app = Flask(__name__, static_folder=frontend_dir)
CORS(app)
app.url_map.strict_slashes = False

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.sqlite')
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../api/config.json')
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../cache')


def env_int(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
        return value if value > 1 else default
    except (TypeError, ValueError):
        return default


DEPTH_GRID_COLS = env_int('DEPTH_GRID_COLS', 32)
DEPTH_GRID_ROWS = env_int('DEPTH_GRID_ROWS', 32)


def reset_cache_dir():
    if os.path.isdir(CACHE_DIR):
        shutil.rmtree(CACHE_DIR)
    os.makedirs(CACHE_DIR, exist_ok=True)


def load_mapbox_key():
    if not os.path.exists(CONFIG_PATH):
        return None

    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    token = data.get('MAPBOX_KEY')
    if not token or token == 'YOUR_MAPBOX_ACCESS_TOKEN_HERE':
        return None
    return token


def region_bounds_from_geometry(geometry):
    if not geometry or geometry.get('type') != 'Polygon':
        return None

    rings = geometry.get('coordinates')
    if not isinstance(rings, list) or len(rings) == 0:
        return None

    ring = rings[0]
    if not isinstance(ring, list) or len(ring) == 0:
        return None

    lons = []
    lats = []
    for point in ring:
        if not isinstance(point, list) or len(point) != 2:
            continue
        try:
            lons.append(float(point[0]))
            lats.append(float(point[1]))
        except (TypeError, ValueError):
            continue

    if not lons or not lats:
        return None

    return {
        'minLng': min(lons),
        'minLat': min(lats),
        'maxLng': max(lons),
        'maxLat': max(lats)
    }


def mapbox_tilequery_elevation(lng, lat, token):
    query_url = (
        f"https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/{lng},{lat}.json?"
        + urlparse.urlencode({
            'layers': 'contour',
            'limit': 1,
            'access_token': token
        })
    )

    req = urlrequest.Request(query_url, headers={'Accept': 'application/json'})
    with urlrequest.urlopen(req, timeout=8) as response:
        body = response.read().decode('utf-8')
    payload = json.loads(body)
    features = payload.get('features', [])
    if not features:
        return None

    properties = features[0].get('properties', {})
    elev = properties.get('ele')
    if elev is None:
        return None

    try:
        return float(elev)
    except (TypeError, ValueError):
        return None


def depth_map_paths(region_id):
    base = os.path.join(CACHE_DIR, f'region_{region_id}_depth_map')
    return {
        'json': base + '.json',
        'csv': base + '.csv',
        'tif': base + '.tif'
    }


def write_depth_map_files(region_id, name, geometry):
    os.makedirs(CACHE_DIR, exist_ok=True)
    paths = depth_map_paths(region_id)
    bounds = region_bounds_from_geometry(geometry)

    result = {
        'region_id': region_id,
        'name': name,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'bounds': bounds,
        'grid': {
            'rows': DEPTH_GRID_ROWS,
            'cols': DEPTH_GRID_COLS
        },
        'status': 'ok',
        'message': '',
        'values_m': []
    }

    if bounds is None:
        result['status'] = 'error'
        result['message'] = 'Invalid region geometry'
    else:
        token = load_mapbox_key()
        if not token:
            result['status'] = 'error'
            result['message'] = 'MAPBOX_KEY missing or invalid; depth map not generated'
        else:
            min_lng = bounds['minLng']
            max_lng = bounds['maxLng']
            min_lat = bounds['minLat']
            max_lat = bounds['maxLat']

            lng_step = (max_lng - min_lng) / (DEPTH_GRID_COLS - 1) if DEPTH_GRID_COLS > 1 else 0
            lat_step = (max_lat - min_lat) / (DEPTH_GRID_ROWS - 1) if DEPTH_GRID_ROWS > 1 else 0

            had_error = False
            for row_idx in range(DEPTH_GRID_ROWS):
                row_values = []
                lat = max_lat - (row_idx * lat_step)

                for col_idx in range(DEPTH_GRID_COLS):
                    lng = min_lng + (col_idx * lng_step)
                    try:
                        elevation = mapbox_tilequery_elevation(lng, lat, token)
                    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError):
                        elevation = None
                        had_error = True
                    row_values.append(elevation)

                result['values_m'].append(row_values)

            if had_error:
                result['status'] = 'partial'
                result['message'] = 'Some elevation samples failed'

    with open(paths['json'], 'w', encoding='utf-8') as json_file:
        json.dump(result, json_file, indent=2)

    with open(paths['csv'], 'w', newline='', encoding='utf-8') as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(['row', 'col', 'elevation_m'])
        for row_idx, row in enumerate(result['values_m']):
            for col_idx, elev in enumerate(row):
                writer.writerow([row_idx, col_idx, '' if elev is None else elev])

    if (
        bounds is not None and
        np is not None and
        rasterio is not None and
        from_bounds is not None and
        result['values_m']
    ):
        rows = len(result['values_m'])
        cols = len(result['values_m'][0]) if rows > 0 else 0
        if rows > 0 and cols > 0:
            arr = np.full((rows, cols), np.nan, dtype='float32')
            for r_idx, row in enumerate(result['values_m']):
                for c_idx, elev in enumerate(row):
                    if elev is not None:
                        arr[r_idx, c_idx] = float(elev)

            transform = from_bounds(
                bounds['minLng'],
                bounds['minLat'],
                bounds['maxLng'],
                bounds['maxLat'],
                cols,
                rows
            )
            nodata_val = np.float32(-9999.0)
            arr_to_write = np.where(np.isnan(arr), nodata_val, arr).astype('float32')

            with rasterio.open(
                paths['tif'],
                'w',
                driver='GTiff',
                height=rows,
                width=cols,
                count=1,
                dtype='float32',
                crs='EPSG:4326',
                transform=transform,
                nodata=float(nodata_val)
            ) as dataset:
                dataset.write(arr_to_write, 1)
    else:
        if np is None or rasterio is None or from_bounds is None:
            if result['status'] == 'ok':
                result['status'] = 'partial'
            if not result['message']:
                result['message'] = 'GeoTIFF generation skipped: raster dependencies unavailable'

    return {
        'json': os.path.relpath(paths['json'], start=os.path.dirname(DB_PATH)),
        'csv': os.path.relpath(paths['csv'], start=os.path.dirname(DB_PATH)),
        'tif': os.path.relpath(paths['tif'], start=os.path.dirname(DB_PATH)) if os.path.exists(paths['tif']) else None,
        'status': result['status'],
        'message': result['message']
    }


def normalize_polygon_geometry(geometry):
    if not isinstance(geometry, dict):
        return None

    if geometry.get('type') != 'Polygon':
        return None

    coordinates = geometry.get('coordinates')
    if not isinstance(coordinates, list) or len(coordinates) == 0:
        return None

    ring = coordinates[0]
    if not isinstance(ring, list) or len(ring) < 4:
        return None

    normalized_ring = []
    for point in ring:
        if not isinstance(point, list) or len(point) != 2:
            return None
        try:
            lng = float(point[0])
            lat = float(point[1])
        except (TypeError, ValueError):
            return None
        normalized_ring.append([lng, lat])

    if normalized_ring[0] != normalized_ring[-1]:
        normalized_ring.append(normalized_ring[0])

    return {
        'type': 'Polygon',
        'coordinates': [normalized_ring]
    }


def rectangle_polygon(min_lng, min_lat, max_lng, max_lat):
    return {
        'type': 'Polygon',
        'coordinates': [[
            [min_lng, min_lat],
            [max_lng, min_lat],
            [max_lng, max_lat],
            [min_lng, max_lat],
            [min_lng, min_lat]
        ]]
    }

def normalize_point_geometry(geometry):
    if not isinstance(geometry, dict):
        return None

    if geometry.get('type') != 'Point':
        return None

    coordinates = geometry.get('coordinates')
    if not isinstance(coordinates, list) or len(coordinates) != 2:
        return None

    try:
        lng = float(coordinates[0])
        lat = float(coordinates[1])
    except (TypeError, ValueError):
        return None

    return {
        'type': 'Point',
        'coordinates': [lng, lat]
    }

def parse_geometry_from_request(data):
    geometry = normalize_point_geometry(data.get('geometry'))
    if geometry:
        return geometry

    try:
        lng = float(data.get('lng'))
        lat = float(data.get('lat'))
    except (TypeError, ValueError):
        return None

    return {
        'type': 'Point',
        'coordinates': [lng, lat]
    }


def parse_region_geometry_from_request(data):
    geometry = normalize_polygon_geometry(data.get('geometry'))
    if geometry:
        return geometry

    try:
        min_lng = float(data.get('minLng'))
        min_lat = float(data.get('minLat'))
        max_lng = float(data.get('maxLng'))
        max_lat = float(data.get('maxLat'))
    except (TypeError, ValueError):
        return None

    if min_lng > max_lng or min_lat > max_lat:
        return None

    return rectangle_polygon(min_lng, min_lat, max_lng, max_lat)

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='locations'")
    has_locations_table = c.fetchone() is not None

    if not has_locations_table:
        c.execute('''
            CREATE TABLE locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                geometry TEXT NOT NULL
            )
        ''')
    else:
        c.execute('PRAGMA table_info(locations)')
        columns = [row['name'] for row in c.fetchall()]

        if 'geometry' not in columns and 'lng' in columns and 'lat' in columns:
            c.execute('SELECT id, name, lng, lat FROM locations')
            legacy_rows = c.fetchall()

            c.execute('ALTER TABLE locations RENAME TO locations_legacy')
            c.execute('''
                CREATE TABLE locations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT,
                    geometry TEXT NOT NULL
                )
            ''')

            for row in legacy_rows:
                geometry = {
                    'type': 'Point',
                    'coordinates': [row['lng'], row['lat']]
                }
                c.execute(
                    'INSERT INTO locations (id, name, geometry) VALUES (?, ?, ?)',
                    (row['id'], row['name'], json.dumps(geometry))
                )

            c.execute('DROP TABLE locations_legacy')

    c.execute('''
        CREATE TABLE IF NOT EXISTS region (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            geometry TEXT NOT NULL
        )
    ''')

    conn.commit()
    conn.close()

reset_cache_dir()
init_db()

@app.route('/api/config', methods=['GET'], strict_slashes=False)
def get_config():
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r') as f:
                config_data = json.load(f)
                return jsonify(config_data)
        else:
            return jsonify({"MAPBOX_KEY": "YOUR_MAPBOX_ACCESS_TOKEN_HERE"})
    except Exception as e:
        return jsonify({"error": "Failed to read config"}), 500

@app.route('/api/locations', methods=['GET', 'POST'], strict_slashes=False)
def locations():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    if request.method == 'GET':
        c.execute('SELECT id, name, geometry FROM locations')
        rows = c.fetchall()
        conn.close()

        features = []
        for row in rows:
            try:
                geometry = json.loads(row['geometry'])
            except (TypeError, json.JSONDecodeError):
                continue

            features.append({
                'type': 'Feature',
                'geometry': geometry,
                'properties': {
                    'id': row['id'],
                    'name': row['name']
                }
            })

        return jsonify({
            'type': 'FeatureCollection',
            'features': features
        })

    if request.method == 'POST':
        data = request.json or {}
        name = data.get('name')
        geometry = parse_geometry_from_request(data)

        if not name or geometry is None:
            conn.close()
            return jsonify({"error": "Please provide name and Point geometry"}), 400

        c.execute('INSERT INTO locations (name, geometry) VALUES (?, ?)', (name, json.dumps(geometry)))
        conn.commit()
        last_id = c.lastrowid
        conn.close()
        return jsonify({
            'type': 'Feature',
            'geometry': geometry,
            'properties': {
                'id': last_id,
                'name': name
            }
        })

@app.route('/api/locations/<int:loc_id>', methods=['DELETE'], strict_slashes=False)
def delete_location(loc_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('DELETE FROM locations WHERE id = ?', (loc_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route('/api/regions', methods=['GET', 'POST'], strict_slashes=False)
def regions():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    if request.method == 'GET':
        c.execute('SELECT id, name, geometry FROM region')
        rows = c.fetchall()
        conn.close()

        features = []
        for row in rows:
            try:
                geometry = json.loads(row['geometry'])
            except (TypeError, json.JSONDecodeError):
                continue

            features.append({
                'type': 'Feature',
                'geometry': geometry,
                'properties': {
                    'id': row['id'],
                    'name': row['name']
                }
            })

        return jsonify({
            'type': 'FeatureCollection',
            'features': features
        })

    data = request.json or {}
    name = (data.get('name') or 'Unnamed Region').strip() or 'Unnamed Region'
    geometry = parse_region_geometry_from_request(data)

    if geometry is None:
        conn.close()
        return jsonify({'error': 'Please provide valid rectangle bounds or Polygon geometry'}), 400

    c.execute('INSERT INTO region (name, geometry) VALUES (?, ?)', (name, json.dumps(geometry)))
    conn.commit()
    region_id = c.lastrowid
    conn.close()

    depth_map = write_depth_map_files(region_id, name, geometry)

    return jsonify({
        'type': 'Feature',
        'geometry': geometry,
        'properties': {
            'id': region_id,
            'name': name,
            'depthMap': depth_map
        }
    })


@app.route('/api/regions/<int:region_id>', methods=['PUT', 'DELETE'], strict_slashes=False)
def region_item(region_id):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    if request.method == 'DELETE':
        c.execute('DELETE FROM region WHERE id = ?', (region_id,))
        conn.commit()
        conn.close()

        paths = depth_map_paths(region_id)
        for target in paths.values():
            if os.path.exists(target):
                os.remove(target)

        return jsonify({'success': True})

    data = request.json or {}
    geometry = parse_region_geometry_from_request(data)

    if geometry is None:
        conn.close()
        return jsonify({'error': 'Please provide valid rectangle bounds or Polygon geometry'}), 400

    c.execute('SELECT name FROM region WHERE id = ?', (region_id,))
    row = c.fetchone()
    if row is None:
        conn.close()
        return jsonify({'error': 'Region not found'}), 404

    name = (data.get('name') or row['name'] or 'Unnamed Region').strip() or 'Unnamed Region'
    c.execute('UPDATE region SET name = ?, geometry = ? WHERE id = ?', (name, json.dumps(geometry), region_id))
    conn.commit()
    conn.close()

    depth_map = write_depth_map_files(region_id, name, geometry)

    return jsonify({
        'type': 'Feature',
        'geometry': geometry,
        'properties': {
            'id': region_id,
            'name': name,
            'depthMap': depth_map
        }
    })


@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

if __name__ == '__main__':
    print("Starting Flask server on http://localhost:3000")
    app.run(host='0.0.0.0', port=3000)
