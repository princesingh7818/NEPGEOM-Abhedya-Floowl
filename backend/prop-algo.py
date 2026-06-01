import numpy as np
import json
import math
from urllib import request as urlrequest
from urllib import parse as urlparse


OSM_RIVERS_URL = (
    "https://services-ap1.arcgis.com/iA7fZQOnjY9D67Zx/arcgis/rest/services/"
    "OSM_AS_Waterways/FeatureServer/0/query"
)


def fetch_osm_rivers(bounds):
    geometry = {
        'xmin': bounds['minLng'], 'ymin': bounds['minLat'],
        'xmax': bounds['maxLng'], 'ymax': bounds['maxLat'],
        'spatialReference': {'wkid': 4326}
    }
    params = {
        'where': "waterway IN ('river','stream','canal','drain')",
        'outFields': 'OBJECTID,name,name_en,waterway',
        'geometry': json.dumps(geometry),
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'outSR': '4326',
        'f': 'geojson',
        'returnGeometry': 'true'
    }
    req_url = f"{OSM_RIVERS_URL}?{urlparse.urlencode(params)}"
    req = urlrequest.Request(req_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urlrequest.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def rasterize_river_geojson(geojson, transform, shape):
    ny, nx = shape
    weight_map = {'river': 1.0, 'canal': 0.5, 'stream': 0.1, 'drain': 0.0}
    inv_transform = ~transform

    river_mask = np.zeros((ny, nx), dtype=bool)
    river_weight = np.zeros((ny, nx), dtype=np.float64)

    for feature in geojson.get('features', []):
        geom = feature.get('geometry', {})
        if geom.get('type') != 'LineString':
            continue
        coords = geom['coordinates']
        waterway = feature.get('properties', {}).get('waterway', 'stream')
        w = weight_map.get(waterway, 0.1)
        if w <= 0:
            continue

        for i in range(len(coords) - 1):
            lng1, lat1 = coords[i]
            lng2, lat2 = coords[i + 1]
            col1, row1 = inv_transform * (lng1, lat1)
            col2, row2 = inv_transform * (lng2, lat2)
            c0, r0 = int(round(col1)), int(round(row1))
            c1, r1 = int(round(col2)), int(round(row2))

            dc = abs(c1 - c0)
            dr = abs(r1 - r0)
            sc = 1 if c0 < c1 else -1
            sr = 1 if r0 < r1 else -1
            err = dc - dr
            c, r = c0, r0
            while True:
                if 0 <= r < ny and 0 <= c < nx:
                    river_mask[r, c] = True
                    river_weight[r, c] = max(river_weight[r, c], w)
                if c == c1 and r == r1:
                    break
                e2 = 2 * err
                if e2 > -dr:
                    err -= dr
                    c += sc
                if e2 < dc:
                    err += dc
                    r += sr

    return river_mask, river_weight


def compute_river_proximity_and_hand_weighted(river_mask, dem, river_weight):
    ny, nx = river_mask.shape
    INF = 1e10
    dist = np.full((ny, nx), INF, dtype=np.float64)
    river_elev = np.zeros((ny, nx), dtype=np.float64)
    weight = np.zeros((ny, nx), dtype=np.float64)

    dist[river_mask] = 0.0
    river_elev[river_mask] = dem[river_mask]
    weight[river_mask] = river_weight[river_mask]

    frontier = river_mask.copy()
    while frontier.any():
        pad_frontier = np.pad(frontier, 1, mode='constant', constant_values=False)
        pad_dist = np.pad(dist, 1, mode='constant', constant_values=INF)
        pad_relev = np.pad(river_elev, 1, mode='edge')
        pad_weight = np.pad(weight, 1, mode='edge')
        next_frontier = np.zeros_like(frontier, dtype=bool)

        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nbr_fr = pad_frontier[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_dist = pad_dist[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_relev = pad_relev[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_w = pad_weight[1+dr:1+dr+ny, 1+dc:1+dc+nx]

                step = 1.0 if dr == 0 or dc == 0 else math.sqrt(2)
                candidate = nbr_dist + step

                closer = nbr_fr & (candidate < dist)
                dist = np.where(closer, candidate, dist)
                river_elev = np.where(closer, nbr_relev, river_elev)
                weight = np.where(closer, nbr_w, weight)
                next_frontier = next_frontier | closer

        frontier = next_frontier

    hand = dem - river_elev
    return dist, hand, weight


def compute_test_algo(dem, river_mask, river_weight, transform,
                       decay_length_m=150.0, max_flood_height_m=5.0,
                       effective_rain_mm=0.0, flow_acc=None):
    pixel_size_m = math.sqrt(abs(transform.a * transform.e))
    dist_pixels, hand, w = compute_river_proximity_and_hand_weighted(
        river_mask, dem, river_weight
    )
    dist_m = dist_pixels * pixel_size_m

    rain_boost = effective_rain_mm / 1000.0
    w_boosted = np.clip(w + rain_boost, 0, 1)

    dist_score = np.exp(-dist_m / max(decay_length_m, 1.0))
    hand_score = np.clip(1.0 - hand / max(max_flood_height_m, 0.1), 0, 1)
    score = w_boosted * dist_score * hand_score

    if flow_acc is not None:
        acc_norm = flow_acc / (np.max(flow_acc) + 1e-10)
        acc_factor = 1.0 + 2.0 * acc_norm
        score = score * acc_factor

    return score
