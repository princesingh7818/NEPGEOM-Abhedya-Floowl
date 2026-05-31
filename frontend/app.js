// ==========================================
// Mapbox will be initialized after fetching config
// ==========================================

let map;
let cachedLocations = [];
let mapMarkers = []; // Array to store standard Mapbox markers
let clickPreviewMarker = null;
let cachedRegions = [];
let isRegionSelectMode = false;
let regionSelectionPoints = [];
let regionCornerMarkers = [];
let activeRegionEdit = null;
let riverThreeLayer = null;
let riverThreeScene = null;
let riverThreeCamera = null;
let riverThreeRenderer = null;
let riverThreeMeshes = [];
let riverFlowParticles = [];
let particleCanvas = null;
let particleCtx = null;
let prevRegionView = null;
let dynamicRiversTimer = null;
let dynamicRiversRequestSeq = 0;
let dynamicRiversController = null;
let riverFlowAnimationFrame = null;
let riverFlowStep = 0;
let regionDiagonal = 1;
const MAX_REGION_AREA_KM2 = Infinity;

function stripNonBmpChars(value) {
    return String(value || '').replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
}

function buildLocationDefaultName() {
    return `Loc ${new Date().toLocaleString()}`;
}

function refreshLocationNamePlaceholder() {
    locNameInput.placeholder = buildLocationDefaultName();
}

async function parseJsonResponse(response) {
    const bodyText = await response.text();
    if (!bodyText) {
        return null;
    }

    try {
        return JSON.parse(bodyText);
    } catch (error) {
        throw new Error(`Expected JSON but received: ${bodyText.slice(0, 120)}`);
    }
}

function setClickPreviewMarker(lng, lat) {
    if (!map) {
        return;
    }

    if (!clickPreviewMarker) {
        const el = document.createElement('div');
        el.className = 'custom-marker';
        clickPreviewMarker = new mapboxgl.Marker({ element: el });
    }

    clickPreviewMarker
        .setLngLat([lng, lat])
        .addTo(map);
}

function clearLocationPreviewMarker() {
    if (clickPreviewMarker) {
        clickPreviewMarker.remove();
        clickPreviewMarker = null;
    }
}

function featureToLocation(feature) {
    if (!feature || feature.type !== 'Feature') {
        return null;
    }

    const geometry = feature.geometry;
    const properties = feature.properties || {};

    if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
        return null;
    }

    const lng = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return null;
    }

    return {
        id: properties.id,
        name: properties.name,
        lng,
        lat,
        geometry
    };
}

// DOM Elements
const locNameInput = document.getElementById('loc-name');
const locLngInput = document.getElementById('loc-lng');
const locLatInput = document.getElementById('loc-lat');
const addBtn = document.getElementById('add-btn');
const locList = document.getElementById('location-list');
const regionList = document.getElementById('region-list');
const selectRegionBtn = document.getElementById('select-region-btn');
const regionHint = document.getElementById('region-hint');
const exportTifBtn = document.getElementById('export-tif-btn');
const simulateBtn = document.getElementById('simulate-btn');
const exportStatus = document.getElementById('export-status');

function resetRegionSelectionState() {
    regionSelectionPoints = [];
    if (map && map.getSource('region-selection-source')) {
        map.getSource('region-selection-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }

    regionCornerMarkers.forEach((marker) => marker.remove());
    regionCornerMarkers = [];
}

function setRegionCornerMarker(index, lng, lat) {
    if (!map) {
        return;
    }

    if (regionCornerMarkers[index]) {
        regionCornerMarkers[index].setLngLat([lng, lat]);
        return;
    }

    const el = document.createElement('div');
    el.className = 'custom-marker';
    regionCornerMarkers[index] = new mapboxgl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(map);
}

function setRegionSelectMode(enabled) {
    isRegionSelectMode = enabled;

    // Clear any stale temporary markers when switching modes.
    clearLocationPreviewMarker();
    resetRegionSelectionState();
    clearRegionEditState();

    if (isRegionSelectMode) {
        selectRegionBtn.classList.add('active');
        selectRegionBtn.textContent = 'Select Location';
        addBtn.textContent = 'Add Region';
        regionHint.style.display = 'block';
        regionHint.textContent = 'Region mode: click two opposite corners on the map.';
    } else {
        selectRegionBtn.classList.remove('active');
        selectRegionBtn.textContent = 'Select Region';
        addBtn.textContent = 'Add Location';
        regionHint.style.display = 'none';
    }
}

function toRectangleFeature(pointA, pointB, properties) {
    const minLng = Math.min(pointA.lng, pointB.lng);
    const maxLng = Math.max(pointA.lng, pointB.lng);
    const minLat = Math.min(pointA.lat, pointB.lat);
    const maxLat = Math.max(pointA.lat, pointB.lat);

    return {
        type: 'Feature',
        properties: properties || {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [minLng, minLat],
                [maxLng, minLat],
                [maxLng, maxLat],
                [minLng, maxLat],
                [minLng, minLat]
            ]]
        }
    };
}

function calculateRectangleAreaKm2(minLng, minLat, maxLng, maxLat) {
    const meanLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
    const widthKm = Math.abs(maxLng - minLng) * 111.32 * Math.cos(meanLatRad);
    const heightKm = Math.abs(maxLat - minLat) * 110.574;
    return widthKm * heightKm;
}

function normalizeBounds(minLng, minLat, maxLng, maxLat) {
    return {
        minLng: Math.min(minLng, maxLng),
        minLat: Math.min(minLat, maxLat),
        maxLng: Math.max(minLng, maxLng),
        maxLat: Math.max(minLat, maxLat)
    };
}

function rectangleFeatureFromBounds(bounds, properties) {
    return {
        type: 'Feature',
        properties: properties || {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [bounds.minLng, bounds.minLat],
                [bounds.maxLng, bounds.minLat],
                [bounds.maxLng, bounds.maxLat],
                [bounds.minLng, bounds.maxLat],
                [bounds.minLng, bounds.minLat]
            ]]
        }
    };
}

function locationToSimBounds(lng, lat, diagonalKm) {
    const halfSide = (diagonalKm / Math.SQRT2) / 2;
    const latRad = lat * Math.PI / 180;
    const dLat = halfSide / 110.574;
    const dLng = halfSide / (111.32 * Math.cos(latRad));
    return {
        minLng: lng - dLng,
        minLat: lat - dLat,
        maxLng: lng + dLng,
        maxLat: lat + dLat
    };
}

const LOCATION_SIM_DIAGONAL_KM = 5; // gives ~12.5 km² square

