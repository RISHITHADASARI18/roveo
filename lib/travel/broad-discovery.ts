import type { Coordinates, DiscoveredPlace, PlaceDiscoveryResult } from "./types";

// Vercel rebuild trigger: keep the corrected Overpass query syntax on main; every dynamic bbox is a template-literal interpolation.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

type Bounds = { south: number; north: number; west: number; east: number };
type DestinationScope = "state" | "district" | "city" | "place" | "unknown";
type DestinationCoverage = { center: Coordinates; bounds?: Bounds; scope?: DestinationScope; state?: string; district?: string };

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
  const providers = [
    async (): Promise<DestinationCoverage | null> => {
      const params = new URLSearchParams({
        q: destination,
        format: "jsonv2",
        limit: "1",
        addressdetails: "1",
        namedetails: "1",
        "accept-language": "en",
      });
      const response = await fetchWithTimeout(NOMINATIM_URL + "?" + params, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Roveo/1.0 (travel planner; destination geocoding)",
        },
        cache: "no-store",
      }, 5000);
      if (!response.ok) return null;
      const data = await response.json();
      const first = Array.isArray(data) ? data[0] : null;
      const latitude = Number(first?.lat);
      const longitude = Number(first?.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const box = Array.isArray(first?.boundingbox) ? first.boundingbox.map(Number) : [];
      const address = first?.address ?? {};
      const addressType = String(first?.addresstype ?? first?.type ?? "").toLowerCase();
      const scope: DestinationScope =
        addressType === "state" || address.state === first?.name ? "state" :
        addressType === "county" || addressType === "district" || Boolean(address.county && !address.city && !address.town) ? "district" :
        addressType === "city" || address.city ? "city" :
        "place";
      const bounds = box.length === 4 && box.every((value: number) => Number.isFinite(value))
        ? { south: box[0], north: box[1], west: box[2], east: box[3] }
        : undefined;
      return {
        center: { latitude, longitude },
        bounds,
        scope,
        state: String(address.state ?? "").trim() || undefined,
        district: String(address.county ?? "").trim() || undefined,
      };
    },
    async (): Promise<DestinationCoverage | null> => {
      // Free global fallback for older trips whose exact coordinates were
      // created before Roveo started storing selected location geometry.
      const params = new URLSearchParams({
        q: destination,
        limit: "1",
        lang: "en",
      });
      const response = await fetchWithTimeout(
        "https://photon.komoot.io/api/?" + params,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Roveo/1.0 (travel planner; destination geocoding)",
          },
          cache: "no-store",
        },
        5000,
      );
      if (!response.ok) return null;
      const data = await response.json();
      const feature = Array.isArray(data?.features) ? data.features[0] : null;
      const coordinates = feature?.geometry?.coordinates;
      const longitude = Number(coordinates?.[0]);
      const latitude = Number(coordinates?.[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const bbox = Array.isArray(feature?.bbox) ? feature.bbox.map(Number) : [];
      const properties = feature?.properties ?? {};
      const osmType = String(properties.osm_type ?? "").toLowerCase();
      const osmValue = String(properties.osm_value ?? "").toLowerCase();
      const scope: DestinationScope =
        osmValue === "state" ? "state" :
        osmValue === "county" || osmValue === "district" ? "district" :
        osmValue === "city" || osmValue === "town" ? "city" : "place";
      const bounds = bbox.length === 4 && bbox.every((value: number) => Number.isFinite(value))
        ? { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }
        : undefined;
      return {
        center: { latitude, longitude },
        bounds,
        scope,
        state: String(properties.state ?? "").trim() || undefined,
        district: String(properties.county ?? properties.district ?? "").trim() || undefined,
      };
    },
  ];

  for (const provider of providers) {
    try {
      const result = await provider();
      if (result) return result;
    } catch {
      // Try the next free global geocoder.
    }
  }

  // Last-resort free fallbacks for broad regions. These are only used when
  // both public geocoders are temporarily unavailable; they prevent a transient
  // geocoder outage from breaking an otherwise valid destination.
  const normalized = destination.trim().toLowerCase();
  if (normalized === "kerala" || normalized === "kerala, india") {
    return {
      center: { latitude: 10.8505, longitude: 76.2711 },
      bounds: { south: 8.17, north: 12.80, west: 74.85, east: 77.40 },
      scope: "state",
      state: "Kerala",
    };
  }

  if (Number.isFinite(fallback.latitude) && Number.isFinite(fallback.longitude) &&
      (fallback.latitude !== 0 || fallback.longitude !== 0)) {
    return { center: fallback, scope: "unknown" };
  }

  throw new Error("Could not locate destination: " + destination);
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
    "[out:json][timeout:10];",
    "(",
    `nwr["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium|artwork|information|picnic_site"](${bbox});`,
    `nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|heritage|manor|palace"](${bbox});`,
    `nwr["leisure"~"park|garden|nature_reserve|water_park|marina"](${bbox});`,
    `nwr["natural"~"waterfall|peak|cave|beach|lake|cliff|hot_spring|volcano|glacier"](${bbox});`,
    `nwr["man_made"~"lighthouse|pier|tower"](${bbox});`,
    `nwr["amenity"~"theatre|arts_centre|place_of_worship"](${bbox});`,
    // Geographic destinations: cities/towns are first-class travel results,
    // so major places such as Munnar and Alappuzha are not lost among POIs.
    `nwr["place"~"city|town|municipality|village"](${bbox});`,
    ");",
    "out center tags;",
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
        const type = String(tags.place ?? tags.tourism ?? tags.historic ?? tags.leisure ?? tags.natural ?? tags.man_made ?? tags.amenity ?? "place").toLowerCase();
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
          openingHours: String(tags.opening_hours ?? "").trim() || undefined
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
        wikipedia: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_"))
      } as DiscoveredPlace & Record<string, unknown>;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [] as DiscoveredPlace[];
  }
}

