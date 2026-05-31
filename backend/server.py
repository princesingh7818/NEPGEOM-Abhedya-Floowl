from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3
import json
import os
import math
from datetime import datetime
from urllib import request as urlrequest
from urllib import parse as urlparse
from urllib.error import URLError, HTTPError

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../frontend')
app = Flask(__name__, static_folder=frontend_dir)
CORS(app)
app.url_map.strict_slashes = False

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.sqlite')
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../api/config.json')
ARCGIS_RIVERS_QUERY_URL = 'https://services-ap1.arcgis.com/iA7fZQOnjY9D67Zx/arcgis/rest/services/OSM_AS_Waterways/FeatureServer/0/query'
ARCGIS_MIN_QUERY_SPAN_DEG = 0.06
ARCGIS_QUERY_PADDING_RATIO = 0.45


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


def expanded_query_bounds(bounds, min_span_deg=ARCGIS_MIN_QUERY_SPAN_DEG, padding_ratio=ARCGIS_QUERY_PADDING_RATIO):
    span_lng = bounds['maxLng'] - bounds['minLng']
    span_lat = bounds['maxLat'] - bounds['minLat']

    center_lng = (bounds['minLng'] + bounds['maxLng']) / 2
    center_lat = (bounds['minLat'] + bounds['maxLat']) / 2

    target_span_lng = max(span_lng, min_span_deg)
    target_span_lat = max(span_lat, min_span_deg)

    half_lng = (target_span_lng / 2) * (1 + padding_ratio)
    half_lat = (target_span_lat / 2) * (1 + padding_ratio)

    return {
        'minLng': center_lng - half_lng,
        'minLat': center_lat - half_lat,
        'maxLng': center_lng + half_lng,
        'maxLat': center_lat + half_lat
    }


def _cohen_sutherland_code(x, y, bounds):
    code = 0
    if x < bounds['minLng']:
        code |= 1
    elif x > bounds['maxLng']:
        code |= 2
    if y < bounds['minLat']:
        code |= 4
    elif y > bounds['maxLat']:
        code |= 8
    return code


def clip_segment_to_bounds(p1, p2, bounds):
    x1, y1 = float(p1[0]), float(p1[1])
    x2, y2 = float(p2[0]), float(p2[1])

    code1 = _cohen_sutherland_code(x1, y1, bounds)
    code2 = _cohen_sutherland_code(x2, y2, bounds)

    while True:
        if not (code1 | code2):
            return [[x1, y1], [x2, y2]]
        if code1 & code2:
            return None

        out_code = code1 or code2
        if out_code & 8:
            if y2 == y1:
                return None
            x = x1 + (x2 - x1) * (bounds['maxLat'] - y1) / (y2 - y1)
            y = bounds['maxLat']
        elif out_code & 4:
            if y2 == y1:
                return None
            x = x1 + (x2 - x1) * (bounds['minLat'] - y1) / (y2 - y1)
            y = bounds['minLat']
        elif out_code & 2:
            if x2 == x1:
                return None
            y = y1 + (y2 - y1) * (bounds['maxLng'] - x1) / (x2 - x1)
            x = bounds['maxLng']
        else:
            if x2 == x1:
                return None
            y = y1 + (y2 - y1) * (bounds['minLng'] - x1) / (x2 - x1)
            x = bounds['minLng']

        if out_code == code1:
            x1, y1 = x, y
            code1 = _cohen_sutherland_code(x1, y1, bounds)
        else:
            x2, y2 = x, y
            code2 = _cohen_sutherland_code(x2, y2, bounds)


def clip_linestring_to_bounds(coords, bounds):
    if not isinstance(coords, list) or len(coords) < 2:
        return []

    clipped_paths = []
    current_path = []

    for i in range(len(coords) - 1):
        a = coords[i]
        b = coords[i + 1]
        if not (isinstance(a, list) and isinstance(b, list) and len(a) >= 2 and len(b) >= 2):
            continue

        segment = clip_segment_to_bounds(a, b, bounds)
        if segment is None:
            if len(current_path) >= 2:
                clipped_paths.append(current_path)
            current_path = []
            continue

        seg_start, seg_end = segment
        if not current_path:
            current_path = [seg_start, seg_end]
        else:
            last = current_path[-1]
            if abs(last[0] - seg_start[0]) < 1e-12 and abs(last[1] - seg_start[1]) < 1e-12:
                current_path.append(seg_end)
            else:
                if len(current_path) >= 2:
                    clipped_paths.append(current_path)
                current_path = [seg_start, seg_end]

    if len(current_path) >= 2:
        clipped_paths.append(current_path)

    return clipped_paths


def clip_geojson_to_bounds(geojson, bounds):
    features = []
    for feature in geojson.get('features', []):
        if not isinstance(feature, dict):
            continue
        geometry = feature.get('geometry') if isinstance(feature.get('geometry'), dict) else {}
        if geometry.get('type') != 'LineString':
            continue
        coords = geometry.get('coordinates')
        clipped_paths = clip_linestring_to_bounds(coords, bounds)

        for clipped_coords in clipped_paths:
            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'LineString',
                    'coordinates': clipped_coords
                },
                'properties': feature.get('properties', {})
            })

    return {
        'type': 'FeatureCollection',
        'features': features
    }