function enableLocationSimBounds(lng, lat) {
    const bounds = locationToSimBounds(lng, lat, LOCATION_SIM_DIAGONAL_KM);
    const name = `Sim @ ${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    const feature = rectangleFeatureFromBounds(bounds, { name });
    startRegionEdit(feature);
}

function getFeatureBounds(feature) {
    const ring = feature && feature.geometry && feature.geometry.coordinates && feature.geometry.coordinates[0];
    if (!Array.isArray(ring) || ring.length === 0) {
        return null;
    }

    let minLng = ring[0][0];
    let maxLng = ring[0][0];
    let minLat = ring[0][1];
    let maxLat = ring[0][1];

    ring.forEach((pt) => {
        minLng = Math.min(minLng, pt[0]);
        maxLng = Math.max(maxLng, pt[0]);
        minLat = Math.min(minLat, pt[1]);
        maxLat = Math.max(maxLat, pt[1]);
    });

    return { minLng, minLat, maxLng, maxLat };
}

function setRegionSelectionPreview(feature) {
    if (!map || !map.getSource('region-selection-source')) {
        return;
    }

    map.getSource('region-selection-source').setData({
        type: 'FeatureCollection',
        features: feature ? [feature] : []
    });
}

function enableTerrainVisualization() {
    if (!map) {
        return;
    }

    if (!map.getSource('mapbox-dem')) {
        map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.terrain-rgb',
            tileSize: 512,
            maxzoom: 14
        });
    }

    map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.2 });
}

function setRegionEditPreview(feature) {
    if (!map || !map.getSource('region-edit-source')) {
        return;
    }

    map.getSource('region-edit-source').setData({
        type: 'FeatureCollection',
        features: feature ? [feature] : []
    });
}

function clearRegionRiversLayer() {
    if (!map) {
        return;
    }

    if (map.getSource('region-rivers-source')) {
        map.getSource('region-rivers-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }

    destroyParticleCanvas();
    riverFlowParticles = [];
    clearRiverThreeMeshes();
}

function clearRiverThreeMeshes() {
    if (!riverThreeScene) {
        return;
    }

    riverThreeMeshes.forEach((mesh) => {
        riverThreeScene.remove(mesh);
        if (mesh.geometry) {
            mesh.geometry.dispose();
        }
        if (mesh.material) {
            mesh.material.dispose();
        }
    });
    riverThreeMeshes = [];
}

function getWaterwayParticleWeight(waterway) {
    switch (waterway) {
        case 'river':
            return 2.2;
        case 'canal':
            return 1.6;
        case 'stream':
            return 1.1;
        case 'drain':
            return 0.8;
        default:
            return 1;
    }
}

function getWaterwaySpeed(waterway) {
    switch (waterway) {
        case 'river':
            return 1.2;
        case 'canal':
            return 1.0;
        case 'stream':
            return 0.8;
        case 'drain':
            return 0.6;
        default:
            return 0.8;
    }
}

function buildPathFromCoordinates(coords) {
    if (!Array.isArray(coords) || coords.length < 2) {
        return null;
    }

    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
            continue;
        }

        const dx = Number(b[0]) - Number(a[0]);
        const dy = Number(b[1]) - Number(a[1]);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
            continue;
        }

        const segLength = Math.sqrt((dx * dx) + (dy * dy));
        if (segLength <= 0) {
            continue;
        }
        total += segLength;
        cumulative.push(total);
    }

    if (total <= 0 || cumulative.length < 2) {
        return null;
    }

    return { coords, cumulative, total };
}

function samplePathPosition(path, distance) {
    if (!path || !path.total || path.total <= 0 || !Array.isArray(path.coords) || path.coords.length < 2) {
        return null;
    }

    const wrappedDistance = ((distance % path.total) + path.total) % path.total;

    let segIndex = 1;
    while (segIndex < path.cumulative.length && path.cumulative[segIndex] < wrappedDistance) {
        segIndex += 1;
    }

    if (segIndex >= path.coords.length) {
        segIndex = path.coords.length - 1;
    }

    const startIndex = Math.max(0, segIndex - 1);
    const endIndex = Math.min(path.coords.length - 1, segIndex);
    const start = path.coords[startIndex];
    const end = path.coords[endIndex];
    const startDist = path.cumulative[startIndex];
    const endDist = path.cumulative[Math.min(path.cumulative.length - 1, segIndex)];

    const segSpan = Math.max(endDist - startDist, 1e-9);
    const t = (wrappedDistance - startDist) / segSpan;

    const lng = Number(start[0]) + ((Number(end[0]) - Number(start[0])) * t);
    const lat = Number(start[1]) + ((Number(end[1]) - Number(start[1])) * t);

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return null;
    }

    return { lng, lat };
}

function rebuildRiverFlowParticles(geojson) {
    riverFlowParticles = [];

    if (!map || !geojson || !Array.isArray(geojson.features)) {
        return;
    }

    const baseSpeed = regionDiagonal / 9;

    const particleCandidates = [];
    geojson.features.forEach((feature) => {
        if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') {
            return;
        }
        const path = buildPathFromCoordinates(feature.geometry.coordinates);
        if (!path) return;
        const waterway = feature.properties && feature.properties.waterway ? feature.properties.waterway : 'stream';
        const weight = getWaterwayParticleWeight(waterway);
        const speedMult = getWaterwaySpeed(waterway);
        const speed = baseSpeed * speedMult;
        const candidateCount = Math.max(2, Math.round((path.total * 5000) * weight));
        particleCandidates.push({ path, speed, candidateCount });
    });

    if (particleCandidates.length === 0) return;

    const maxParticles = 8000;
    const requestedTotal = particleCandidates.reduce((sum, e) => sum + e.candidateCount, 0);
    const scale = requestedTotal > maxParticles ? maxParticles / requestedTotal : 1;

    particleCandidates.forEach((entry) => {
        const count = Math.max(1, Math.floor(entry.candidateCount * scale));
        for (let i = 0; i < count; i += 1) {
            riverFlowParticles.push({
                path: entry.path,
                distance: Math.random() * entry.path.total,
                speed: entry.speed * (0.7 + Math.random() * 0.8)
            });
        }
    });
}

function initParticleCanvas() {
    if (particleCanvas) return;
    const container = map.getCanvas().parentNode;
    particleCanvas = document.createElement('canvas');
    particleCanvas.style.position = 'absolute';
    particleCanvas.style.top = '0';
    particleCanvas.style.left = '0';
    particleCanvas.style.width = '100%';
    particleCanvas.style.height = '100%';
    particleCanvas.style.pointerEvents = 'none';
    container.appendChild(particleCanvas);
    particleCtx = particleCanvas.getContext('2d');
}

function updateRiverFlowParticles() {
    if (!particleCanvas || !particleCtx) {
        return;
    }

    const container = particleCanvas.parentNode;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);

    if (particleCanvas.width !== bufW || particleCanvas.height !== bufH) {
        particleCanvas.width = bufW;
        particleCanvas.height = bufH;
        particleCanvas.style.width = cssW + 'px';
        particleCanvas.style.height = cssH + 'px';
    }

    particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

    if (!map || riverFlowParticles.length === 0) {
        return;
    }

    const dt = 0.05;
    const count = riverFlowParticles.length;
    const zoom = map.getZoom();
    const radius = Math.max(3, Math.round(3 + (zoom - 8) * 1.5));

    particleCtx.fillStyle = '#000000';

    for (let i = 0; i < count; i += 1) {
        const particle = riverFlowParticles[i];
        particle.distance += particle.speed * dt;
        if (particle.distance > particle.path.total) {
            particle.distance -= particle.path.total;
        }

        const sampled = samplePathPosition(particle.path, particle.distance);
        if (!sampled) continue;

        const pt = map.project([sampled.lng, sampled.lat]);
        const x = pt.x * dpr;
        const y = pt.y * dpr;
        particleCtx.beginPath();
        particleCtx.arc(x, y, radius, 0, Math.PI * 2);
        particleCtx.fill();
    }
}

function destroyParticleCanvas() {
    if (particleCanvas && particleCanvas.parentNode) {
        particleCanvas.parentNode.removeChild(particleCanvas);
    }
    particleCanvas = null;
    particleCtx = null;
}

function ensureRiverThreeLayer() {
    if (!map || riverThreeLayer || typeof THREE === 'undefined') {
        return;
    }

    riverThreeLayer = {
        id: 'region-rivers-threejs-layer',
        type: 'custom',
        renderingMode: '3d',
        onAdd: function(mapInstance, gl) {
            riverThreeCamera = new THREE.Camera();
            riverThreeScene = new THREE.Scene();
            riverThreeRenderer = new THREE.WebGLRenderer({
                canvas: mapInstance.getCanvas(),
                context: gl,
                antialias: true
            });
            riverThreeRenderer.autoClear = false;
        },
        render: function(gl, matrix) {
            if (!riverThreeRenderer || !riverThreeScene || !riverThreeCamera) {
                return;
            }

            riverThreeCamera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);
            riverThreeRenderer.resetState();
            riverThreeRenderer.state.setDepthTest(false);
            riverThreeRenderer.render(riverThreeScene, riverThreeCamera);
            map.triggerRepaint();
        }
    };

    if (!map.getLayer('region-rivers-threejs-layer')) {
        map.addLayer(riverThreeLayer);
    }
}

function drawRiversWithThree(geojson) {
    rebuildRiverFlowParticles(geojson);

    if (!map || !riverThreeScene || typeof THREE === 'undefined') {
        return;
    }

    clearRiverThreeMeshes();

    if (!geojson || !Array.isArray(geojson.features)) {
        console.warn('drawRiversWithThree: no geojson features');
        addDebugMarker();
        return;
    }

    console.log('drawRiversWithThree: features=' + geojson.features.length);

    geojson.features.forEach((feature) => {
        if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') {
            return;
        }

        const coords = feature.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) {
            return;
        }

        const points = [];
        coords.forEach((coord) => {
            if (!Array.isArray(coord) || coord.length < 2) {
                return;
            }
            const terrainElevation = typeof map.queryTerrainElevation === 'function'
                ? map.queryTerrainElevation([coord[0], coord[1]])
                : null;
            const altitude = (Number.isFinite(terrainElevation) ? terrainElevation : 0) + 2;
            const merc = mapboxgl.MercatorCoordinate.fromLngLat([coord[0], coord[1]], altitude);
            points.push(new THREE.Vector3(merc.x, merc.y, merc.z));
        });

        if (points.length < 2) {
            return;
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
            color: 0x36a2eb,
            linewidth: 2,
            transparent: true,
            opacity: 0.8,
            depthTest: false,
            depthWrite: false
        });
        const line = new THREE.Line(geometry, material);
        riverThreeScene.add(line);
        riverThreeMeshes.push(line);
    });
}

function startRiverFlowAnimation() {
    if (!map || riverFlowAnimationFrame) {
        return;
    }

    const dashPatterns = [
        [0.01, 0.8, 5.6],
        [0.5, 0.8, 5.6],
        [1.0, 0.8, 5.6],
        [1.5, 0.8, 5.6],
        [2.0, 0.8, 5.6],
        [2.5, 0.8, 5.6],
        [3.0, 0.8, 5.6],
        [3.5, 0.8, 5.6],
        [4.0, 0.8, 5.6],
        [4.5, 0.8, 5.6],
        [5.0, 0.8, 5.6],
        [5.5, 0.8, 5.6],
        [6.0, 0.8, 5.6],
        [6.5, 0.8, 5.6],
        [7.0, 0.8, 5.6],
        [7.5, 0.8, 5.6],
        [8.0, 0.8, 5.6],
        [8.5, 0.8, 5.6],
        [9.0, 0.8, 5.6],
        [9.5, 0.8, 5.6]
    ];

    const tick = () => {
        updateRiverFlowParticles();
        if (map && map.getLayer('region-rivers-flow-layer')) {
            map.setPaintProperty('region-rivers-flow-layer', 'line-dasharray', dashPatterns[riverFlowStep]);
            const pulse = 0.82 + (0.16 * Math.sin(riverFlowStep * 0.8));
            map.setPaintProperty('region-rivers-flow-layer', 'line-opacity', pulse);
        }
        if (map && map.getLayer('region-rivers-flow-accent-layer')) {
            const offsetIndex = (riverFlowStep + Math.floor(dashPatterns.length / 2)) % dashPatterns.length;
            map.setPaintProperty('region-rivers-flow-accent-layer', 'line-dasharray', dashPatterns[offsetIndex]);
            const accentPulse = 0.55 + (0.2 * Math.sin((riverFlowStep * 0.8) + 1.7));
            map.setPaintProperty('region-rivers-flow-accent-layer', 'line-opacity', accentPulse);
        }
        if (map && map.getLayer('region-rivers-glow-layer')) {
            const glow = 0.28 + (0.1 * Math.sin((riverFlowStep * 0.7) + 1.2));
            map.setPaintProperty('region-rivers-glow-layer', 'line-opacity', glow);
        }
        riverFlowStep = (riverFlowStep + 1) % dashPatterns.length;
        riverFlowAnimationFrame = requestAnimationFrame(tick);
    };

    riverFlowAnimationFrame = requestAnimationFrame(tick);
}

async function loadRegionRivers(regionId) {
    if (!map || !regionId || !map.getSource('region-rivers-source')) {
        return;
    }

    try {
        const response = await fetch(`/api/regions/${regionId}/rivers`, {
            method: 'GET'
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok) {
            throw new Error((payload && payload.error) || `Failed to load rivers (status ${response.status})`);
        }

        const geojson = payload && payload.type === 'FeatureCollection'
            ? payload
            : { type: 'FeatureCollection', features: [] };

        map.getSource('region-rivers-source').setData(geojson);
        drawRiversWithThree(geojson);

        if (geojson.features.length === 0) {
            console.warn(`No ArcGIS river features found for region ${regionId}.`);
        } else {
            console.log(`Loaded ${geojson.features.length} ArcGIS river features for region ${regionId}.`);
        }
    } catch (error) {
        console.error('Error loading rivers:', error);
        clearRegionRiversLayer();
    }
}

async function loadRegionRiversForBounds(bounds, requestSeq) {
    if (!map || !map.getSource('region-rivers-source')) {
        return;
    }

    if (dynamicRiversController) {
        dynamicRiversController.abort();
    }
    dynamicRiversController = new AbortController();

    const dlng = bounds.maxLng - bounds.minLng;
    const dlat = bounds.maxLat - bounds.minLat;
    regionDiagonal = Math.sqrt(dlng * dlng + dlat * dlat);

    try {
        const response = await fetch('/api/rivers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                minLng: bounds.minLng,
                minLat: bounds.minLat,
                maxLng: bounds.maxLng,
                maxLat: bounds.maxLat
            }),
            signal: dynamicRiversController.signal
        });

        const payload = await parseJsonResponse(response);
        if (!response.ok) {
            throw new Error((payload && payload.error) || `Failed to load rivers (status ${response.status})`);
        }

        if (requestSeq !== dynamicRiversRequestSeq) {
            return;
        }

        const geojson = payload && payload.type === 'FeatureCollection'
            ? payload
            : { type: 'FeatureCollection', features: [] };

        map.getSource('region-rivers-source').setData(geojson);
        drawRiversWithThree(geojson);
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return;
        }
        console.error('Error loading dynamic rivers:', error);
    }
}

function scheduleDynamicRiversForBounds(bounds) {
    if (!bounds) {
        return;
    }

    if (dynamicRiversTimer) {
        clearTimeout(dynamicRiversTimer);
        dynamicRiversTimer = null;
    }

    const requestSeq = ++dynamicRiversRequestSeq;
    dynamicRiversTimer = setTimeout(() => {
        loadRegionRiversForBounds(bounds, requestSeq);
    }, 280);
}

function getHandlePosition(bounds, key) {
    switch (key) {
        case 'sw':
            return [bounds.minLng, bounds.minLat];
        case 'se':
            return [bounds.maxLng, bounds.minLat];
        case 'ne':
            return [bounds.maxLng, bounds.maxLat];
        case 'nw':
            return [bounds.minLng, bounds.maxLat];
        case 'n':
            return [(bounds.minLng + bounds.maxLng) / 2, bounds.maxLat];
        case 's':
            return [(bounds.minLng + bounds.maxLng) / 2, bounds.minLat];
        case 'e':
            return [bounds.maxLng, (bounds.minLat + bounds.maxLat) / 2];
        case 'w':
            return [bounds.minLng, (bounds.minLat + bounds.maxLat) / 2];
        default:
            return null;
    }
}

function createRegionResizeHandle(kind, key, bounds) {
    const position = getHandlePosition(bounds, key);
    if (!position) {
        return null;
    }

    const el = document.createElement('div');
    el.className = `region-resize-handle ${kind === 'edge' ? 'edge-handle' : 'corner-handle'}`;

    return new mapboxgl.Marker({ element: el, draggable: true })
        .setLngLat(position)
        .addTo(map);
}

function syncRegionEditHandles(bounds) {
    if (!activeRegionEdit || !activeRegionEdit.handles) {
        return;
    }

    Object.entries(activeRegionEdit.handles).forEach(([key, marker]) => {
        const position = getHandlePosition(bounds, key);
        if (position) {
            marker.setLngLat(position);
        }
    });
}

function applyRegionEditBounds(bounds) {
    if (!activeRegionEdit) {
        return;
    }

    activeRegionEdit.currentBounds = bounds;
    syncRegionEditHandles(bounds);
    setRegionEditPreview(rectangleFeatureFromBounds(bounds, {
        id: activeRegionEdit.id,
        name: activeRegionEdit.name
    }));
    scheduleDynamicRiversForBounds(bounds);
}

function calculateBoundsFromHandleDrag(key, lng, lat, currentBounds) {
    const next = {
        minLng: currentBounds.minLng,
        minLat: currentBounds.minLat,
        maxLng: currentBounds.maxLng,
        maxLat: currentBounds.maxLat
    };

    switch (key) {
        case 'sw':
            next.minLng = lng;
            next.minLat = lat;
            break;
        case 'se':
            next.maxLng = lng;
            next.minLat = lat;
            break;
        case 'ne':
            next.maxLng = lng;
            next.maxLat = lat;
            break;
        case 'nw':
            next.minLng = lng;
            next.maxLat = lat;
            break;
        case 'n':
            next.maxLat = lat;
            break;
        case 's':
            next.minLat = lat;
            break;
        case 'e':
            next.maxLng = lng;
            break;
        case 'w':
            next.minLng = lng;
            break;
        default:
            break;
    }

    return normalizeBounds(next.minLng, next.minLat, next.maxLng, next.maxLat);
}

function onRegionHandleDrag(key) {
    if (!activeRegionEdit || !activeRegionEdit.handles || !activeRegionEdit.handles[key]) {
        return;
    }

    const lngLat = activeRegionEdit.handles[key].getLngLat();
    const currentBounds = activeRegionEdit.currentBounds || activeRegionEdit.lastValidBounds;
    const nextBounds = calculateBoundsFromHandleDrag(key, lngLat.lng, lngLat.lat, currentBounds);
    applyRegionEditBounds(nextBounds);
}

function clearRegionEditState() {
    if (dynamicRiversTimer) {
        clearTimeout(dynamicRiversTimer);
        dynamicRiversTimer = null;
    }
    if (dynamicRiversController) {
        dynamicRiversController.abort();
        dynamicRiversController = null;
    }
    if (activeRegionEdit && activeRegionEdit.handles) {
        Object.values(activeRegionEdit.handles).forEach((marker) => marker.remove());
    }
    activeRegionEdit = null;
    setRegionEditPreview(null);
    clearRegionRiversLayer();
    
    if (map) {
        if (map.getLayer('depth-simulation-layer')) {
            map.removeLayer('depth-simulation-layer');
        }
        if (map.getSource('depth-simulation-source')) {
            map.removeSource('depth-simulation-source');
        }
    }

    exportTifBtn.style.display = 'none';
    simulateBtn.style.display = 'none';
    exportStatus.style.display = 'none';
}

function getActiveEditBounds() {
    if (!activeRegionEdit || !activeRegionEdit.currentBounds) {
        return null;
    }
    return activeRegionEdit.currentBounds;
}

async function persistActiveRegionResize() {
    const bounds = getActiveEditBounds();
    if (!bounds || !activeRegionEdit) {
        return;
    }

    const areaKm2 = calculateRectangleAreaKm2(bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat);
    if (areaKm2 > MAX_REGION_AREA_KM2) {
        alert(`Selected region is ${areaKm2.toFixed(2)} km2. Maximum allowed is ${MAX_REGION_AREA_KM2} km2.`);
        const prev = activeRegionEdit.lastValidBounds;
        applyRegionEditBounds(prev);
        return;
    }

    activeRegionEdit.lastValidBounds = bounds;
}

function startRegionEdit(feature) {
    const bounds = getFeatureBounds(feature);
    if (!bounds) {
        return;
    }

    clearRegionEditState();

    const handles = {
        sw: createRegionResizeHandle('corner', 'sw', bounds),
        se: createRegionResizeHandle('corner', 'se', bounds),
        ne: createRegionResizeHandle('corner', 'ne', bounds),
        nw: createRegionResizeHandle('corner', 'nw', bounds),
        n: createRegionResizeHandle('edge', 'n', bounds),
        s: createRegionResizeHandle('edge', 's', bounds),
        e: createRegionResizeHandle('edge', 'e', bounds),
        w: createRegionResizeHandle('edge', 'w', bounds)
    };

    activeRegionEdit = {
        id: feature.properties && feature.properties.id,
        name: (feature.properties && feature.properties.name) || 'Unnamed Region',
        handles,
        currentBounds: bounds,
        lastValidBounds: bounds
    };

    Object.entries(handles).forEach(([key, marker]) => {
        if (!marker) {
            return;
        }
        marker.on('drag', () => onRegionHandleDrag(key));
        marker.on('dragend', persistActiveRegionResize);
    });

    applyRegionEditBounds(bounds);
    exportTifBtn.style.display = 'inline-block';
    simulateBtn.style.display = 'inline-block';
}

function updateRegionsOnMap(features) {
    if (!map || !map.getSource('regions-source')) {
        return;
    }

    map.getSource('regions-source').setData({
        type: 'FeatureCollection',
        features
    });
}

function renderRegions(regions) {
    regionList.innerHTML = '';

    regions.forEach((feature) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        const props = feature.properties || {};
        label.className = 'loc-text';
        label.textContent = props.name || `Region ${props.id || ''}`.trim();
        label.addEventListener('click', () => {
            const bounds = getFeatureBounds(feature);
            if (!bounds) {
                return;
            }

            map.fitBounds([[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]], {
                padding: 40,
                duration: 800
            });
            startRegionEdit(feature);
        });

        const deleteBtn = document.createElement('span');
        deleteBtn.innerHTML = '&#10006;';
        deleteBtn.className = 'delete-btn';
        deleteBtn.title = 'Delete region';
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await deleteRegion(feature.properties && feature.properties.id);
        });

        li.appendChild(label);
        li.appendChild(deleteBtn);
        regionList.appendChild(li);
    });

    updateRegionsOnMap(regions);
}

async function deleteRegion(id) {
    if (!id) {
        return;
    }

    try {
        const response = await fetch(`/api/regions/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            if (activeRegionEdit && activeRegionEdit.id === id) {
                clearRegionEditState();
            }
            await fetchRegions();
        } else {
            alert('Error deleting region');
        }
    } catch (error) {
        console.error('Error deleting region:', error);
    }
}

