import type { Coordinates, DiscoveredPlace, PlaceDiscoveryResult } from "./types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

type Bounds = { south: number; north: number; west: number; east: number };\ntype DestinationCoverage = { center: Coordinates; bounds?: Bounds };

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

async function destinationCoverage(destination: string, fallback: Coordinates): Promise<DestinationCoverage> {
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
  // Large regions such as Kerala must be split into a real 2x2 grid.
  // Using only two long strips makes each Overpass query too expensive and
  // commonly causes the public endpoint to time out with an empty response.
  const largeRegion = Math.max(height, width) > 1.5;
  const aspect = width / Math.max(height, 0.1);
  const columns = largeRegion ? 2 : (aspect >= 1.5 ? 2 : 1);
  const rows = largeRegion ? 2 : (aspect <= 0.67 ? 2 : 1);
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
    "[out:json][timeout:10];", "(",
    'nwr["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium|artwork"](' + bbox + ");",
    'nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|heritage"](' + bbox + ");',
    'nwr["leisure"~"park|garden|nature_reserve|water_park"](' + bbox + ");",
    'nwr["natural"~"waterfall|peak|cave|beach"](' + bbox + ");",
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
      }, 11000);
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
          _importance: String(tags.wikidata ?? "").trim() ? 20 : 0,
          _tourism: String(tags.tourism ?? "").trim(),
          _historic: String(tags.historic ?? "").trim(),
          _natural: String(tags.natural ?? "").trim(),
          _leisure: String(tags.leisure ?? "").trim(),
          _heritage: String(tags.heritage ?? tags["heritage:operator"] ?? "").trim(),
        } as DiscoveredPlace & Record<string, unknown>;
      }).filter(Boolean) as DiscoveredPlace[];
    } catch {
      // Try the next public Overpass endpoint.
    }
  }
  return [];
}

async function wikipediaFallback(center: Coordinates, radiusMeters: number) {
  try {
    // Use the documented geosearch list API directly. It already returns
    // title + coordinates, so there is no fragile second-stage page lookup.
    const params = new URLSearchParams({
      action: "query", list: "geosearch", gsprimary: "all", gsnamespace: "0",
      gscoord: center.latitude + "|" + center.longitude,
      gsradius: String(Math.min(radiusMeters, 50000)), gslimit: "50",
      format: "json", origin: "*",
    });
    const response = await fetchWithTimeout("https://en.wikipedia.org/w/api.php?" + params, {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; place discovery)" },
      cache: "no-store",
    }, 5000);
    if (!response.ok) return [] as DiscoveredPlace[];
    const data = await response.json();
    const places = Array.isArray(data.query?.geosearch) ? data.query.geosearch : [];
    return places.map((place: any) => {
      const latitude = Number(place.lat), longitude = Number(place.lon);
      const name = String(place.title ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        id: "wikipedia-" + String(place.pageid ?? normalizeName(name)),
        name, type: "landmark", group: groupFor(name),
        latitude, longitude, distanceKm: haversineKm(center, { latitude, longitude }),
        description: "Named destination place from Wikipedia.",
        website: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_")),
        wikipedia: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_")),
        _importance: 35,
        _wikipedia: true,
      } as DiscoveredPlace & Record<string, unknown>;
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

function importanceScore(place: DiscoveredPlace & Record<string, unknown>) {
  const tourism = String(place._tourism ?? "").toLowerCase();
  const historic = String(place._historic ?? "").toLowerCase();
  const natural = String(place._natural ?? "").toLowerCase();
  const leisure = String(place._leisure ?? "").toLowerCase();
  const heritage = String(place._heritage ?? "").toLowerCase();
  const text = (place.name + " " + (place.description ?? "")).toLowerCase();
  let score = Number(place._importance ?? 0);

  const tourismScores: Record<string, number> = {
    attraction: 35, viewpoint: 30, museum: 28, theme_park: 28, zoo: 27,
    aquarium: 27, gallery: 22, information: 6,
  };
  const historicScores: Record<string, number> = {
    fort: 32, castle: 32, archaeological_site: 30, ruins: 27,
    monument: 20, memorial: 18, heritage: 24,
  };
  const naturalScores: Record<string, number> = {
    waterfall: 30, beach: 28, peak: 27, cave: 25,
  };
  const leisureScores: Record<string, number> = {
    nature_reserve: 24, park: 14, garden: 12, water_park: 20,
  };

  score += tourismScores[tourism] ?? 0;
  score += historicScores[historic] ?? 0;
  score += naturalScores[natural] ?? 0;
  score += leisureScores[leisure] ?? 0;
  if (heritage) score += 18;
  if (place.wikipedia) score += 22;
  if (place.website) score += 7;
  if (place.address) score += 3;
  if (/national park|wildlife sanctuary|palace|temple|church|mosque|sanctuary|reserve|falls|fort|museum|beach|lake|backwater|heritage|monument|viewpoint/.test(text)) score += 5;
  return score;
}

export async function discoverBroadPlaces(
  destination: string,
  _legacyRadiusMeters = 0,
  maxResults = 200,
  desiredQuery = "",
  storedCoverage?: DestinationCoverage,
): Promise<PlaceDiscoveryResult> {
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 100);
  const coverage = storedCoverage ?? await destinationCoverage(destination, { latitude: 0, longitude: 0 });

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
  console.info("Roveo places discovery:", {
    destination,
    cellCount: cells.length,
    overpassCounts: cellResults.map((items) => items.length),
  });

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

  places.sort((a, b) => {
    const scoreDiff = importanceScore(b as DiscoveredPlace & Record<string, unknown>) - importanceScore(a as DiscoveredPlace & Record<string, unknown>);
    return scoreDiff || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name);
  });

  if (!places.length) {
    throw new Error("No live places were returned for " + destination + ". The destination was located, but the place providers returned no usable records.");
  }

  return {
    center: coverage.center,
    places: places.slice(0, limit).map((place) => {
      const clean = { ...place } as DiscoveredPlace & Record<string, unknown>;
      delete clean._importance;
      delete clean._tourism;
      delete clean._historic;
      delete clean._natural;
      delete clean._leisure;
      delete clean._heritage;
      delete clean._wikipedia;
      return clean as DiscoveredPlace;
    }),
    source: "openstreetmap",
    fetchedAt: new Date().toISOString(),
  };
}
