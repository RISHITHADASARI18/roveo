import type { Coordinates, DiscoveredPlace, PlaceDiscoveryResult } from "./types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

type Bounds = { south: number; north: number; west: number; east: number };

function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function haversineKm(a: Coordinates, b: Coordinates) {
  const p = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * p;
  const dLon = (b.longitude - a.longitude) * p;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * p) * Math.cos(b.latitude * p) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function groupFor(text: string): DiscoveredPlace["group"] {
  const value = text.toLowerCase();
  if (/museum|gallery|temple|church|mosque|worship|theatre|cultural|art/.test(value)) return "Culture";
  if (/fort|palace|monument|historic|heritage|memorial|ruin|castle|archaeological/.test(value)) return "History";
  if (/park|garden|beach|waterfall|lake|hill|mountain|nature|wildlife|viewpoint|forest|backwater/.test(value)) return "Nature";
  if (/amusement|theme|water park|zoo|aquarium|activity|attraction/.test(value)) return "Attraction";
  return "Activity";
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function insideBounds(point: Coordinates, bounds?: Bounds) {
  if (!bounds) return true;
  return point.latitude >= bounds.south && point.latitude <= bounds.north &&
    point.longitude >= bounds.west && point.longitude <= bounds.east;
}

async function destinationCoverage(destination: string, fallback: Coordinates) {
  try {
    const params = new URLSearchParams({
      q: destination, format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en",
    });
    const response = await fetchWithTimeout(NOMINATIM_URL + "?" + params, {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination geocoding)" },
      cache: "no-store",
    }, 4000);
    if (!response.ok) return { center: fallback };
    const data = await response.json();
    const first = Array.isArray(data) ? data[0] : null;
    const latitude = Number(first?.lat), longitude = Number(first?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { center: fallback };
    const box = Array.isArray(first?.boundingbox) ? first.boundingbox.map(Number) : [];
    if (box.length !== 4 || box.some((v: number) => !Number.isFinite(v))) {
      return { center: { latitude, longitude } };
    }
    return {
      center: { latitude, longitude },
      bounds: { south: box[0], north: box[1], west: box[2], east: box[3] } as Bounds,
    };
  } catch {
    return { center: fallback };
  }
}

function buildCells(bounds: Bounds) {
  const height = Math.max(0, bounds.north - bounds.south);
  const width = Math.max(0, bounds.east - bounds.west);
  if (!height || !width) return [bounds];
  const aspect = width / Math.max(height, 0.1);
  const columns = aspect >= 1.5 ? 2 : 1;
  const rows = aspect <= 0.67 ? 2 : 1;
  const cells: Bounds[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push({
        south: bounds.south + height * row / rows,
        north: bounds.south + height * (row + 1) / rows,
        west: bounds.west + width * column / columns,
        east: bounds.west + width * (column + 1) / columns,
      });
    }
  }
  return cells.slice(0, 4);
}