async function fetchRegions() {
    try {
        const response = await fetch('/api/regions', {
            method: 'GET'
        });
        const payload = await parseJsonResponse(response);

        if (!response.ok) {
            throw new Error((payload && payload.error) || `Request failed with status ${response.status}`);
        }

        if (payload && payload.type === 'FeatureCollection' && Array.isArray(payload.features)) {
            cachedRegions = payload.features.filter((feature) => (
                feature &&
                feature.type === 'Feature' &&
                feature.geometry &&
                feature.geometry.type === 'Polygon'
            ));
        } else {
            cachedRegions = [];
        }

        renderRegions(cachedRegions);
    } catch (error) {
        console.error('Error fetching regions:', error);
    }
}

function addRegionFromCorners(firstCorner, secondCorner) {
    const minLng = Math.min(firstCorner.lng, secondCorner.lng);
    const maxLng = Math.max(firstCorner.lng, secondCorner.lng);
    const minLat = Math.min(firstCorner.lat, secondCorner.lat);
    const maxLat = Math.max(firstCorner.lat, secondCorner.lat);
    const areaKm2 = calculateRectangleAreaKm2(minLng, minLat, maxLng, maxLat);

    if (areaKm2 > MAX_REGION_AREA_KM2) {
        alert(`Selected region is ${areaKm2.toFixed(2)} km2. Maximum allowed is ${MAX_REGION_AREA_KM2} km2.`);
        resetRegionSelectionState();
        return false;
    }

    const regionName = stripNonBmpChars(locNameInput.value) || `Region ${new Date().toLocaleString()}`;

    prevRegionView = {
        pitch: map.getPitch(),
        bearing: map.getBearing()
    };

    const draftFeature = rectangleFeatureFromBounds(
        { minLng, minLat, maxLng, maxLat },
        { name: regionName }
    );

    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
        padding: 40,
        duration: 800
    });
    resetRegionSelectionState();
    startRegionEdit(draftFeature);
    return true;
}