def arcgis_query_rivers(bounds):
    query_bounds = expanded_query_bounds(bounds)

    params = {
        'f': 'json',
        'where': "waterway IN ('river','stream','canal','drain')",
        'outFields': 'OBJECTID,name,name_en,waterway',
        'returnGeometry': 'true',
        'geometryType': 'esriGeometryEnvelope',
        'geometry': f"{query_bounds['minLng']},{query_bounds['minLat']},{query_bounds['maxLng']},{query_bounds['maxLat']}",
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outSR': '4326'
    }

    request_url = f"{ARCGIS_RIVERS_QUERY_URL}?{urlparse.urlencode(params)}"
    req = urlrequest.Request(
        request_url,
        headers={'Accept': 'application/json'},
        method='GET'
    )

    with urlrequest.urlopen(req, timeout=30) as response:
        body = response.read().decode('utf-8')
    payload = json.loads(body)

    if isinstance(payload, dict) and payload.get('error'):
        raise ValueError(payload['error'].get('message', 'ArcGIS query failed'))

    return payload


def arcgis_to_geojson(payload):
    features = []
    for element in payload.get('features', []):
        if not isinstance(element, dict):
            continue

        geometry = element.get('geometry') if isinstance(element.get('geometry'), dict) else {}
        paths = geometry.get('paths')
        if not isinstance(paths, list):
            continue

        attributes = element.get('attributes') if isinstance(element.get('attributes'), dict) else {}

        for path in paths:
            if not isinstance(path, list) or len(path) < 2:
                continue

            coords = []
            for point in path:
                if not isinstance(point, list) or len(point) < 2:
                    continue
                try:
                    coords.append([float(point[0]), float(point[1])])
                except (TypeError, ValueError):
                    continue

            if len(coords) < 2:
                continue

            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'LineString',
                    'coordinates': coords
                },
                'properties': {
                    'arcgis_id': attributes.get('OBJECTID') or attributes.get('objectid'),
                    'waterway': attributes.get('waterway'),
                    'name': attributes.get('name') or attributes.get('name_en')
                }
            })

    return {
        'type': 'FeatureCollection',
        'features': features
    }


