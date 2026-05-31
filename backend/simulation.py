import numpy as np
import rasterio
import os
import json
import sys
import math
import warnings
from datetime import datetime
from urllib import request as urlrequest
from urllib import parse as urlparse
from rasterio.transform import from_bounds
from rasterio.io import MemoryFile


def download_dem_arcgis(bounds, token=None, width=1024, height=1024):
    url = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer/exportImage"
    params = {
        "bbox": f"{bounds['minLng']},{bounds['minLat']},{bounds['maxLng']},{bounds['maxLat']}",
        "bboxSR": "4326",
        "size": f"{width},{height}",
        "imageSR": "4326",
        "format": "tiff",
        "pixelType": "F32",
        "f": "image"
    }
    if token and token != 'YOUR_ARCGIS_API_KEY_HERE':
        params["token"] = token

    req_url = f"{url}?{urlparse.urlencode(params)}"
    req = urlrequest.Request(req_url, headers={'User-Agent': 'Mozilla/5.0'})

    with urlrequest.urlopen(req, timeout=30) as resp:
        tiff_data = resp.read()

    if tiff_data.startswith(b'{'):
        try:
            err_json = json.loads(tiff_data)
            raise ValueError(f"ArcGIS Error: {err_json.get('error', err_json)}")
        except json.JSONDecodeError:
            pass

    with MemoryFile(tiff_data) as mem:
        with mem.open() as src:
            dem = src.read(1)
            transform = src.transform

    dem_bounds = {
        'minLng': bounds['minLng'],
        'minLat': bounds['minLat'],
        'maxLng': bounds['maxLng'],
        'maxLat': bounds['maxLat']
    }

    return dem, transform, dem_bounds


def compute_flow_accumulation_mfd(dem, u_norm, v_norm):
    ny, nx = dem.shape
    abs_sum = np.abs(u_norm) + np.abs(v_norm)
    safe_sum = np.where(abs_sum == 0, 1.0, abs_sum)

    frac_x = np.abs(u_norm) / safe_sum
    frac_y = np.abs(v_norm) / safe_sum

    acc = np.ones((ny, nx), dtype=np.float64)
    order = np.argsort(dem.ravel())[::-1]

    for linear_idx in order:
        r = linear_idx // nx
        c = linear_idx % nx
        flow_out = acc[r, c]

        if u_norm[r, c] > 0 and c + 1 < nx:
            acc[r, c + 1] += flow_out * frac_x[r, c]
        elif u_norm[r, c] < 0 and c - 1 >= 0:
            acc[r, c - 1] += flow_out * frac_x[r, c]

        if v_norm[r, c] > 0 and r + 1 < ny:
            acc[r + 1, c] += flow_out * frac_y[r, c]
        elif v_norm[r, c] < 0 and r - 1 >= 0:
            acc[r - 1, c] += flow_out * frac_y[r, c]

    return acc


def compute_velocity_field(dem, nodata=None):
    if nodata is not None:
        dem = np.ma.MaskedArray(dem, mask=(dem == nodata))
        dem_filled = dem.filled(np.nan)
        mask = dem.mask.copy()
    else:
        dem_filled = dem.astype(np.float64)
        mask = np.isnan(dem_filled)

    dem_filled = np.nan_to_num(dem_filled, nan=0.0)

    dzdx = np.gradient(dem_filled, axis=1)
    dzdy = np.gradient(dem_filled, axis=0)

    u = -dzdx
    v = -dzdy

    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        mag = np.sqrt(u ** 2 + v ** 2)
        u_norm = np.where(mag > 1e-12, u / mag, 0.0)
        v_norm = np.where(mag > 1e-12, v / mag, 0.0)
    mag_max = np.max(mag)

    if nodata is not None:
        u_norm = np.ma.MaskedArray(u_norm, mask=mask)
        v_norm = np.ma.MaskedArray(v_norm, mask=mask)

    return u_norm, v_norm, mag, mag_max