async function saveActiveRegionSelection() {
    if (!isRegionSelectMode) {
        return;
    }

    const bounds = getActiveEditBounds();
    if (!bounds) {
        alert('Select a region first, then resize if needed, then click Add Region.');
        return;
    }

    const areaKm2 = calculateRectangleAreaKm2(bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat);
    if (areaKm2 > MAX_REGION_AREA_KM2) {
        alert(`Selected region is ${areaKm2.toFixed(2)} km2. Maximum allowed is ${MAX_REGION_AREA_KM2} km2.`);
        return;
    }

    const dlng = bounds.maxLng - bounds.minLng;
    const dlat = bounds.maxLat - bounds.minLat;
    regionDiagonal = Math.sqrt(dlng * dlng + dlat * dlat);

    const typedName = stripNonBmpChars(locNameInput.value);
    const fallbackName = activeRegionEdit && activeRegionEdit.name ? activeRegionEdit.name : `Region ${new Date().toLocaleString()}`;
    const regionName = typedName || fallbackName;

    const isUpdate = activeRegionEdit && activeRegionEdit.id;
    const endpoint = isUpdate ? `/api/regions/${activeRegionEdit.id}` : '/api/regions';
    const method = isUpdate ? 'PUT' : 'POST';

    try {
        addBtn.disabled = true;
        regionHint.style.display = 'block';
        regionHint.textContent = 'Saving region and fetching ArcGIS rivers...';

        const response = await fetch(endpoint, {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: regionName,
                minLng: bounds.minLng,
                minLat: bounds.minLat,
                maxLng: bounds.maxLng,
                maxLat: bounds.maxLat
            })
        });

        const payload = await parseJsonResponse(response);
        if (!response.ok) {
            throw new Error((payload && payload.error) || `Failed to save region (status ${response.status})`);
        }

        const savedRegionId = payload && payload.properties && payload.properties.id;
        locNameInput.value = '';
        clearRegionEditState();
        await fetchRegions();
        if (savedRegionId) {
            await loadRegionRivers(savedRegionId);
        }
        if (prevRegionView) {
            map.flyTo({
                center: map.getCenter(),
                zoom: map.getZoom(),
                pitch: prevRegionView.pitch,
                bearing: prevRegionView.bearing,
                duration: 600
            });
            prevRegionView = null;
        }
        regionHint.textContent = isUpdate
            ? 'Region updated and ArcGIS rivers reloaded.'
            : 'Region added and ArcGIS rivers loaded. Select two corners for another region.';
    } catch (error) {
        alert(`Error: ${error.message}`);
        regionHint.textContent = 'Failed to save region or load ArcGIS rivers. Fix the issue and try Add Region again.';
    } finally {
        addBtn.disabled = false;
    }
}

