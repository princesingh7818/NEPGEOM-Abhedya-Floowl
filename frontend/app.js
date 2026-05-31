// ==========================================
// Mapbox will be initialized after fetching config
// ==========================================

let map;
let cachedLocations = [];
let mapMarkers = []; // Array to store standard Mapbox markers
let clickPreviewMarker = null;

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

async function initializeApp() {
    const warningEl = document.getElementById('token-warning');
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
            style: 'mapbox://styles/mapbox/streets-v12', 
            center: [-74.5, 40], 
            zoom: 9,
            pitch: 45, 
            bearing: -17.6 
        });

        // Update input fields on map click
        map.on('click', (e) => {
            locLngInput.value = e.lngLat.lng.toFixed(5);
            locLatInput.value = e.lngLat.lat.toFixed(5);
            setClickPreviewMarker(e.lngLat.lng, e.lngLat.lat);
        });

        // Load locations
        map.on('load', () => {
            fetchLocations(); 
        });

        // Catch map load errors
        map.on('error', (e) => {
            console.error("Mapbox error:", e.error);
            if (e.error && e.error.message) {
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
        const payload = await response.json();

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
    const name = locNameInput.value.trim();
    const lng = parseFloat(locLngInput.value);
    const lat = parseFloat(locLatInput.value);

    if (!name || isNaN(lng) || isNaN(lat)) {
        alert('Please provide a valid name, longitude, and latitude (you can click the map to get coordinates)');
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
        
        if (response.ok) {
            locNameInput.value = '';
            locLngInput.value = '';
            locLatInput.value = '';
            if (clickPreviewMarker) {
                clickPreviewMarker.remove();
                clickPreviewMarker = null;
            }
            fetchLocations(); // Refresh list and markers
        } else {
            const err = await response.json();
            alert('Error: ' + err.error);
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
addBtn.addEventListener('click', addLocation);

// Start the app
initializeApp();
