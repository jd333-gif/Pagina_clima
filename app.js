
const $ = (id) => document.getElementById(id);

const searchBtn = $("searchBtn");
const originInput = $("originInput");
const destInput = $("destInput");
const locBtn = $("locBtn");
const loading = $("loading");
const resultArea = $("resultArea");
const modeSwitch = $("modeSwitch");

let map = null;
let mode = "car";
let routeLayers = [];
let state = null;
let searchToken = 0;

const MODE_LABEL = {
    car: "en auto",
    bike: "en bici",
    foot: "a pie"
};

const PROFILES = {
    car: "routed-car",
    bike: "routed-bike",
    foot: "routed-foot"
};

const ALIASES = {
    cdmx: "Ciudad de México",
    df: "Ciudad de México",
    edomex: "Estado de México",
    gdl: "Guadalajara",
    mty: "Monterrey"
};

// UTILIDADES

const escapeHTML = (str) =>
    String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

async function fetchJSON(url, ms = 9000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();

    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("tiempo agotado");
        }

        if (error.message === "Failed to fetch") {
            throw new Error(
                "sin conexión o bloqueado por la red/navegador"
            );
        }

        throw error;

    } finally {
        clearTimeout(timer);
    }
}

function fmtDist(meters) {
    return meters < 1000
        ? `${Math.round(meters)} m`
        : `${(meters / 1000).toFixed(1)} km`;
}

function fmtTime(seconds) {
    const minutes = Math.round(seconds / 60);

    if (minutes < 60) return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;

    return remainder
        ? `${hours} h ${remainder} min`
        : `${hours} h`;
}

// LIMPIEZA DEL MAPA

function destroyMap() {
    const oldMap = map;

    // Invalidar referencias antes de retirar el mapa
    map = null;
    routeLayers = [];

    if (!oldMap) return;

    let container = null;

    try {
        container = oldMap.getContainer();
    } catch (error) {
        console.warn(error);
    }

    try {
        oldMap.off();
        oldMap.remove();

    } catch (error) {
        console.warn(
            "Leaflet no pudo retirar el mapa normalmente:",
            error
        );

        if (container) {
            try {
                container.replaceChildren();
                container.classList.remove("leaflet-container");
                container.removeAttribute("tabindex");

                if (container._leaflet_id) {
                    delete container._leaflet_id;
                }

            } catch (cleanupError) {
                console.warn(cleanupError);
            }
        }
    }
}

function showMessage(icon, title, message) {
    destroyMap();

    resultArea.innerHTML = `
        <div class="result-card">
            <div class="empty-state">
                <div class="empty-icon">${icon}</div>
                <h2>${escapeHTML(title)}</h2>
                <p>${message}</p>
            </div>
        </div>`;
}

// MODO DE TRANSPORTE

modeSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");

    if (!button) return;

    mode = button.dataset.mode;

    modeSwitch.querySelectorAll("button").forEach((item) => {
        item.classList.toggle("active", item === button);
    });
});

// UBICACIÓN ACTUAL

locBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
        showMessage(
            "📍",
            "Ubicación no disponible",
            "Tu navegador no permite obtener la ubicación."
        );
        return;
    }

    locBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
        (position) => {
            originInput.value = "Mi ubicación actual";

            originInput.dataset.lat =
                position.coords.latitude;

            originInput.dataset.lon =
                position.coords.longitude;

            locBtn.disabled = false;
        },

        () => {
            locBtn.disabled = false;

            showMessage(
                "📍",
                "No se pudo obtener tu ubicación",
                "Permite el acceso a la ubicación o escribe el origen manualmente."
            );
        },

        {
            enableHighAccuracy: true,
            timeout: 10000
        }
    );
});

originInput.addEventListener("input", () => {
    delete originInput.dataset.lat;
    delete originInput.dataset.lon;
});

// GEOCODIFICACIÓN

async function geoNominatim(query) {
    const data = await fetchJSON(
        `https://nominatim.openstreetmap.org/search?format=json&accept-language=es&limit=1&q=${encodeURIComponent(query)}`
    );

    if (!data.length) return null;

    return {
        lat: Number(data[0].lat),
        lon: Number(data[0].lon),
        name: data[0].display_name,
        short: data[0].display_name.split(",")[0].trim()
    };
}