async function wikipediaDestinationSearch(destination: string): Promise<DiscoveredPlace[]> {
  try {
    const searchParams = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: "tourist attractions places to visit " + destination,
      srnamespace: "0",
      srlimit: "50",
      format: "json",
      origin: "*",
    });
    const searchResponse = await fetchWithTimeout(
      "https://en.wikipedia.org/w/api.php?" + searchParams,
      {
        headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination search)" },
        cache: "no-store",
      },
      6000,
    );
    if (!searchResponse.ok) return [] as DiscoveredPlace[];

    const searchData = await searchResponse.json();
    const results = Array.isArray(searchData?.query?.search) ? searchData.query.search : [];
    const titles = results
      .map((item: any) => String(item?.title ?? "").trim())
      .filter(Boolean)
      .slice(0, 50);

    if (!titles.length) return [];

    const coordinateParams = new URLSearchParams({
      action: "query",
      titles: titles.join("|"),
      prop: "coordinates",
      coprimary: "all",
      format: "json",
      origin: "*",
    });
    const coordinateResponse = await fetchWithTimeout(
      "https://en.wikipedia.org/w/api.php?" + coordinateParams,
      {
        headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination search)" },
        cache: "no-store",
      },
      6000,
    );
    if (!coordinateResponse.ok) return [];

    const coordinateData = await coordinateResponse.json();
    const pages = Object.values(coordinateData?.query?.pages ?? {}) as any[];

    return pages.map((page: any) => {
      const coordinate = Array.isArray(page?.coordinates) ? page.coordinates[0] : null;
      const latitude = Number(coordinate?.lat);
      const longitude = Number(coordinate?.lon);
      const name = String(page?.title ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      return {
        id: "wikipedia-search-" + String(page.pageid ?? normalizeName(name)),
        name,
        type: "landmark",
        group: groupFor(name),
        latitude,
        longitude,
        distanceKm: 0,
        description: "Named destination place from Wikipedia.",
        website: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_")),
        wikipedia: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_")),
      } as DiscoveredPlace;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [] as DiscoveredPlace[];
  }
}

const KERALA_CORE_PLACES = [
  "kochi", "fort kochi", "thiruvananthapuram", "trivandrum", "guruvayoor", "guruvayur",
  "munnar", "alappuzha", "alleppey", "thekkady", "wayanad", "kovalam", "varkala",
  "kozhikode", "calicut", "kumarakom", "bekal", "kollam", "wagamon", "vagamon",
  "malampuzha", "ponmudi", "jadayu earth center", "jatayu earth center", "athirappilly",
  "sree padmanabhaswamy temple", "padmanabhaswamy temple", "guruvayur temple",
  "sabarimala", "bekal fort", "kuttanad", "pookode lake", "poo kode lake",
] as const;

function isKeralaDestination(destination: string) {
  return /\bkerala\b/i.test(destination);
}

function isKeralaCorePlace(name: string) {
  const normalized = normalizeName(name);
  return KERALA_CORE_PLACES.some((item) => normalized === item || normalized.includes(item));
}

async function wikipediaExactPlaces(titles: string[]): Promise<DiscoveredPlace[]> {
  if (!titles.length) return [];
  try {
    const params = new URLSearchParams({
      action: "query",
      titles: titles.join("|"),
      prop: "coordinates|extracts",
      exintro: "1",
      explaintext: "1",
      exchars: "500",
      format: "json",
      origin: "*",
    });
    const response = await fetchWithTimeout(
      "https://en.wikipedia.org/w/api.php?" + params,
      { headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination search)" }, cache: "no-store" },
      6000,
    );
    if (!response.ok) return [];
    const data = await response.json();
    const pages = Object.values(data?.query?.pages ?? {}) as any[];
    return pages.map((page: any) => {
      const coordinate = Array.isArray(page?.coordinates) ? page.coordinates[0] : null;
      const latitude = Number(coordinate?.lat);
      const longitude = Number(coordinate?.lon);
      const name = String(page?.title ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        id: "wikipedia-core-" + String(page.pageid ?? normalizeName(name)),
        name,
        type: "landmark",
        group: groupFor(name + " " + String(page?.extract ?? "")),
        latitude,
        longitude,
        distanceKm: 0,
        description: String(page?.extract ?? "").trim() || "Major Kerala destination.",
        wikipedia: "https://en.wikipedia.org/wiki/" + encodeURIComponent(name.replaceAll(" ", "_")),
      } as DiscoveredPlace;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [];
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

function importanceScore(place: DiscoveredPlace) {
  const type = place.type.toLowerCase();
  const text = (place.name + " " + (place.description ?? "")).toLowerCase();
  let score = 0;
  // Core Kerala destinations and iconic landmarks must stay above secondary nature/POI results.
  if (isKeralaCorePlace(place.name)) score += 140;
  const typeScores: Record<string, number> = {
    // Major geographic destinations must outrank ordinary local POIs.
    city: 65, town: 62, municipality: 58, village: 24,
    attraction: 35, viewpoint: 30, museum: 28, theme_park: 28, zoo: 27,
    aquarium: 27, gallery: 22, fort: 32, castle: 32,
    archaeological_site: 30, ruins: 27, monument: 20, memorial: 18,
    waterfall: 10, beach: 20, peak: 12, cave: 10,
    nature_reserve: 8, park: 6, garden: 5, water_park: 12, landmark: 18,
  };
  score += typeScores[type] ?? 0;
  if (place.wikipedia) score += 22;
  if (place.website) score += 7;
  if (place.address) score += 3;
  if (/national park|wildlife sanctuary|palace|temple|church|mosque|sanctuary|reserve|falls|fort|museum|beach|lake|backwater|heritage|monument|viewpoint/.test(text)) score += 5;
  if (place.group === "Attraction") score += 5;
  if (place.group === "History") score += 4;
  if (place.group === "Nature") score += 4;
  return score;
}

export async function discoverBroadPlaces(
  destination: string,
  _legacyRadiusMeters = 0,
  maxResults = 200,
  desiredQuery = "",
  storedCoverage?: DestinationCoverage,
): Promise<PlaceDiscoveryResult> {
  // Keep discovery focused on a useful set of important places while ranking the strongest matches first.
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 100);
  let coverage = storedCoverage ?? await destinationCoverage(destination, { latitude: 0, longitude: 0 });
  // Trips created before scope-aware discovery only stored coordinates/bounds.
  // Resolve the destination once more to determine whether the query is a state,
  // district, city, or ordinary place, while retaining the stored geometry.
  if (storedCoverage && (!storedCoverage.scope || storedCoverage.scope === "unknown")) {
    try {
      const classified = await destinationCoverage(destination, storedCoverage.center);
      coverage = {
        ...coverage,
        scope: classified.scope,
        state: classified.state,
        district: classified.district,
        bounds: coverage.bounds ?? classified.bounds,
      };
    } catch {
      // Keep the stored trip geometry if classification is temporarily unavailable.
    }
  }

  if (coverage.center.latitude === 0 && coverage.center.longitude === 0) {
    throw new Error("Could not locate destination: " + destination);
  }

  // Scope controls the geographic search:
  // state = the whole state; district = the district plus a small surrounding
  // ring so nearby districts are useful; city/place = the geocoded area only.
  let searchBounds = coverage.bounds;
  if (coverage.scope === "district" && searchBounds) {
    const latPad = Math.max(0.25, Math.min(0.75, (searchBounds.north - searchBounds.south) * 0.35));
    const lonPad = Math.max(0.25, Math.min(0.75, (searchBounds.east - searchBounds.west) * 0.35));
    searchBounds = {
      south: searchBounds.south - latPad,
      north: searchBounds.north + latPad,
      west: searchBounds.west - lonPad,
      east: searchBounds.east + lonPad,
    };
  }

  // Keep the critical path bounded: public Overpass/Wikipedia services can be slow or rate-limited.
  // Discovery must still return useful places instead of leaving the page on “Finding places…”.
  const cells = searchBounds ? buildCells(searchBounds) : [{
    south: coverage.center.latitude - 0.15, north: coverage.center.latitude + 0.15,
    west: coverage.center.longitude - 0.15, east: coverage.center.longitude + 0.15,
  }];

  const [cellResults, wikiResults, coreResults, destinationResults] = await Promise.all([
    Promise.all(cells.map(overpassCell)),
    Promise.all(cells.map(async (cell) => {
      const cellCenter = {
        latitude: (cell.south + cell.north) / 2,
        longitude: (cell.west + cell.east) / 2,
      };
      const heightKm = (cell.north - cell.south) * 111;
      const widthKm = (cell.east - cell.west) * 111 * Math.max(Math.cos(cellCenter.latitude * Math.PI / 180), 0.25);
      const radiusMeters = Math.min(50000, Math.max(5000, Math.ceil(Math.max(heightKm, widthKm) * 500)));
      return wikipediaFallback(cellCenter, radiusMeters);
    })),
    isKeralaDestination(destination) ? wikipediaExactPlaces([
      "Munnar", "Alappuzha", "Kochi", "Fort Kochi", "Thiruvananthapuram",
      "Guruvayur", "Guruvayur Temple", "Sree Padmanabhaswamy Temple",
      "Thekkady", "Wayanad", "Kovalam", "Varkala", "Kozhikode",
      "Kumarakom", "Bekal Fort", "Kollam", "Wagamon", "Malampuzha",
      "Ponmudi", "Jatayu Earth's Center", "Athirappilly Falls", "Kuttanad",
      "Pookode Lake", "Sabarimala",
    ]) : Promise.resolve([] as DiscoveredPlace[]),
    wikipediaDestinationSearch(destination),
  ]);

  const unique = new Map<string, DiscoveredPlace>();
  const addPlaces = (items: DiscoveredPlace[]) => {
    for (const place of items) {
      if (!insideBounds(place, searchBounds)) continue;
      const key = normalizeName(place.name) + ":" + Math.round(place.latitude * 10000) + ":" + Math.round(place.longitude * 10000);
      if (!key) continue;
      const existing = unique.get(key);
      if (!existing || JSON.stringify(place).length > JSON.stringify(existing).length) unique.set(key, place);
    }
  };

  addPlaces(cellResults.flat());
  addPlaces(wikiResults.flat());
  addPlaces(coreResults);
  addPlaces(destinationResults);

  // Last-resort static anchors for Kerala. These are deliberately only major,
  // well-known destinations; live OSM/Wikipedia results remain the main source.
  if (isKeralaDestination(destination) && unique.size === 0) {
    const anchors: Array<[string, number, number, string]> = [
      ["Munnar",10.0889,77.0595,"town"], ["Alappuzha",9.4981,76.3388,"city"],
      ["Kochi",9.9312,76.2673,"city"], ["Fort Kochi",9.9658,76.2421,"place"],
      ["Thiruvananthapuram",8.5241,76.9366,"city"], ["Guruvayur",10.5941,76.0411,"town"],
      ["Thekkady",9.6031,77.1616,"place"], ["Wayanad",11.6854,76.1320,"place"],
      ["Kovalam",8.4004,76.9787,"place"], ["Varkala",8.7379,76.7163,"town"],
      ["Kozhikode",11.2588,75.7804,"city"], ["Kumarakom",9.6175,76.4304,"place"],
      ["Bekal",12.3914,75.0315,"place"], ["Kollam",8.8932,76.6141,"city"],
      ["Vagamon",9.6850,76.9070,"place"], ["Malampuzha",10.8270,76.6850,"place"],
      ["Ponmudi",8.7590,77.1160,"place"], ["Jatayu Earth's Center",8.8570,76.8660,"attraction"],
      ["Athirappilly Falls",10.2850,76.5690,"waterfall"], ["Kuttanad",9.4000,76.4800,"place"],
      ["Pookode Lake",11.5460,76.0100,"lake"], ["Sabarimala",9.4330,77.0800,"place"],
    ];
    addPlaces(anchors.map(([name, latitude, longitude, type]) => ({
      id: "kerala-anchor-" + normalizeName(name), name, type,
      group: groupFor(name + " " + type), latitude, longitude,
      distanceKm: haversineKm(coverage.center, { latitude, longitude }),
      description: "Major Kerala destination.",
    })));
  }

  let places = [...unique.values()].map((place) => ({
    ...place, distanceKm: haversineKm(coverage.center, place),
  }));

  console.info("Roveo places discovery:", {
    destination, cellCount: cells.length,
    overpassCounts: cellResults.map((items) => items.length),
    wikipediaCount: wikiResults.flat().length,
    coreCount: coreResults.length,
    destinationCount: destinationResults.length,
    mergedCount: places.length,
  });

  if (desiredQuery) {
    const query = desiredQuery.toLowerCase();
    places = places.filter((place) => (place.name + " " + (place.description ?? "") + " " + place.type).toLowerCase().includes(query));
  }

  // Do not write the live result set to PostgreSQL on the request path. The old
  // row-by-row catalog write could take long enough to make Vercel appear stuck.
  // Live discovery is the source of truth for this page.

  places.sort((a, b) => {
    const scoreDiff = importanceScore(b) - importanceScore(a);
    return scoreDiff || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name);
  });

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