function ensureRegionLayers() {
    if (!map.getSource('regions-source')) {
        map.addSource('regions-source', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
    }

    if (!map.getLayer('regions-fill')) {
        map.addLayer({
            id: 'regions-fill',
            type: 'fill',
            source: 'regions-source',
            paint: {
                'fill-color': '#1e88e5',
                'fill-opacity': 0.18
            }
        });
    }

    if (!map.getLayer('regions-outline')) {
        map.addLayer({
            id: 'regions-outline',
            type: 'line',
            source: 'regions-source',
            paint: {
                'line-color': '#1e88e5',
                'line-width': 2
            }
        });
    }

    if (!map.getSource('region-selection-source')) {
        map.addSource('region-selection-source', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
    }

    if (!map.getLayer('region-selection-fill')) {
        map.addLayer({
            id: 'region-selection-fill',
            type: 'fill',
            source: 'region-selection-source',
            paint: {
                'fill-color': '#43a047',
                'fill-opacity': 0.18
            }
        });
    }

    if (!map.getLayer('region-selection-outline')) {
        map.addLayer({
            id: 'region-selection-outline',
            type: 'line',
            source: 'region-selection-source',
            paint: {
                'line-color': '#43a047',
                'line-width': 2,
                'line-dasharray': [2, 2]
            }
        });
    }

    if (!map.getSource('region-edit-source')) {
        map.addSource('region-edit-source', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
    }

    if (!map.getLayer('region-edit-fill')) {
        map.addLayer({
            id: 'region-edit-fill',
            type: 'fill',
            source: 'region-edit-source',
            paint: {
                'fill-color': '#fb8c00',
                'fill-opacity': 0.2
            }
        });
    }

    if (!map.getLayer('region-edit-outline')) {
        map.addLayer({
            id: 'region-edit-outline',
            type: 'line',
            source: 'region-edit-source',
            paint: {
                'line-color': '#fb8c00',
                'line-width': 2,
                'line-dasharray': [1, 1]
            }
        });
    }

    if (!map.getSource('region-rivers-source')) {
        map.addSource('region-rivers-source', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
    }

    if (!map.getLayer('region-rivers-glow-layer')) {
        map.addLayer({
            id: 'region-rivers-glow-layer',
            type: 'line',
            source: 'region-rivers-source',
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': '#36a2eb',
                'line-width': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    8,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 8.7,
                        'canal', 6.8,
                        'stream', 4.4,
                        'drain', 3.5,
                        4.4
                    ],
                    10,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 11.3,
                        'canal', 8.6,
                        'stream', 5.4,
                        'drain', 4.3,
                        5.4
                    ],
                    14,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 20.6,
                        'canal', 15.7,
                        'stream', 9.9,
                        'drain', 7.8,
                        9.9
                    ],
                    17,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 33.8,
                        'canal', 25.7,
                        'stream', 16.2,
                        'drain', 12.8,
                        16.2
                    ],
                    19,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 46.5,
                        'canal', 35.3,
                        'stream', 22.4,
                        'drain', 17.6,
                        22.4
                    ]
                ],
                'line-blur': 1.8,
                'line-opacity': 0.32
            }
        });
    }

    if (!map.getLayer('region-rivers-bank-layer')) {
        map.addLayer({
            id: 'region-rivers-bank-layer',
            type: 'line',
            source: 'region-rivers-source',
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': '#0b3d91',
                'line-width': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    8,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 5.1,
                        'canal', 3.9,
                        'stream', 2.6,
                        'drain', 2.2,
                        2.6
                    ],
                    10,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 6.6,
                        'canal', 5.1,
                        'stream', 3.5,
                        'drain', 2.9,
                        3.5
                    ],
                    14,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 12.5,
                        'canal', 9.7,
                        'stream', 6.6,
                        'drain', 5.4,
                        6.6
                    ],
                    17,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 20.5,
                        'canal', 15.8,
                        'stream', 10.7,
                        'drain', 8.8,
                        10.7
                    ],
                    19,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 28.2,
                        'canal', 21.8,
                        'stream', 14.7,
                        'drain', 12.2,
                        14.7
                    ]
                ],
                'line-opacity': 0.72
            }
        });
    }

    if (!map.getLayer('region-rivers-layer')) {
        map.addLayer({
            id: 'region-rivers-layer',
            type: 'line',
            source: 'region-rivers-source',
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': [
                    'match',
                    ['get', 'waterway'],
                    'river', '#42a5f5',
                    'canal', '#4fc3f7',
                    'stream', '#64b5f6',
                    'drain', '#90caf9',
                    '#64b5f6'
                ],
                'line-width': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    8,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 3.0,
                        'canal', 2.3,
                        'stream', 1.6,
                        'drain', 1.4,
                        1.6
                    ],
                    10,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 3.6,
                        'canal', 2.8,
                        'stream', 1.9,
                        'drain', 1.6,
                        1.9
                    ],
                    14,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 7.8,
                        'canal', 6.0,
                        'stream', 4.1,
                        'drain', 3.5,
                        4.1
                    ],
                    17,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 13.8,
                        'canal', 10.7,
                        'stream', 7.2,
                        'drain', 6.2,
                        7.2
                    ],
                    19,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 20.4,
                        'canal', 15.8,
                        'stream', 10.7,
                        'drain', 9.2,
                        10.7
                    ]
                ],
                'line-opacity': 0.88
            }
        });
    }

    if (!map.getLayer('region-rivers-flow-layer')) {
        map.addLayer({
            id: 'region-rivers-flow-layer',
            type: 'line',
            source: 'region-rivers-source',
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': '#e3f2fd',
                'line-width': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    8,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 1.5,
                        'canal', 1.3,
                        'stream', 1.0,
                        'drain', 0.9,
                        1.0
                    ],
                    10,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 1.8,
                        'canal', 1.5,
                        'stream', 1.2,
                        'drain', 1.0,
                        1.2
                    ],
                    14,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 3.4,
                        'canal', 2.8,
                        'stream', 2.3,
                        'drain', 1.9,
                        2.3
                    ],
                    17,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 5.4,
                        'canal', 4.5,
                        'stream', 3.6,
                        'drain', 3.1,
                        3.6
                    ],
                    19,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 9.3,
                        'canal', 7.7,
                        'stream', 6.0,
                        'drain', 5.1,
                        6.0
                    ]
                ],
                'line-opacity': 0.86,
                'line-dasharray': [0.01, 0.8, 5.6]
            }
        });
    }

    if (!map.getLayer('region-rivers-flow-accent-layer')) {
        map.addLayer({
            id: 'region-rivers-flow-accent-layer',
            type: 'line',
            source: 'region-rivers-source',
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': '#ffffff',
                'line-width': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    8,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 1.2,
                        'canal', 1.0,
                        'stream', 0.8,
                        'drain', 0.7,
                        0.8
                    ],
                    10,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 1.5,
                        'canal', 1.3,
                        'stream', 1.0,
                        'drain', 0.9,
                        1.0
                    ],
                    14,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 2.7,
                        'canal', 2.3,
                        'stream', 1.8,
                        'drain', 1.5,
                        1.8
                    ],
                    17,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 4.4,
                        'canal', 3.6,
                        'stream', 2.9,
                        'drain', 2.4,
                        2.9
                    ],
                    19,
                    [
                        'match',
                        ['get', 'waterway'],
                        'river', 5.9,
                        'canal', 4.8,
                        'stream', 3.9,
                        'drain', 3.3,
                        3.9
                    ]
                ],
                'line-opacity': 0.55,
                'line-dasharray': [4.8, 0.8, 1.6]
            }
        });
    }
}