async function geoPhoton(query) {
    const data = await fetchJSON(
        `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(query)}`
    );

    if (!data.features || !data.features.length) {
        return null;
    }

    const feature = data.features[0];
    const properties = feature.properties || {};

    const short =
        properties.name || properties.city || query;

    const name = [
        properties.name,
        properties.city,
        properties.state,
        properties.country
    ].filter(Boolean).join(", ");

    return {
        lat: Number(feature.geometry.coordinates[1]),
        lon: Number(feature.geometry.coordinates[0]),
        name: name || short,
        short
    };
}

async function geoOpenMeteo(query) {
    const data = await fetchJSON(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=es`
    );

    if (!data.results || !data.results.length) {
        return null;
    }

    const result = data.results[0];

    return {
        lat: Number(result.latitude),
        lon: Number(result.longitude),
        name: [
            result.name,
            result.admin1,
            result.country
        ].filter(Boolean).join(", "),
        short: result.name
    };
}

async function geocode(rawQuery) {
    const cleanQuery = rawQuery.trim();

    const query =
        ALIASES[cleanQuery.toLowerCase()] || cleanQuery;

    const providers = [
        ["Nominatim", geoNominatim],
        ["Photon", geoPhoton],
        ["Open-Meteo", geoOpenMeteo]
    ];

    const failures = [];
    let providerResponded = false;

    for (const [name, provider] of providers) {
        try {
            const result = await provider(query);

            providerResponded = true;

            if (result) return result;

        } catch (error) {
            failures.push(`${name}: ${error.message}`);
            console.warn(name, error);
        }
    }

    if (!providerResponded) {
        const error = new Error(
            "ningún buscador de lugares respondió"
        );

        error.details = failures;

        throw error;
    }

    return null;
}

// RUTAS OSRM

async function getRoutes(transport, origin, destination) {
    const coordinates =
        `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;

    const params =
        "?overview=full&geometries=geojson&alternatives=true&steps=true";

    const urls = [
        `https://routing.openstreetmap.de/${PROFILES[transport]}/route/v1/driving/${coordinates}${params}`
    ];

    if (transport === "car") {
        urls.push(
            `https://router.project-osrm.org/route/v1/driving/${coordinates}${params}`
        );
    }

    const failures = [];

    for (const url of urls) {
        try {
            const data = await fetchJSON(url, 15000);

            if (
                data.code === "Ok" &&
                data.routes &&
                data.routes.length
            ) {
                return {
                    routes: data.routes.sort(
                        (a, b) => a.duration - b.duration
                    ),
                    fallos: failures
                };
            }

            failures.push(
                `${new URL(url).hostname}: ${data.code || "sin ruta"}`
            );

        } catch (error) {
            failures.push(
                `${new URL(url).hostname}: ${error.message}`
            );
        }
    }

    return {
        routes: null,
        fallos: failures
    };
}

// CLIMA OPEN-METEO

async function getWeather(lat, lon) {
    try {
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day" +
            "&timezone=auto";

        const data = await fetchJSON(url);

        return data.current || null;

    } catch (error) {
        console.warn("No se pudo obtener el clima:", error);
        return null;
    }
}

function describeWeather(code, isDay) {
    const day = isDay !== 0;

    const table = {
        0: ["Despejado", day ? "☀️" : "🌙", "ok"],
        1: ["Mayormente despejado", day ? "🌤️" : "🌙", "ok"],
        2: ["Parcialmente nublado", "⛅", "ok"],
        3: ["Nublado", "☁️", "ok"],
        45: ["Niebla", "🌫️", "warn"],
        48: ["Niebla con escarcha", "🌫️", "warn"],
        51: ["Llovizna ligera", "🌦️", "warn"],
        53: ["Llovizna", "🌦️", "warn"],
        55: ["Llovizna intensa", "🌧️", "warn"],
        56: ["Llovizna helada", "🌧️", "bad"],
        57: ["Llovizna helada intensa", "🌧️", "bad"],
        61: ["Lluvia ligera", "🌧️", "warn"],
        63: ["Lluvia moderada", "🌧️", "warn"],
        65: ["Lluvia fuerte", "🌧️", "bad"],
        66: ["Lluvia helada", "🌧️", "bad"],
        67: ["Lluvia helada fuerte", "🌧️", "bad"],
        71: ["Nevada ligera", "🌨️", "warn"],
        73: ["Nevada moderada", "🌨️", "bad"],
        75: ["Nevada fuerte", "❄️", "bad"],
        77: ["Granizo fino", "🌨️", "warn"],
        80: ["Chubascos ligeros", "🌦️", "warn"],
        81: ["Chubascos", "🌧️", "warn"],
        82: ["Chubascos violentos", "⛈️", "bad"],
        85: ["Chubascos de nieve", "🌨️", "warn"],
        86: ["Chubascos de nieve fuertes", "❄️", "bad"],
        95: ["Tormenta eléctrica", "⛈️", "bad"],
        96: ["Tormenta con granizo", "⛈️", "bad"],
        99: ["Tormenta con granizo fuerte", "⛈️", "bad"]
    };

    const [text, icon, level] =
        table[code] || [
            "Condición desconocida",
            "🌡️",
            "ok"
        ];

    return { text, icon, level };
}

// RECOMENDACIONES DEL CLIMA

function buildAdvice(originWeather, destinationWeather, transport) {
    const rank = {
        ok: 0,
        warn: 1,
        bad: 2
    };

    let level = "ok";
    const tips = [];

    const bump = (newLevel) => {
        if (rank[newLevel] > rank[level]) {
            level = newLevel;
        }
    };

    const check = (weather, place) => {
        if (!weather) return;

        const info = describeWeather(
            weather.weather_code,
            weather.is_day
        );

        bump(info.level);

        if (info.level === "bad") {
            tips.push(
                `${info.icon} ${info.text} en ${place}: lo mejor es esperar a que mejore.`
            );

        } else if (info.level === "warn") {
            tips.push(
                `${info.icon} ${info.text} en ${place}: ` +
                (transport === "car"
                    ? "maneja con precaución."
                    : "lleva impermeable o protección.")
            );
        }

        const wind = Math.round(weather.wind_speed_10m);

        if (wind >= 50) {
            bump("bad");
            tips.push(
                `💨 Viento muy fuerte (${wind} km/h) en ${place}.`
            );

        } else if (wind >= 30) {
            bump("warn");
            tips.push(
                `💨 Viento fuerte (${wind} km/h) en ${place}.`
            );
        }

        if (weather.temperature_2m >= 35) {
            bump("warn");
            tips.push(`🥵 Mucho calor en ${place}: lleva agua.`);

        } else if (weather.temperature_2m <= 3) {
            bump("warn");
            tips.push(`🥶 Hace frío en ${place}: abrígate.`);
        }
    };

    check(originWeather, "el origen");
    check(destinationWeather, "el destino");

    if (!originWeather && !destinationWeather) {
        bump("warn");
        tips.push(
            "No se pudo obtener el clima en este momento."
        );
    }

    if (!tips.length) {
        tips.push(
            "☀️ Condiciones favorables en el origen y el destino."
        );
    }

    const title = {
        ok: "✅ Buen clima para el viaje",
        warn: "⚠️ Viaja con precaución",
        bad: "🚫 Clima adverso"
    }[level];

    return { level, title, tips };
}

// INDICACIONES

function stepText(step) {
    const maneuver = step.maneuver || {};
    const name = step.name ? ` por ${step.name}` : "";

    const modifier = {
        left: "a la izquierda",
        right: "a la derecha",
        "slight left": "ligeramente a la izquierda",
        "slight right": "ligeramente a la derecha",
        "sharp left": "cerrado a la izquierda",
        "sharp right": "cerrado a la derecha",
        straight: "recto",
        uturn: "en U"
    }[maneuver.modifier] || "";

    switch (maneuver.type) {
        case "depart":
            return `Comienza${name}`;

        case "arrive":
            return "Has llegado a tu destino";

        case "turn":
            return `Gira ${modifier}${name}`;

        case "continue":
        case "new name":
            return `Continúa ${modifier || "recto"}${name}`;

        case "merge":
            return `Incorpórate ${modifier}${name}`.replace("  ", " ");

        case "on ramp":
            return `Toma el acceso${name}`;

        case "off ramp":
            return `Toma la salida${name}`;

        case "fork":
            return `Mantente ${modifier}${name}`;

        case "end of road":
            return `Al final de la vía gira ${modifier}${name}`;

        case "roundabout":
        case "rotary":
        case "roundabout turn":
            return `En la glorieta toma la salida ${maneuver.exit || ""}${name}`.replace("  ", " ");

        default:
            return `Continúa${name}`;
    }
}

// DIAGNÓSTICO

async function runDiagnostics() {
    const tests = [
        ["Nominatim", () =>
            fetchJSON(
                "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=Toluca",
                8000
            )],

        ["Photon", () =>
            fetchJSON(
                "https://photon.komoot.io/api/?limit=1&q=Toluca",
                8000
            )],

        ["Open-Meteo geocoding", () =>
            fetchJSON(
                "https://geocoding-api.open-meteo.com/v1/search?name=Toluca&count=1",
                8000
            )],

        ["Open-Meteo clima", () =>
            fetchJSON(
                "https://api.open-meteo.com/v1/forecast?latitude=19.28&longitude=-99.65&current=temperature_2m",
                8000
            )],

        ["OSRM rutas", () =>
            fetchJSON(
                "https://router.project-osrm.org/route/v1/driving/-99.65,19.28;-99.60,19.30?overview=false",
                10000
            )]
    ];

    return Promise.all(
        tests.map(async ([name, test]) => {
            try {
                await test();

                return {
                    nombre: name,
                    ok: true,
                    msg: "funciona"
                };

            } catch (error) {
                return {
                    nombre: name,
                    ok: false,
                    msg: error.message
                };
            }
        })
    );
}

function diagnosticHTML(results) {
    const allFail = results.every(
        result => !result.ok
    );

    const list = results.map(result => `
        <li style="padding:6px 0;text-align:left;border-bottom:1px solid rgba(0,210,255,.2);">
            ${result.ok ? "✅" : "❌"}
            <strong>${escapeHTML(result.nombre)}</strong>
            <span style="color:#5e82a6">
                — ${escapeHTML(result.msg)}
            </span>
        </li>
    `).join("");

    const advice = allFail
        ? "Ningún servicio responde: revisa tu internet, VPN, antivirus o bloqueadores."
        : "Algunos servicios no responden. La aplicación necesita al menos un buscador y un servidor de rutas.";

    return `
        <ul style="list-style:none;max-width:560px;margin:16px auto 0;font-size:13px;">
            ${list}
        </ul>
        <p style="margin-top:14px;">${advice}</p>`;
}

// MAPA LEAFLET

function makePin(letter, className) {
    return L.divIcon({
        className: "",
        html: `
            <div class="pin-marker ${className}">
                <span>${letter}</span>
            </div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 40]
    });
}

// SELECCIÓN DE RUTA CORREGIDA

function selectRoute(index) {
    if (
        !state ||
        !Array.isArray(state.routes) ||
        !state.routes[index] ||
        !map
    ) {
        return;
    }

    state.sel = index;

    const route = state.routes[index];
    const currentMap = map;

    routeLayers.forEach((line, lineIndex) => {
        if (
            !line ||
            map !== currentMap ||
            !currentMap.hasLayer(line)
        ) {
            return;
        }

        try {
            if (lineIndex === index) {
                line.setStyle({
                    color: "#0066ff",
                    weight: 7,
                    opacity: 0.95
                });

                // Protección contra el error parentNode
                if (
                    line._path &&
                    line._path.parentNode
                ) {
                    line.bringToFront();
                }

            } else {
                line.setStyle({
                    color: "#6b7a90",
                    weight: 5,
                    opacity: 0.7
                });
            }

        } catch (error) {
            console.warn(
                "No se pudo actualizar una ruta:",
                error
            );
        }
    });

    // Ajustar el mapa a la ruta seleccionada

    const selectedLayer = routeLayers[index];

    if (
        selectedLayer &&
        map === currentMap &&
        currentMap.hasLayer(selectedLayer)
    ) {
        try {
            const bounds = selectedLayer.getBounds();

            if (bounds.isValid()) {
                currentMap.fitBounds(bounds, {
                    padding: [40, 40]
                });
            }

        } catch (error) {
            console.warn(
                "Error ajustando el mapa:",
                error
            );
        }
    }

    // DISTANCIA Y TIEMPO

    const distanceElement = $("statDist");
    const timeElement = $("statTime");
    const stepsList = $("stepsList");

    if (distanceElement) {
        distanceElement.textContent =
            fmtDist(route.distance);
    }

    if (timeElement) {
        timeElement.textContent =
            fmtTime(route.duration);
    }

    // BOTÓN ACTIVO

    document.querySelectorAll(".route-chip").forEach(chip => {
        chip.classList.toggle(
            "active",
            Number(chip.dataset.i) === index
        );
    });

    // INDICACIONES

    const steps = (route.legs || []).flatMap(
        leg => leg.steps || []
    );

    if (stepsList) {
        stepsList.innerHTML = steps.map(step => `
            <li>
                <span class="step-text">
                    ${escapeHTML(stepText(step))}
                </span>

                <span class="step-dist">
                    ${step.distance ? fmtDist(step.distance) : ""}
                </span>
            </li>
        `).join("");
    }
}

// DIBUJAR MAPA

function drawMap() {
    const mapElement = $("map");

    if (!mapElement) {
        throw new Error(
            "No se encontró el contenedor del mapa."
        );
    }

    if (typeof L === "undefined") {
        throw new Error(
            "Leaflet no está cargado. Revisa index.html."
        );
    }

    if (!state || !state.routes || !state.routes.length) {
        throw new Error(
            "No hay una ruta disponible para dibujar."
        );
    }

    if (map) {
        destroyMap();
    }

    if (mapElement._leaflet_id) {
        delete mapElement._leaflet_id;
    }

    mapElement.replaceChildren();

    const currentMap = L.map(mapElement, {
        zoomControl: true
    });

    map = currentMap;

    try {
        const streets = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
            {
                attribution: "Tiles &copy; Esri",
                maxZoom: 19
            }
        );

        const satellite = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            {
                attribution: "Tiles &copy; Esri",
                maxZoom: 19
            }
        );

        streets.addTo(currentMap);

        L.control.layers({
            "🗺️ Calles": streets,
            "🛰️ Satélite": satellite
        }, null, {
            position: "topright",
            collapsed: true
        }).addTo(currentMap);

        const { o, d, routes } = state;

        // CREAR TODAS LAS RUTAS

        routeLayers = routes.map(route => {
            const coordinates =
                route.geometry.coordinates.map(
                    ([longitude, latitude]) => [
                        latitude,
                        longitude
                    ]
                );

            const line = L.polyline(coordinates, {
                color: "#6b7a90",
                weight: 5,
                opacity: 0.7
            }).addTo(currentMap);

            return line;
        });

        // EVENTOS DE LAS RUTAS

        routeLayers.forEach((line, index) => {
            line.on("click", () => {
                if (map !== currentMap) return;

                selectRoute(index);
            });
        });

        // MARCADOR DE ORIGEN

        L.marker([o.lat, o.lon], {
            icon: makePin("A", "a")
        }).addTo(currentMap)
          .bindTooltip(escapeHTML(o.short));

        // MARCADOR DE DESTINO

        L.marker([d.lat, d.lon], {
            icon: makePin("B", "b")
        }).addTo(currentMap)
          .bindTooltip(escapeHTML(d.short));

        // SELECCIONAR RUTA CUANDO EL MAPA ESTÉ PREPARADO

        requestAnimationFrame(() => {
            if (
                map !== currentMap ||
                !currentMap.getContainer().isConnected
            ) {
                return;
            }

            currentMap.invalidateSize();

            selectRoute(0);
        });

    } catch (error) {
        if (map === currentMap) {
            destroyMap();
        }

        throw error;
    }
}

// TARJETAS DEL CLIMA

function wxCard(label, place, weather) {
    if (!weather) {
        return `
            <div class="wx-card">
                <span class="label">${label}</span>
                <h4>${escapeHTML(place.short)}</h4>
                <p class="wx-none">
                    Clima no disponible en este momento.
                </p>
            </div>`;
    }

    const info = describeWeather(
        weather.weather_code,
        weather.is_day
    );

    return `
        <div class="wx-card">
            <span class="label">${label}</span>

            <h4>${escapeHTML(place.short)}</h4>

            <div class="wx-main">
                <div class="wx-icon">${info.icon}</div>

                <div>
                    <div class="wx-temp">
                        ${Math.round(weather.temperature_2m)}
                        <small>°C</small>
                    </div>

                    <div class="wx-desc">${info.text}</div>
                </div>
            </div>

            <div class="wx-meta">

                <div class="data-box">
                    <span>SENSACIÓN</span>
                    <strong>
                        ${Math.round(weather.apparent_temperature)}°C
                    </strong>
                </div>

                <div class="data-box">
                    <span>HUMEDAD</span>
                    <strong>
                        ${weather.relative_humidity_2m}%
                    </strong>
                </div>

                <div class="data-box">
                    <span>VIENTO</span>
                    <strong>
                        ${Math.round(weather.wind_speed_10m)} km/h
                    </strong>
                </div>

                <div class="data-box">
                    <span>LLUVIA</span>
                    <strong>${weather.precipitation} mm</strong>
                </div>

            </div>
        </div>`;
}

// MOSTRAR RESULTADOS

function renderResult() {
    const {
        o,
        d,
        routes,
        wo,
        wd,
        transport
    } = state;

    const advice = buildAdvice(wo, wd, transport);

    destroyMap();

    resultArea.innerHTML = `
        <div class="location-content">

            <aside class="location-info">

                <div class="location-heading">
                    <div class="pin">🧭</div>

                    <div>
                        <span class="label">Ruta calculada</span>

                        <h2>
                            ${escapeHTML(o.short)}
                            →
                            ${escapeHTML(d.short)}
                        </h2>
                    </div>
                </div>

                <div class="coordinates">

                    <div class="data-box">
                        <span>DISTANCIA</span>
                        <strong id="statDist">—</strong>
                    </div>

                    <div class="data-box">
                        <span>TIEMPO</span>
                        <strong id="statTime">—</strong>
                    </div>

                </div>

                <div class="route-options" id="routeOptions">

                    ${routes.map((route, index) => `
                        <button
                            class="route-chip${index === 0 ? " active" : ""}"
                            data-i="${index}"
                        >
                            <b>
                                ${index === 0
                                    ? "⭐ Mejor ruta"
                                    : "Alternativa " + index}
                            </b>

                            <span>
                                ${fmtTime(route.duration)}
                                ·
                                ${fmtDist(route.distance)}
                            </span>
                        </button>
                    `).join("")}

                </div>

                <div class="advice ${advice.level}">
                    <strong>${advice.title}</strong>

                    <ul>
                        ${advice.tips.map(
                            tip => `<li>${escapeHTML(tip)}</li>`
                        ).join("")}
                    </ul>
                </div>

            </aside>

            <section class="map-section">

                <div class="map-header">
                    <div>
                        <span class="map-label">
                            Mapa interactivo
                        </span>

                        <h3>Ruta ${MODE_LABEL[transport]}</h3>
                    </div>

                    <div class="map-status">EN VIVO</div>
                </div>

                <div id="map"></div>

            </section>

            <section class="weather-panel">

                <span class="label">
                    Clima en tiempo real
                </span>

                <div class="wx-compare">
                    ${wxCard("🟢 Origen", o, wo)}
                    ${wxCard("🔴 Destino", d, wd)}
                </div>

            </section>

            <section class="steps-panel">

                <span class="label">
                    Indicaciones paso a paso
                </span>

                <ol class="steps-list" id="stepsList"></ol>

            </section>

        </div>

        <div class="success-footer">
            <span>✓</span>
            Ruta y clima sincronizados con éxito.
        </div>`;

    const routeOptions = $("routeOptions");

    if (routeOptions) {
        routeOptions.addEventListener("click", (event) => {
            const chip = event.target.closest(".route-chip");

            if (chip) {
                selectRoute(Number(chip.dataset.i));
            }
        });
    }

    drawMap();
}

// DIAGNÓSTICO DE ERRORES

async function mostrarErrorConDiagnostico(title, message) {
    showMessage(
        "🔎",
        title,
        `${message}<br><br>Revisando qué servicios responden...`
    );

    const results = await runDiagnostics();

    showMessage(
        "📡",
        title,
        `${message}${diagnosticHTML(results)}`
    );
}

// BÚSQUEDA PRINCIPAL

async function buscar() {
    const currentToken = ++searchToken;

    const originText = originInput.value.trim();
    const destinationText = destInput.value.trim();

    if (!originText || !destinationText) {
        showMessage(
            "⚠️",
            "Faltan datos",
            "Escribe un origen y un destino, o usa el botón 📍 para tu ubicación."
        );

        return;
    }

    searchBtn.disabled = true;
    loading.classList.remove("hidden");

    let step = "buscar el origen";

    try {
        let origin;

        const usesGPS =
            originInput.dataset.lat &&
            originInput.dataset.lon;

        if (usesGPS) {
            origin = {
                lat: Number(originInput.dataset.lat),
                lon: Number(originInput.dataset.lon),
                name: "Mi ubicación actual",
                short: "Mi ubicación"
            };

        } else {
            origin = await geocode(originText);

            if (!origin) {
                showMessage(
                    "🛑",
                    "Origen no encontrado",
                    `No se encontraron datos para "${escapeHTML(originText)}". Prueba con el nombre completo.`
                );

                return;
            }

            await sleep(1100);
        }

        if (currentToken !== searchToken) return;

        step = "buscar el destino";

        const destination =
            await geocode(destinationText);

        if (!destination) {
            showMessage(
                "🛑",
                "Destino no encontrado",
                `No se encontraron datos para "${escapeHTML(destinationText)}". Prueba con el nombre completo.`
            );

            return;
        }

        if (currentToken !== searchToken) return;

        step = "calcular la ruta y el clima";

        const transport = mode;

        const [
            routeResult,
            originWeather,
            destinationWeather
        ] = await Promise.all([
            getRoutes(transport, origin, destination),

            getWeather(
                origin.lat,
                origin.lon
            ),

            getWeather(
                destination.lat,
                destination.lon
            )
        ]);

        if (currentToken !== searchToken) return;

        if (!routeResult.routes) {
            await mostrarErrorConDiagnostico(
                "No se pudo calcular la ruta",

                `Los servidores de rutas no respondieron (${escapeHTML(routeResult.fallos.join(" | "))}).`
            );

            return;
        }

        step = "mostrar el resultado";

        state = {
            o: origin,
            d: destination,
            routes: routeResult.routes,
            wo: originWeather,
            wd: destinationWeather,
            transport,
            sel: 0
        };

        renderResult();

    } catch (error) {
        console.error(
            "Error durante la búsqueda:",
            error
        );

        const detail = error.details
            ? error.details.map(escapeHTML).join("<br>")
            : escapeHTML(error.message || error);

        if (currentToken === searchToken) {
            await mostrarErrorConDiagnostico(
                "Error de conexión",

                `No se pudo ${step}.<br><small style="color:#5e82a6">${detail}</small>`
            );
        }

    } finally {
        if (currentToken === searchToken) {
            loading.classList.add("hidden");
            searchBtn.disabled = false;
        }
    }
}

// EVENTOS

searchBtn.addEventListener("click", buscar);

[originInput, destInput].forEach(input => {
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            buscar();
        }
    });
});