async function overpassCell(cell: Bounds): Promise<DiscoveredPlace[]> {
  const bbox = [cell.south, cell.west, cell.north, cell.east].join(",");
  const query = [
    "[out:json][timeout:8];", "(",
    'nwr["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium|artwork"](' + bbox + ");",
    'nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|heritage"](' + bbox + ");",
    'nwr["leisure"~"park|garden|nature_reserve|water_park"](' + bbox + ");",
    'nwr["natural"~"waterfall|peak|cave|beach"](' + bbox + ");",
    'nwr["amenity"~"place_of_worship|arts_centre|theatre"](' + bbox + ");",
    ");", "out center tags;",
  ].join("\n");

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Roveo/1.0 (travel planner; place discovery)",
        },
        body: "data=" + encodeURIComponent(query),
        cache: "no-store",
      }, 9000);
      if (!response.ok) continue;
      const data = await response.json();
      return (Array.isArray(data.elements) ? data.elements : []).map((element: any) => {
        const tags = element?.tags ?? {};
        const name = String(tags["name:en"] ?? tags.name ?? "").trim();
        const latitude = Number(element.lat ?? element.center?.lat);
        const longitude = Number(element.lon ?? element.center?.lon);
        if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const type = String(tags.tourism ?? tags.historic ?? tags.leisure ?? tags.natural ?? tags.amenity ?? "place").toLowerCase();
        const address = [
          tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"],
          tags["addr:city"] ?? tags["addr:town"] ?? tags["addr:village"],
          tags["addr:state"], tags["addr:country"],
        ].filter(Boolean).join(", ");
        return {
          id: "overpass-" + element.type + "-" + element.id,
          name, type, group: groupFor(name + " " + JSON.stringify(tags)),
          latitude, longitude, distanceKm: 0,
          description: String(tags["description:en"] ?? tags.description ?? "").trim() || "Real place record from OpenStreetMap.",
          website: String(tags.website ?? tags["contact:website"] ?? "").trim() || undefined,
          wikipedia: String(tags.wikipedia ?? "").trim() || undefined,
          address: address || undefined,
          openingHours: String(tags.opening_hours ?? "").trim() || undefined,
        } as DiscoveredPlace;
      }).filter(Boolean) as DiscoveredPlace[];
    } catch {
      // Try the next public Overpass endpoint.
    }
  }
  return [];
}