async function initializeApp() {
    // Mode switching
    const modeSimpleBtn = document.getElementById('mode-simple-btn');
    const modeComplexBtn = document.getElementById('mode-complex-btn');
    const simpleContent = document.getElementById('simple-mode-content');
    const complexContent = document.getElementById('complex-mode-content');
    const complexPanel = document.getElementById('complex-params-panel');

    function setMode(mode) {
        if (mode === 'complex') {
            modeSimpleBtn.classList.remove('active');
            modeComplexBtn.classList.add('active');
            simpleContent.style.display = 'none';
            complexContent.style.display = 'block';
            complexPanel.style.display = 'block';
        } else {
            modeComplexBtn.classList.remove('active');
            modeSimpleBtn.classList.add('active');
            complexContent.style.display = 'none';
            complexPanel.style.display = 'none';
            simpleContent.style.display = 'block';
        }
    }

    modeSimpleBtn.addEventListener('click', () => setMode('simple'));
    modeComplexBtn.addEventListener('click', () => setMode('complex'));

    // Live parameter value display
    function wireRangeDisplay(inputId, displayId, suffix) {
        const input = document.getElementById(inputId);
        const display = document.getElementById(displayId);
        if (input && display) {
            input.addEventListener('input', () => {
                if (typeof suffix === 'function') {
                    display.textContent = suffix(input.value);
                } else {
                    display.textContent = input.value + ' ' + suffix;
                }
            });
        }
    }
    wireRangeDisplay('param-precipitation', 'precipitation-value', 'mm/hr');
    wireRangeDisplay('param-duration', 'duration-value', 'hrs');
    wireRangeDisplay('param-infiltration', 'infiltration-value', 'mm/hr');
    wireRangeDisplay('param-river-threshold', 'river-threshold-value', 'th percentile');
    wireRangeDisplay('param-display-threshold', 'display-threshold-value', function(v) {
        return 'Show top ' + (100 - parseInt(v)) + '%';
    });

    // Complex simulation run
    const runComplexBtn = document.getElementById('run-complex-btn');
    const complexStatus = document.getElementById('complex-status');
    if (runComplexBtn) {
        runComplexBtn.addEventListener('click', async () => {
            const bounds = getActiveEditBounds();
            if (!bounds) {
                complexStatus.textContent = 'Click a location or select a region first.';
                complexStatus.className = 'export-status error';
                complexStatus.style.display = 'block';
                return;
            }

            complexStatus.textContent = 'Running complex simulation...';
            complexStatus.className = 'export-status';
            complexStatus.style.display = 'block';

            try {
                const response = await fetch('/api/simulate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        minLng: bounds.minLng,
                        minLat: bounds.minLat,
                        maxLng: bounds.maxLng,
                        maxLat: bounds.maxLat,
                        precipitation: parseFloat(document.getElementById('param-precipitation').value),
                        duration: parseFloat(document.getElementById('param-duration').value),
                        infiltration: parseFloat(document.getElementById('param-infiltration').value),
                        manning: parseFloat(document.getElementById('param-manning').value),
                        soil: document.getElementById('param-soil').value,
                        algorithm: document.getElementById('param-algorithm').value,
                        river_threshold: parseInt(document.getElementById('param-river-threshold').value),
                        display_threshold: parseInt(document.getElementById('param-display-threshold').value)
                    })
                });
                const payload = await parseJsonResponse(response);

                if (response.ok && payload) {
                    complexStatus.textContent = 'Complex simulation complete.';
                    complexStatus.className = 'export-status success';

                    if (payload.depth_png) {
                        const sourceId = 'depth-simulation-source';
                        const layerId = 'depth-simulation-layer';

                        if (map.getLayer(layerId)) map.removeLayer(layerId);
                        if (map.getSource(sourceId)) map.removeSource(sourceId);

                        const pBounds = payload.png_bounds || payload.bounds;
                        map.addSource(sourceId, {
                            type: 'image',
                            url: payload.depth_png,
                            coordinates: [
                                [pBounds.minLng, pBounds.maxLat],
                                [pBounds.maxLng, pBounds.maxLat],
                                [pBounds.maxLng, pBounds.minLat],
                                [pBounds.minLng, pBounds.minLat]
                            ]
                        });
                        map.addLayer({
                            id: layerId,
                            type: 'raster',
                            source: sourceId,
                            paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 }
                        });
                    }
                } else {
                    complexStatus.textContent = (payload && payload.error) || 'Complex simulation failed';
                    complexStatus.className = 'export-status error';
                }
            } catch (err) {
                complexStatus.textContent = 'Error: ' + err.message;
                complexStatus.className = 'export-status error';
            }
            complexStatus.style.display = 'block';
        });
    }

    const warningEl = document.getElementById('token-warning');
    refreshLocationNamePlaceholder();
    try {
        // Fetch API key from backend
        const configRes = await fetch('/api/config');
        
        let config;
        try {
            config = await configRes.json();
        } catch (e) {
            throw new Error('Your api/config.json file contains invalid JSON (check for missing quotes or trailing commas).');
        }

        if (config.error) {
            throw new Error(config.error);
        }
        
        mapboxgl.accessToken = config.MAPBOX_KEY;

        if (!mapboxgl.accessToken || mapboxgl.accessToken === 'YOUR_MAPBOX_ACCESS_TOKEN_HERE') {
            warningEl.textContent = 'Please enter your Mapbox Token in api/config.json!';
            warningEl.style.display = 'block';
            return;
        } else {
            warningEl.style.display = 'none';
        }

        map = new mapboxgl.Map({
            container: 'map', 
            style: 'mapbox://styles/mapbox/satellite-streets-v12',
            center: [85.5374, 27.6182],
            zoom: 14,
            pitch: 45, 
            bearing: -17.6 
        });

        // Update input fields on map click
        map.on('click', async (e) => {
            if (isRegionSelectMode) {
                if (regionSelectionPoints.length >= 2) {
                    resetRegionSelectionState();
                }

                regionSelectionPoints.push({ lng: e.lngLat.lng, lat: e.lngLat.lat });
                setRegionCornerMarker(regionSelectionPoints.length - 1, e.lngLat.lng, e.lngLat.lat);

                if (regionSelectionPoints.length === 1) {
                    regionHint.textContent = 'First corner selected. Click the opposite corner.';
                } else {
                    const rectangleFeature = toRectangleFeature(regionSelectionPoints[0], regionSelectionPoints[1]);
                    setRegionSelectionPreview(rectangleFeature);
                    const regionPrepared = addRegionFromCorners(regionSelectionPoints[0], regionSelectionPoints[1]);
                    if (regionPrepared) {
                        regionHint.textContent = 'Region prepared. Resize if needed, then click Add Region to save.';
                    } else {
                        regionHint.textContent = 'Region mode: click two opposite corners.';
                    }
                }
                return;
            }

            locLngInput.value = e.lngLat.lng.toFixed(5);
            locLatInput.value = e.lngLat.lat.toFixed(5);
            setClickPreviewMarker(e.lngLat.lng, e.lngLat.lat);
            // Create a simulation-ready square bounding box around the clicked point
            enableLocationSimBounds(e.lngLat.lng, e.lngLat.lat);
        });

        // Load locations
        map.on('load', () => {
            enableTerrainVisualization();
            ensureRegionLayers();
            initParticleCanvas();
            startRiverFlowAnimation();
            ensureRiverThreeLayer();
            fetchLocations();
            fetchRegions();
        });

        // --- Map controls (2D/3D, zoom, compass) ---
        const btn3d = document.getElementById('btn-3d');
        const btnZoomIn = document.getElementById('btn-zoom-in');
        const btnZoomOut = document.getElementById('btn-zoom-out');
        const btnCompass = document.getElementById('btn-compass');

        let is3D = true;

        function setViewMode3D(enable) {
            if (enable) {
                map.setPitch(45);
                enableTerrainVisualization();
                btn3d.textContent = '3D';
                btn3d.classList.add('active');
            } else {
                map.setPitch(0);
                map.setTerrain(null);
                btn3d.textContent = '2D';
                btn3d.classList.remove('active');
            }
            is3D = enable;
        }

        if (btn3d) {
            btn3d.classList.add('active');
            btn3d.addEventListener('click', () => setViewMode3D(!is3D));
        }
        if (btnZoomIn) {
            btnZoomIn.addEventListener('click', () => map.zoomIn({ duration: 300 }));
        }
        if (btnZoomOut) {
            btnZoomOut.addEventListener('click', () => map.zoomOut({ duration: 300 }));
        }
        if (btnCompass) {
            btnCompass.addEventListener('click', () => {
                map.easeTo({ bearing: 0, duration: 300 });
            });
        }

        // Catch map load errors
        map.on('error', (e) => {
            console.error("Mapbox error:", e.error);
            if (e.error && e.error.message) {
                if (e.error.message.includes('glyphs > 65535 not supported')) {
                    return;
                }
                warningEl.textContent = 'Mapbox Error: ' + e.error.message;
                warningEl.style.display = 'block';
            }
        });

    } catch (err) {
        console.error('Failed to initialize app', err);
        warningEl.textContent = 'Error: ' + err.message;
        warningEl.style.display = 'block';
    }
}