def compute_river_proximity_and_hand(river_mask, dem):
    ny, nx = river_mask.shape
    INF = 1e10

    dist = np.full((ny, nx), INF, dtype=np.float64)
    river_elev = np.zeros((ny, nx), dtype=np.float64)

    dist[river_mask] = 0.0
    river_elev[river_mask] = dem[river_mask]

    frontier = river_mask.copy()

    while frontier.any():
        pad_frontier = np.pad(frontier, 1, mode='constant', constant_values=False)
        pad_dist = np.pad(dist, 1, mode='constant', constant_values=INF)
        pad_relev = np.pad(river_elev, 1, mode='edge')

        next_frontier = np.zeros_like(frontier, dtype=bool)

        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue

                nbr_fr = pad_frontier[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_dist = pad_dist[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_relev = pad_relev[1+dr:1+dr+ny, 1+dc:1+dc+nx]

                step = 1.0 if dr == 0 or dc == 0 else math.sqrt(2)
                candidate_dist = nbr_dist + step

                closer = nbr_fr & (candidate_dist < dist)
                dist = np.where(closer, candidate_dist, dist)
                river_elev = np.where(closer, nbr_relev, river_elev)
                next_frontier = next_frontier | closer

        frontier = next_frontier

    hand = dem - river_elev
    return dist, hand


def compute_flood_susceptibility(dem, river_mask, transform,
                                  decay_length_m=100.0, max_flood_height_m=5.0):
    """
    Flood susceptibility via exponential distance decay × HAND.
    Scale-invariant — works identically at 500 m or 50 km.

    score = exp(-dist_m / L) * max(0, 1 - hand / H)
    """
    pixel_size_m = math.sqrt(abs(transform.a * transform.e))
    dist_pixels, hand = compute_river_proximity_and_hand(river_mask, dem)
    dist_m = dist_pixels * pixel_size_m
    dist_score = np.exp(-dist_m / max(decay_length_m, 1.0))
    hand_score = np.clip(1.0 - hand / max(max_flood_height_m, 0.1), 0, 1)
    return dist_score * hand_score


def compute_flood_spread(dem, river_mask, transform,
                          river_rise=2.0, diffusion=0.03, max_iter=500):
    """
    BFS flood spread: water rises at river channels and spreads to adjacent
    low-lying cells with energy loss per step.
    """
    ny, nx = dem.shape
    NEG_INF = -1e10
    pixel_size_m = math.sqrt(abs(transform.a * transform.e))

    water_level = np.full((ny, nx), NEG_INF, dtype=np.float64)
    water_level[river_mask] = dem[river_mask] + river_rise
    flooded = river_mask.copy()

    for iteration in range(max_iter):
        if not flooded.any():
            break

        pad_flooded = np.pad(flooded, 1, mode='constant', constant_values=False)
        pad_water = np.pad(water_level, 1, mode='constant', constant_values=NEG_INF)
        new_flooded = np.zeros_like(flooded, dtype=bool)

        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue

                nbr_fld = pad_flooded[1+dr:1+dr+ny, 1+dc:1+dc+nx]
                nbr_wat = pad_water[1+dr:1+dr+ny, 1+dc:1+dc+nx]

                adjacent = nbr_fld & ~flooded
                incoming = nbr_wat - diffusion

                can_flood = adjacent & (dem <= incoming)
                new_wl = np.maximum(dem, incoming)

                update = can_flood & (new_wl > water_level)
                water_level = np.where(update, new_wl, water_level)
                new_flooded = new_flooded | update

        flooded = flooded | new_flooded
        if not new_flooded.any():
            break

    flood_depth = np.maximum(water_level - dem, 0)
    return flood_depth


OSM_RIVERS_URL = (
    "https://services-ap1.arcgis.com/iA7fZQOnjY9D67Zx/arcgis/rest/services/"
    "OSM_AS_Waterways/FeatureServer/0/query"
)


def fetch_osm_rivers(bounds):
    """Fetch OSM waterways (GeoJSON) from ArcGIS FeatureServer for given bounds."""
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
    """
    Rasterise OSM river lines onto the DEM grid with waterway-type weights.

      waterway → weight
      river    → 1.0   (major flood hazard)
      canal    → 0.5
      stream   → 0.1   (negligible flood risk)
      drain    → 0.0   (no risk)
    """
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
    """
    Multi-source BFS that propagates distance (pixels), HAND, and the
    maximum waterway-weight from the nearest river cell.
    """
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
                       decay_length_m=150.0, max_flood_height_m=5.0):
    """
    OSM-river-weighted exponential decay.

    Only waterways with significant width/volume ('river', 'canal') produce
    meaningful flood scores; small streams and drains are suppressed.

    score = w_nearest · exp(-dist_m / L) · max(0, 1 − HAND / H)
    """
    pixel_size_m = math.sqrt(abs(transform.a * transform.e))
    dist_pixels, hand, w = compute_river_proximity_and_hand_weighted(
        river_mask, dem, river_weight
    )
    dist_m = dist_pixels * pixel_size_m

    dist_score = np.exp(-dist_m / max(decay_length_m, 1.0))
    hand_score = np.clip(1.0 - hand / max(max_flood_height_m, 0.1), 0, 1)
    return w * dist_score * hand_score


def compute_arcgis_flood(dem, river_mask, transform,
                          river_stage_height=5.0,
                          hydraulic_diffusivity=100.0,
                          n_timesteps=2000):
    """
    Diffusion-wave flood model (ArcGIS-inspired).
    
    Explicit 5-point Laplacian scheme with proper metre conversion:
      STEP 1 — Input: DEM Z, river stage, diffusivity K
      STEP 2 — River BC: W_river = Z + river_stage_height
      STEP 3 — Init: W = Z,  W[river] = river_stage
      STEP 4 — Compute face fluxes: q = −K · grad(W)
      STEP 5 — Surface update via divergence: W += dt · div(q)
      STEP 6 — Terrain: W = max(W, Z)
      STEP 7 — Depth: D = max(W − Z, 0)
    """
    Z = dem.astype(np.float64)
    W = Z.copy()
    W[river_mask] = Z[river_mask] + river_stage_height

    # Pixel size in degrees → metres (latitude-aware)
    ny, nx = dem.shape
    px_deg_x = abs(transform.a)
    px_deg_y = abs(transform.e)
    center_lat_deg = transform.f + (ny / 2) * transform.e  # e is negative
    clat = math.radians(center_lat_deg)
    m_per_deg_x = 111320.0 * math.cos(clat)
    m_per_deg_y = 111320.0
    dx_m = math.sqrt(px_deg_x * m_per_deg_x * px_deg_y * m_per_deg_y)
    dx = max(dx_m, 1.0)

    K = max(hydraulic_diffusivity, 1.0)
    alpha = K / (dx * dx)  # 1/s
    dt = 0.2 / max(4 * alpha, 1e-10)  # CFL: α·dt ≤ 0.2/4 for 2D

    for step in range(n_timesteps):
        # STEP 4+5 — 5-point Laplacian (equivalent to -div(q) with face fluxes)
        d2W = (W[2:, 1:-1] + W[:-2, 1:-1] +
               W[1:-1, 2:] + W[1:-1, :-2] -
               4 * W[1:-1, 1:-1]) / (dx * dx)

        W_new = W.copy()
        W_new[1:-1, 1:-1] += dt * K * d2W

        # STEP 2 — Re-apply Dirichlet BC at river cells
        W_new[river_mask] = Z[river_mask] + river_stage_height

        # STEP 6 — Terrain constraint
        W_new = np.maximum(W_new, Z)

        diff = np.max(np.abs(W_new - W))
        W = W_new
        if diff < 0.001:
            break

    # STEP 7 — Flood depth
    D = np.maximum(W - Z, 0)
    return D


def run(bounds, token, output_dir=None, zoom=None, expand_factor=2.0,
        river_threshold_pct=95, display_threshold_pct=50,
        algorithm='test-algo',
        precipitation=25, duration=6,
        infiltration=10, manning_n=0.04, soil_type='loam',
        resolution='medium'):
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cache')
    os.makedirs(output_dir, exist_ok=True)

    soil_infiltration_map = {
        'sand': 25, 'loam': 10, 'clay': 3, 'rock': 1
    }
    effective_infiltration = infiltration if infiltration > 0 else soil_infiltration_map.get(soil_type, 10)
    effective_rain = max(0, precipitation - effective_infiltration) * duration
    manning_factor = np.clip(manning_n / 0.04, 0.5, 2.5)

    res_map = {'low': 512, 'medium': 1024, 'high': 2048}
    dem_size = res_map.get(resolution, 1024)

    center_lng = (bounds['minLng'] + bounds['maxLng']) / 2
    center_lat = (bounds['minLat'] + bounds['maxLat']) / 2
    half_lng = (bounds['maxLng'] - bounds['minLng']) / 2
    half_lat = (bounds['maxLat'] - bounds['minLat']) / 2

    expanded_bounds = {
        'minLng': center_lng - expand_factor * half_lng,
        'maxLng': center_lng + expand_factor * half_lng,
        'minLat': center_lat - expand_factor * half_lat,
        'maxLat': center_lat + expand_factor * half_lat,
    }

    dem, transform, dem_bounds = download_dem_arcgis(expanded_bounds,
                                                      width=dem_size, height=dem_size)

    u_norm, v_norm, mag, _ = compute_velocity_field(dem)
    flow_acc = compute_flow_accumulation_mfd(dem, u_norm, v_norm)

    river_threshold = np.percentile(flow_acc, river_threshold_pct)
    river_mask = flow_acc >= river_threshold

    if not river_mask.any():
        river_mask = np.zeros_like(flow_acc, dtype=bool)
        river_mask[flow_acc == flow_acc.max()] = True

    # Algorithm selection
    effective_rain_mm = effective_rain
    max_flood_height_H = np.clip(0.5 + effective_rain_mm / 200.0, 0.5, 20.0)
    decay_length_L = np.clip(150.0 / manning_factor, 30.0, 300.0)

    if algorithm == 'exp-hand':
        flood_score = compute_flood_susceptibility(
            dem, river_mask, transform,
            decay_length_m=decay_length_L,
            max_flood_height_m=max_flood_height_H
        )
        method_name = 'exp-hand'
    elif algorithm == 'bfs-spread':
        river_rise = np.clip(1.0 + effective_rain / 300.0, 1.0, 8.0)
        diffusion = np.clip(0.03 * manning_factor, 0.01, 0.10)
        flood_depth = compute_flood_spread(
            dem, river_mask, transform,
            river_rise=river_rise,
            diffusion=diffusion,
            max_iter=500
        )
        flood_score = np.where(flood_depth > 0.01, flood_depth, -1.0)
        method_name = 'bfs-spread'
    elif algorithm == 'arcgis':
        river_stage = np.clip(1.0 + effective_rain / 300.0, 1.0, 8.0)
        hyd_diff = 100.0 / manning_factor
        flood_depth = compute_arcgis_flood(
            dem, river_mask, transform,
            river_stage_height=river_stage,
            hydraulic_diffusivity=hyd_diff,
            n_timesteps=2000
        )
        flood_score = np.where(flood_depth > 0.01, flood_depth, -1.0)
        method_name = 'arcgis'
    elif algorithm == 'test-algo':
        osm_json = fetch_osm_rivers(expanded_bounds)
        osm_mask, osm_weight = rasterize_river_geojson(osm_json, transform, dem.shape)
        if not osm_mask.any():
            osm_mask = river_mask
            osm_weight = np.where(river_mask, 1.0, 0.0)
        flood_score = compute_test_algo(
            dem, osm_mask, osm_weight, transform,
            decay_length_m=decay_length_L,
            max_flood_height_m=max_flood_height_H
        )
        method_name = 'test-algo'
    else:
        osm_json = fetch_osm_rivers(expanded_bounds)
        osm_mask, osm_weight = rasterize_river_geojson(osm_json, transform, dem.shape)
        if not osm_mask.any():
            osm_mask = river_mask
            osm_weight = np.where(river_mask, 1.0, 0.0)
        flood_score = compute_test_algo(
            dem, osm_mask, osm_weight, transform,
            decay_length_m=decay_length_L,
            max_flood_height_m=max_flood_height_H
        )
        method_name = 'test-algo'

    inv_transform = ~transform
    col0, row0 = inv_transform * (bounds['minLng'], bounds['maxLat'])
    col1, row1 = inv_transform * (bounds['maxLng'], bounds['minLat'])
    col0 = max(0, int(math.floor(col0)))
    col1 = min(dem.shape[1], int(math.ceil(col1)))
    row0 = max(0, int(math.floor(row0)))
    row1 = min(dem.shape[0], int(math.ceil(row1)))

    if col1 > col0 and row1 > row0:
        dem_crop = dem[row0:row1, col0:col1].astype(np.float64)
        mag_crop = mag[row0:row1, col0:col1].astype(np.float64)
        flood_crop = flood_score[row0:row1, col0:col1].copy()

        MARGIN = 2
        flood_crop[:MARGIN, :] = -1
        flood_crop[-MARGIN:, :] = -1
        flood_crop[:, :MARGIN] = -1
        flood_crop[:, -MARGIN:] = -1

        valid = flood_crop >= 0
        fsv = flood_crop[valid]
        if fsv.size > 0:
            dmax = float(np.percentile(fsv, 99))
            if dmax < 0.01:
                dmax = float(np.max(fsv))
        else:
            dmax = 0.01

        low = dmax * (display_threshold_pct / 100.0)
        if dmax > low:
            normed = np.clip((flood_crop - low) / (dmax - low + 1e-10), 0, 1)
        else:
            normed = np.zeros_like(flood_crop)

        normed = np.where(flood_crop < 0, 0, normed)

        R = np.where(normed > 0, (255 - 80 * normed).astype(np.uint8), 0)
        G = np.where(normed > 0, (128 * (1 - normed)).astype(np.uint8), 0)
        B = np.where(normed > 0, (128 * (1 - normed)).astype(np.uint8), 0)
        alpha = np.where(normed > 0, (80 + 175 * normed).astype(np.uint8), 0)

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        png_filename = f'susceptibility_{timestamp}.png'
        png_path = os.path.join(output_dir, png_filename)

        png_profile = {
            'driver': 'PNG', 'height': flood_crop.shape[0],
            'width': flood_crop.shape[1], 'count': 4, 'dtype': 'uint8'
        }
        with rasterio.open(png_path, 'w', **png_profile) as dst:
            dst.write(R, 1)
            dst.write(G, 2)
            dst.write(B, 3)
            dst.write(alpha, 4)

        tl_lng, tl_lat = transform * (col0, row0)
        br_lng, br_lat = transform * (col1, row1)
        png_bounds = {
            'minLng': tl_lng, 'maxLat': tl_lat,
            'maxLng': br_lng, 'minLat': br_lat
        }
    else:
        png_filename = None
        png_bounds = None
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

    meta = {
        'depth_png': f'/cache/{png_filename}' if png_filename else None,
        'png_bounds': png_bounds,
        'bounds': bounds,
        'expanded_bounds': expanded_bounds,
        'shape': list(dem.shape) if png_filename else None,
        'method': method_name,
        'params': {
            'algorithm': algorithm,
            'river_threshold_percentile': river_threshold_pct,
            'display_threshold_pct': display_threshold_pct,
            'precipitation_mm_hr': precipitation,
            'duration_hrs': duration,
            'infiltration_mm_hr': effective_infiltration,
            'manning_n': manning_n,
            'manning_factor': round(manning_factor, 3),
            'soil_type': soil_type,
            'resolution': resolution,
            'dem_size': dem_size,
            'effective_rain_mm': effective_rain,
            'decay_length_L_m': round(decay_length_L, 1),
            'max_flood_height_H_m': round(max_flood_height_H, 2),
            'flood_score_max': round(float(dmax), 4)
        },
        'expand_factor': expand_factor,
        'velocity_range': {
            'u_min': float(np.min(u_norm)),
            'u_max': float(np.max(u_norm)),
            'v_min': float(np.min(v_norm)),
            'v_max': float(np.max(v_norm)),
            'mag_max': float(np.max(mag))
        }
    }
    meta_path = os.path.join(output_dir, f'susceptibility_{timestamp}.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)

    return meta


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python simulation.py <minLng> <minLat> <maxLng> <maxLat> [zoom]')
        sys.exit(1)

    bounds = {
        'minLng': float(sys.argv[1]),
        'minLat': float(sys.argv[2]),
        'maxLng': float(sys.argv[3]),
        'maxLat': float(sys.argv[4])
    }

    result = run(bounds, None, zoom=int(sys.argv[5]) if len(sys.argv) > 5 else None)
    print(json.dumps(result, indent=2))
