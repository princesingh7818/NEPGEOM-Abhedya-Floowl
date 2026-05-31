from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3
import json
import os

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../frontend')
app = Flask(__name__, static_folder=frontend_dir)
CORS(app)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.sqlite')
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../api/config.json')

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

    conn.commit()
    conn.close()

init_db()

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route('/api/config', methods=['GET'])
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

@app.route('/api/locations', methods=['GET', 'POST'])
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

@app.route('/api/locations/<int:loc_id>', methods=['DELETE'])
def delete_location(loc_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('DELETE FROM locations WHERE id = ?', (loc_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

if __name__ == '__main__':
    print("Starting Flask server on http://localhost:3000")
    app.run(host='0.0.0.0', port=3000)
