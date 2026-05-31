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
const MAX_REGION_AREA_KM2 = 50;

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
    if (activeRegionEdit && activeRegionEdit.handles) {
        Object.values(activeRegionEdit.handles).forEach((marker) => marker.remove());
    }
    activeRegionEdit = null;
    setRegionEditPreview(null);
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

    const typedName = stripNonBmpChars(locNameInput.value);
    const fallbackName = activeRegionEdit && activeRegionEdit.name ? activeRegionEdit.name : `Region ${new Date().toLocaleString()}`;
    const regionName = typedName || fallbackName;

    const isUpdate = activeRegionEdit && activeRegionEdit.id;
    const endpoint = isUpdate ? `/api/regions/${activeRegionEdit.id}` : '/api/regions';
    const method = isUpdate ? 'PUT' : 'POST';

    try {
        addBtn.disabled = true;
        regionHint.style.display = 'block';
        regionHint.textContent = 'Generating cache... please wait.';

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

        locNameInput.value = '';
        clearRegionEditState();
        await fetchRegions();
        regionHint.textContent = isUpdate
            ? 'Region updated and cache regenerated.'
            : 'Region added and cache generated. Select two corners for another region.';
    } catch (error) {
        alert(`Error: ${error.message}`);
        regionHint.textContent = 'Failed to generate cache. Fix the issue and try Add Region again.';
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
}

async function initializeApp() {
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
            style: 'mapbox://styles/mapbox/outdoors-v12',
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
                        regionHint.textContent = `Region mode: click two opposite corners (max ${MAX_REGION_AREA_KM2} km2).`;
                    }
                }
                return;
            }

            locLngInput.value = e.lngLat.lng.toFixed(5);
            locLatInput.value = e.lngLat.lat.toFixed(5);
            setClickPreviewMarker(e.lngLat.lng, e.lngLat.lat);
        });

        // Load locations
        map.on('load', () => {
            enableTerrainVisualization();
            ensureRegionLayers();
            fetchLocations();
            fetchRegions();
        });

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

// Start the app
initializeApp();