// Fetch locations from backend database
async function fetchLocations() {
    try {
        const response = await fetch('/api/locations');
        const payload = await parseJsonResponse(response);

        if (!response.ok) {
            throw new Error((payload && payload.error) || `Request failed with status ${response.status}`);
        }

        if (payload && payload.type === 'FeatureCollection' && Array.isArray(payload.features)) {
            cachedLocations = payload.features
                .map(featureToLocation)
                .filter((loc) => loc && loc.name);
        } else if (Array.isArray(payload)) {
            // Backward compatibility if old API payload is returned
            cachedLocations = payload;
        } else {
            cachedLocations = [];
        }

        renderLocations(cachedLocations);
    } catch (error) {
        console.error('Error fetching locations:', error);
    }
}

// Add a new location to database
async function addLocation() {
    const typedName = stripNonBmpChars(locNameInput.value);
    const name = typedName || stripNonBmpChars(locNameInput.placeholder) || buildLocationDefaultName();
    const lng = parseFloat(locLngInput.value);
    const lat = parseFloat(locLatInput.value);

    if (isNaN(lng) || isNaN(lat)) {
        alert('Please provide a valid longitude and latitude (you can click the map to get coordinates)');
        return;
    }

    try {
        const response = await fetch('/api/locations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, lng, lat })
        });
        const payload = await parseJsonResponse(response);
        
        if (response.ok) {
            locNameInput.value = '';
            refreshLocationNamePlaceholder();
            locLngInput.value = '';
            locLatInput.value = '';
            clearLocationPreviewMarker();
            fetchLocations(); // Refresh list and markers
        } else {
            alert('Error: ' + ((payload && payload.error) || `Request failed with status ${response.status}`));
        }
    } catch (error) {
        console.error('Error adding location:', error);
    }
}