async function wikipediaFallback(center: Coordinates, radiusMeters: number) {
  try {
    const params = new URLSearchParams({
      action: "query", generator: "geosearch", ggsprimary: "all", ggsnamespace: "0",
      ggscoord: center.latitude + "|" + center.longitude,
      ggsradius: String(Math.min(radiusMeters, 50000)), ggslimit: "50",
      prop: "extracts|info|coordinates", exintro: "1", explaintext: "1",
      exchars: "600", inprop: "url", format: "json", origin: "*",
    });
    const response = await fetchWithTimeout("https://en.wikipedia.org/w/api.php?" + params, {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; place discovery)" },
      cache: "no-store",
    }, 4000);
    if (!response.ok) return [] as DiscoveredPlace[];
    const data = await response.json();
    const pages = Object.values(data.query?.pages ?? {}) as any[];
    return pages.map((page: any) => {
      const coordinate = page.coordinates?.[0];
      const latitude = Number(coordinate?.lat), longitude = Number(coordinate?.lon);
      const name = String(page.title ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const description = String(page.extract ?? "").trim();
      return {
        id: "wikipedia-" + String(page.pageid ?? normalizeName(name)),
        name, type: "landmark", group: groupFor(name + " " + description),
        latitude, longitude, distanceKm: haversineKm(center, { latitude, longitude }),
        description: description || "Named destination place.", website: page.fullurl,
      } as DiscoveredPlace;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [] as DiscoveredPlace[];
  }
}

async function googleFallback(destination: string, bounds: Bounds | undefined, center: Coordinates, limit: number) {
  const key = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [] as DiscoveredPlace[];
  const body: Record<string, unknown> = {
    textQuery: "top tourist attractions and must visit places in " + destination,
    pageSize: Math.min(limit, 20), languageCode: "en", rankPreference: "RELEVANCE",
  };
  if (bounds) {
    body.locationRestriction = {
      rectangle: {
        low: { latitude: bounds.south, longitude: bounds.west },
        high: { latitude: bounds.north, longitude: bounds.east },
      },
    };
  } else {
    const latDelta = 0.25;
    const lonDelta = 0.25 / Math.max(Math.cos(center.latitude * Math.PI / 180), 0.25);
    body.locationRestriction = {
      rectangle: {
        low: { latitude: center.latitude - latDelta, longitude: center.longitude - lonDelta },
        high: { latitude: center.latitude + latDelta, longitude: center.longitude + lonDelta },
      },
    };
  }
  try {
    const response = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        Accept: "application/json", "Content-Type": "application/json", "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.websiteUri",
      },
      body: JSON.stringify(body), cache: "no-store",
    }, 5000);
    if (!response.ok) return [] as DiscoveredPlace[];
    const data = await response.json();
    return (Array.isArray(data.places) ? data.places : []).map((place: any, index: number) => {
      const latitude = Number(place.location?.latitude), longitude = Number(place.location?.longitude);
      const name = String(place.displayName?.text ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        id: "google-" + String(place.id ?? index), name,
        type: String(place.primaryType ?? place.types?.[0] ?? "place"),
        group: groupFor(name + " " + String(place.primaryType ?? "") + " " + (place.types ?? []).join(" ")),
        latitude, longitude, distanceKm: haversineKm(center, { latitude, longitude }),
        description: String(place.formattedAddress ?? "").trim() || undefined,
        address: String(place.formattedAddress ?? "").trim() || undefined,
        website: String(place.websiteUri ?? "").trim() || undefined,
      } as DiscoveredPlace;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [] as DiscoveredPlace[];
  }
}

export async function discoverBroadPlaces(
  destination: string,
  _legacyRadiusMeters = 0,
  maxResults = 200,
  desiredQuery = "",
): Promise<PlaceDiscoveryResult> {
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 100);
  const coverage = await destinationCoverage(destination, { latitude: 0, longitude: 0 });

  if (coverage.center.latitude === 0 && coverage.center.longitude === 0) {
    throw new Error("Could not locate destination: " + destination);
  }

  // Google is optional. Only one bounded Google request is made.
  if (!desiredQuery) {
    const googlePlaces = await googleFallback(destination, coverage.bounds, coverage.center, limit);
    const valid = googlePlaces.filter((place) => insideBounds(place, coverage.bounds));
    if (valid.length) {
      return { center: coverage.center, places: valid.slice(0, limit), source: "google", fetchedAt: new Date().toISOString() };
    }
  }

  // Free OSM fallback: at most four geographic cells, queried in parallel.
  const cells = coverage.bounds ? buildCells(coverage.bounds) : [{
    south: coverage.center.latitude - 0.15, north: coverage.center.latitude + 0.15,
    west: coverage.center.longitude - 0.15, east: coverage.center.longitude + 0.15,
  }];
  const cellResults = await Promise.all(cells.map(overpassCell));
  const unique = new Map<string, DiscoveredPlace>();

  for (const place of cellResults.flat()) {
    if (!insideBounds(place, coverage.bounds)) continue;
    const key = normalizeName(place.name);
    if (!key) continue;
    const existing = unique.get(key);
    if (!existing || JSON.stringify(place).length > JSON.stringify(existing).length) unique.set(key, place);
  }

  let places = [...unique.values()].map((place) => ({
    ...place, distanceKm: haversineKm(coverage.center, place),
  }));

  // One small supplementary request only if OSM produced very few results.
  if (places.length < Math.min(limit, 20)) {
    const radiusMeters = coverage.bounds
      ? Math.min(50000, Math.max(5000, Math.ceil(Math.max(
          coverage.bounds.north - coverage.bounds.south,
          coverage.bounds.east - coverage.bounds.west,
        ) * 111000 / 2)))
      : 25000;
    for (const place of await wikipediaFallback(coverage.center, radiusMeters)) {
      if (!insideBounds(place, coverage.bounds)) continue;
      const key = normalizeName(place.name);
      if (key && !unique.has(key)) unique.set(key, place);
    }
    places = [...unique.values()].map((place) => ({ ...place, distanceKm: haversineKm(coverage.center, place) }));
  }

  if (desiredQuery) {
    const query = desiredQuery.toLowerCase();
    places = places.filter((place) => (place.name + " " + place.description + " " + place.type).toLowerCase().includes(query));
  }

  places.sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name));

  if (!places.length) {
    throw new Error("No live places were returned for " + destination + ". The destination was located, but the place providers returned no usable records.");
  }

  return {
    center: coverage.center,
    places: places.slice(0, limit),
    source: "openstreetmap",
    fetchedAt: new Date().toISOString(),
  };
}