def fetch_region_rivers(geometry):
    bounds = region_bounds_from_geometry(geometry)
    if bounds is None:
        return {'type': 'FeatureCollection', 'features': []}

    try:
        arcgis_payload = arcgis_query_rivers(bounds)
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError, ValueError) as error:
        print(f'ArcGIS rivers query failed: {error}')
        return {'type': 'FeatureCollection', 'features': []}

    rivers_geojson = arcgis_to_geojson(arcgis_payload)
    return clip_geojson_to_bounds(rivers_geojson, bounds)


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

    return jsonify({
        'type': 'Feature',
        'geometry': geometry,
        'properties': {
            'id': region_id,
            'name': name
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

    return jsonify({
        'type': 'Feature',
        'geometry': geometry,
        'properties': {
            'id': region_id,
            'name': name
        }
    })


@app.route('/api/regions/<int:region_id>/rivers', methods=['GET'], strict_slashes=False)
def region_rivers(region_id):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute('SELECT geometry FROM region WHERE id = ?', (region_id,))
    row = c.fetchone()
    conn.close()

    if row is None:
        return jsonify({'error': 'Region not found'}), 404

    try:
        geometry = json.loads(row['geometry'])
    except (TypeError, json.JSONDecodeError):
        return jsonify({'error': 'Invalid region geometry'}), 500

    rivers_geojson = fetch_region_rivers(geometry)
    return jsonify(rivers_geojson)


@app.route('/api/rivers', methods=['POST'], strict_slashes=False)
def rivers_for_geometry():
    data = request.json or {}
    geometry = parse_region_geometry_from_request(data)

    if geometry is None:
        return jsonify({'error': 'Please provide valid rectangle bounds or Polygon geometry'}), 400

    rivers_geojson = fetch_region_rivers(geometry)
    return jsonify(rivers_geojson)


@app.route('/api/export-tif', methods=['POST'], strict_slashes=False)
def export_tif():
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.io import MemoryFile

    data = request.json or {}
    geometry = parse_region_geometry_from_request(data)
    if geometry is None:
        return jsonify({'error': 'invalid bounds'}), 400

    bounds = region_bounds_from_geometry(geometry)
    if bounds is None:
        return jsonify({'error': 'invalid geometry'}), 400

    try:
        with open(CONFIG_PATH) as f:
            config = json.load(f)
        token = config.get('MAPBOX_KEY', '')
    except Exception:
        return jsonify({'error': 'cannot read config'}), 500

    if not token:
        return jsonify({'error': 'no mapbox token'}), 400

    dlat = bounds['maxLat'] - bounds['minLat']
    dlng = bounds['maxLng'] - bounds['minLng']
    if dlat <= 0 or dlng <= 0:
        return jsonify({'error': 'empty bounds'}), 400

    EARTH_CIRCUM = 40075016.686
    target_res = 5.0
    zoom = min(max(int(EARTH_CIRCUM / (target_res * 256)).bit_length() - 1, 10), 18)
    n_tiles = 2.0 ** zoom

    def lng_to_tilex(lng):
        return max(0, min(int(math.floor(n_tiles * (lng + 180.0) / 360.0)), int(n_tiles) - 1))

    def lat_to_tiley(lat):
        lat_rad = math.radians(lat)
        return max(0, min(
            int(math.floor(n_tiles * (1 - math.asinh(math.tan(lat_rad)) / math.pi) / 2)),
            int(n_tiles) - 1
        ))

    def tile_bounds(tx, ty):
        left = tx / n_tiles * 360.0 - 180.0
        right = (tx + 1) / n_tiles * 360.0 - 180.0
        top = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n_tiles))))
        bottom = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n_tiles))))
        return left, bottom, right, top

    min_x = lng_to_tilex(bounds['minLng'])
    max_x = lng_to_tilex(bounds['maxLng'])
    min_y = lat_to_tiley(bounds['maxLat'])
    max_y = lat_to_tiley(bounds['minLat'])

    if min_x > max_x or min_y > max_y:
        return jsonify({'error': 'tile computation failed'}), 400

    tiles_x = max_x - min_x + 1
    tiles_y = max_y - min_y + 1

    TILE_SIZE = 256
    width = tiles_x * TILE_SIZE
    height = tiles_y * TILE_SIZE

    left, _, _, top = tile_bounds(min_x, min_y)
    _, bottom, right, _ = tile_bounds(max_x, max_y)
    transform = from_bounds(left, bottom, right, top, width, height)

    out_arr = np.zeros((3, height, width), dtype=np.uint8)
    base_url = 'https://api.mapbox.com/v4/mapbox.satellite'

    for ty_idx, ty in enumerate(range(min_y, max_y + 1)):
        for tx_idx, tx in enumerate(range(min_x, max_x + 1)):
            url = f'{base_url}/{zoom}/{tx}/{ty}.jpg?access_token={token}'
            req = urlrequest.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            try:
                with urlrequest.urlopen(req, timeout=15) as resp:
                    tile_data = resp.read()
            except Exception:
                continue

            try:
                with MemoryFile(tile_data) as mem:
                    with mem.open() as src:
                        tile_arr = src.read()
            except Exception:
                continue

            px = tx_idx * TILE_SIZE
            py = ty_idx * TILE_SIZE
            th = min(tile_arr.shape[1], TILE_SIZE)
            tw = min(tile_arr.shape[2], TILE_SIZE)
            out_arr[0, py:py+th, px:px+tw] = tile_arr[0, :th, :tw]
            out_arr[1, py:py+th, px:px+tw] = tile_arr[1, :th, :tw]
            out_arr[2, py:py+th, px:px+tw] = tile_arr[2, :th, :tw]

    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cache')
    os.makedirs(cache_dir, exist_ok=True)

    fname = f'satellite_{datetime.now().strftime("%Y%m%d_%H%M%S")}.tif'
    fpath = os.path.join(cache_dir, fname)

    profile = {
        'driver': 'GTiff',
        'height': height,
        'width': width,
        'count': 3,
        'dtype': 'uint8',
        'crs': 'EPSG:4326',
        'transform': transform
    }

    with rasterio.open(fpath, 'w', **profile) as dst:
        dst.write(out_arr)

    return jsonify({'filename': fname, 'message': f'Saved cache/{fname}'})


@app.route('/api/simulate', methods=['POST'], strict_slashes=False)
def simulate():
    import simulation as sim

    data = request.json or {}
    geometry = parse_region_geometry_from_request(data)
    if geometry is None:
        return jsonify({'error': 'invalid bounds'}), 400

    bounds = region_bounds_from_geometry(geometry)
    if bounds is None:
        return jsonify({'error': 'invalid geometry'}), 400

    try:
        with open(CONFIG_PATH) as f:
            config = json.load(f)
        arcgis_token = config.get('ARCGIS_API', '')
    except Exception:
        arcgis_token = ''

    try:
        result = sim.run(
            bounds, arcgis_token,
            algorithm=data.get('algorithm', 'test-algo'),
            river_threshold_pct=data.get('river_threshold', 95),
            display_threshold_pct=data.get('display_threshold', 50),
            precipitation=data.get('precipitation', 25),
            duration=data.get('duration', 6),
            infiltration=data.get('infiltration', 10),
            manning_n=data.get('manning', 0.04),
            soil_type=data.get('soil', 'loam'),
            resolution=data.get('resolution', 'medium')
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify(result)


@app.route('/cache/<path:filename>')
def serve_cache(filename):
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cache')
    return send_from_directory(cache_dir, filename)

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

if __name__ == '__main__':
    print("Starting Flask server on http://localhost:3000")
    app.run(host='0.0.0.0', port=3000)