// Delete a location from database
async function deleteLocation(id) {
    try {
        const response = await fetch(`/api/locations/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            fetchLocations(); // Refresh list and markers
        } else {
            alert('Error deleting location');
        }
    } catch (error) {
        console.error('Error deleting location:', error);
    }
}

function renderLocations(locations) {
    locList.innerHTML = '';
    
    // Clear existing markers from map
    mapMarkers.forEach(marker => marker.remove());
    mapMarkers = [];

    locations.forEach(loc => {
        // Add to UI list
        const li = document.createElement('li');
        
        const textSpan = document.createElement('span');
        textSpan.textContent = `${loc.name} (${loc.lng.toFixed(2)}, ${loc.lat.toFixed(2)})`;
        textSpan.className = 'loc-text';
        textSpan.addEventListener('click', () => {
            // Fly to the marker with a nice tilt
            map.flyTo({ 
                center: [loc.lng, loc.lat], 
                zoom: 14,
                pitch: 60,
                bearing: 45
            });
        });

        const deleteBtn = document.createElement('span');
        deleteBtn.innerHTML = '&#10006;'; // X symbol
        deleteBtn.className = 'delete-btn';
        deleteBtn.title = 'Delete location';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent triggering the flyTo click
            deleteLocation(loc.id);
        });

        li.appendChild(textSpan);
        li.appendChild(deleteBtn);
        locList.appendChild(li);

        // Create a custom HTML element for the marker to give it a 3D drop-pin look
        const el = document.createElement('div');
        el.className = 'custom-marker';
        
        // Optionally cycle colors
        const colors = ['#ff0055', '#00aaff', '#ffaa00', '#00ffaa'];
        const color = colors[loc.id % colors.length];
        el.style.backgroundColor = color;

        // Add standard Mapbox Marker using the custom CSS element
        const marker = new mapboxgl.Marker({ element: el })
            .setLngLat([loc.lng, loc.lat])
            .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<h3>${loc.name}</h3>`))
            .addTo(map);
            
        mapMarkers.push(marker);
    });
}

// Event Listeners
addBtn.addEventListener('click', () => {
    if (isRegionSelectMode) {
        saveActiveRegionSelection();
    } else {
        addLocation();
    }
});
selectRegionBtn.addEventListener('click', () => {
    setRegionSelectMode(!isRegionSelectMode);
});

exportTifBtn.addEventListener('click', async () => {
    const bounds = getActiveEditBounds();
    if (!bounds) {
        return;
    }

    exportStatus.textContent = 'Exporting satellite TIF...';
    exportStatus.className = 'export-status';
    exportStatus.style.display = 'block';

    try {
        const response = await fetch('/api/export-tif', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                minLng: bounds.minLng,
                minLat: bounds.minLat,
                maxLng: bounds.maxLng,
                maxLat: bounds.maxLat
            })
        });
        const payload = await parseJsonResponse(response);

        if (response.ok && payload) {
            exportStatus.textContent = payload.message;
            exportStatus.className = 'export-status success';
        } else {
            exportStatus.textContent = (payload && payload.error) || 'Export failed';
            exportStatus.className = 'export-status error';
        }
    } catch (err) {
        exportStatus.textContent = 'Export error: ' + err.message;
        exportStatus.className = 'export-status error';
    }

    exportStatus.style.display = 'block';
});

simulateBtn.addEventListener('click', async () => {
    const bounds = getActiveEditBounds();
    if (!bounds) {
        return;
    }

    exportStatus.textContent = 'Running DEM simulation...';
    exportStatus.className = 'export-status';
    exportStatus.style.display = 'block';

    try {
        const response = await fetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                minLng: bounds.minLng,
                minLat: bounds.minLat,
                maxLng: bounds.maxLng,
                maxLat: bounds.maxLat
            })
        });
        const payload = await parseJsonResponse(response);

        if (response.ok && payload) {
            const vr = payload.velocity_range || {};
            exportStatus.textContent = `Simulation done. mag_max=${vr.mag_max ? vr.mag_max.toFixed(2) : '?'}`;
            exportStatus.className = 'export-status success';

            if (payload.depth_png) {
                // Add the depth grayscale PNG to Mapbox
                const sourceId = 'depth-simulation-source';
                const layerId = 'depth-simulation-layer';

                if (map.getLayer(layerId)) {
                    map.removeLayer(layerId);
                }
                if (map.getSource(sourceId)) {
                    map.removeSource(sourceId);
                }

                const pBounds = payload.png_bounds || payload.bounds;

                map.addSource(sourceId, {
                    type: 'image',
                    url: payload.depth_png,
                    coordinates: [
                        [pBounds.minLng, pBounds.maxLat], // top left
                        [pBounds.maxLng, pBounds.maxLat], // top right
                        [pBounds.maxLng, pBounds.minLat], // bottom right
                        [pBounds.minLng, pBounds.minLat]  // bottom left
                    ]
                });

                map.addLayer({
                    id: layerId,
                    type: 'raster',
                    source: sourceId,
                    paint: {
                        'raster-opacity': 0.75,
                        'raster-fade-duration': 0
                    }
                });
            }
        } else {
            exportStatus.textContent = (payload && payload.error) || 'Simulation failed';
            exportStatus.className = 'export-status error';
        }
    } catch (err) {
        exportStatus.textContent = 'Simulation error: ' + err.message;
        exportStatus.className = 'export-status error';
    }

    exportStatus.style.display = 'block';
});

// Start the app
initializeApp();
