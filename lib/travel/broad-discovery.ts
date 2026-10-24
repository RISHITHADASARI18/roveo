import { unstable_cache } from "next/cache";
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
        cache: "force-cache", next: { revalidate: 21600 },
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
          cache: "force-cache", next: { revalidate: 21600 },
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

async function nearbyDestinationSearch(bounds: Bounds | undefined, coverage: DestinationCoverage) {
  if (!bounds) return [] as Array<{name:string;latitude:number;longitude:number;distanceKm:number;type:string}>;
  const pad = coverage.scope === "state" ? 1.0 : coverage.scope === "district" ? 0.6 : 0.4;
  const outer: Bounds = {
    south: Math.max(-90, bounds.south - pad),
    north: Math.min(90, bounds.north + pad),
    west: Math.max(-180, bounds.west - pad),
    east: Math.min(180, bounds.east + pad),
  };
  const bbox = [outer.south, outer.west, outer.north, outer.east].join(",");
  const query = [
    "[out:json][timeout:4];",
    'nwr["place"~"city|town|municipality"](' + bbox + ');',
    "out center tags;",
  ].join("\n");
  // Nearby-stop suggestions are secondary UI. Try both public endpoints in
  // parallel so an overloaded endpoint cannot add two sequential timeout windows.
  const attempts = OVERPASS_ENDPOINTS.map(async (endpoint) => {
    const response = await fetchWithTimeout(endpoint, {
      method:"POST",
      headers:{Accept:"application/json","Content-Type":"application/x-www-form-urlencoded; charset=UTF-8","User-Agent":"Roveo/1.0 (travel planner; nearby destinations)"},
      body:"data="+encodeURIComponent(query),
      cache: "force-cache", next: { revalidate: 21600 },
    },3500);
    if(!response.ok) throw new Error("Nearby destination provider unavailable.");
    const data=await response.json();
    const results=new Map<string,{name:string;latitude:number;longitude:number;distanceKm:number;type:string}>();
    for(const element of Array.isArray(data?.elements)?data.elements:[]){
      const tags=element?.tags??{};
      const name=String(tags["name:en"]??tags.name??"").trim();
      const latitude=Number(element.lat??element.center?.lat);
      const longitude=Number(element.lon??element.center?.lon);
      if(!name||!Number.isFinite(latitude)||!Number.isFinite(longitude))continue;
      if(haversineKm(coverage.center,{latitude,longitude})<10)continue;
      const key=normalizeName(name);
      if(!results.has(key))results.set(key,{name,latitude,longitude,distanceKm:haversineKm(coverage.center,{latitude,longitude}),type:String(tags.place??"town")});
    }
    const places=[...results.values()].sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,12);
    if(!places.length) throw new Error("No nearby destinations returned.");
    return places;
  });
  try { return await Promise.any(attempts); } catch { return []; }
}

async function overpassCell(cell: Bounds): Promise<DiscoveredPlace[]> {
  const bbox = [cell.south, cell.west, cell.north, cell.east].join(",");
  const query = [
    "[out:json][timeout:5];",
    "(",
    `nwr["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium|artwork|information|picnic_site"](${bbox});`,
    `nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|heritage|manor|palace"](${bbox});`,
    `nwr["leisure"~"park|garden|nature_reserve|water_park|marina"](${bbox});`,
    `nwr["natural"~"waterfall|peak|cave|beach|lake|cliff|hot_spring|volcano|glacier"](${bbox});`,
    `nwr["man_made"~"lighthouse|pier|tower"](${bbox});`,
    `nwr["amenity"~"theatre|arts_centre|place_of_worship"](${bbox});`,
    // Keep this feed focused on visitable attractions, not every village or administrative area.
    ");",
    "out center tags;",
  ].join("\n");

  // Race the public mirrors and use the first non-empty successful response.
  // Sequential 5-second retries made each cell wait up to 10 seconds before
  // returning, even when the backup mirror had already responded quickly.
  const attempts = OVERPASS_ENDPOINTS.map(async (endpoint) => {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "Roveo/1.0 (travel planner; place discovery)",
      },
      body: "data=" + encodeURIComponent(query),
      cache: "force-cache", next: { revalidate: 21600 },
    }, 4200);
    if (!response.ok) throw new Error("Overpass mirror unavailable.");
    const data = await response.json();
    const mapped = (Array.isArray(data.elements) ? data.elements : []).map((element: any) => {
      const tags = element?.tags ?? {};
      const name = String(tags["name:en"] ?? tags.name ?? "").trim();
      const latitude = Number(element.lat ?? element.center?.lat);
      const longitude = Number(element.lon ?? element.center?.lon);
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const type = String(tags.tourism ?? tags.historic ?? tags.leisure ?? tags.natural ?? tags.man_made ?? tags.amenity ?? tags.place ?? "place").toLowerCase();
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
    if (!mapped.length) throw new Error("Overpass returned no named places.");
    return mapped;
  });
  try { return await Promise.any(attempts); } catch { return []; }
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
      cache: "force-cache", next: { revalidate: 21600 },
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
        cache: "force-cache", next: { revalidate: 21600 },
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
        cache: "force-cache", next: { revalidate: 21600 },
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

const OOTY_ANCHORS: Array<[string, number, number, string, string]> = [
  ["Government Botanical Garden",11.4126,76.7110,"garden","Landscaped botanical garden with extensive plant collections and hillside views."],
  ["Ooty Lake",11.4064,76.6952,"attraction","Popular lake for boating and relaxed views of the surrounding hills."],
  ["Doddabetta Peak",11.4002,76.7350,"viewpoint","The highest peak in the Nilgiri Hills, known for panoramic mountain views."],
  ["Government Rose Garden",11.4055,76.7087,"garden","Terraced rose garden with a wide variety of roses and views over Ooty."],
  ["Pykara Falls",11.4753,76.5880,"waterfall","Scenic waterfalls surrounded by the forests and hills of the Nilgiris."],
  ["Pykara Lake",11.4765,76.5885,"lake","Scenic reservoir and boating area near the Pykara waterfalls."],
  ["Nilgiri Mountain Railway",11.4060,76.6950,"heritage","Historic mountain railway known for its scenic route through the Nilgiris."],
  ["Avalanche Lake",11.2940,76.5760,"lake","Quiet mountain lake surrounded by forest and rolling hills."],
  ["Emerald Lake",11.3238,76.5783,"lake","Peaceful lake in the Nilgiri hills, known for green scenery and viewpoints."],
  ["Ooty Tea Factory and Tea Museum",11.4050,76.6960,"museum","Tea museum explaining local tea production, with factory displays and tastings."],
  ["Wenlock Downs",11.3650,76.6320,"viewpoint","Open grasslands with sweeping Nilgiri hill scenery."],
  ["St Stephen's Church",11.4080,76.6960,"heritage","Historic church and one of Ooty's notable heritage landmarks."],
];

function isOotyDestination(destination: string) {
  return /\b(?:ooty|udhagamandalam|nilgiris)\b/i.test(destination);
}

const DELHI_CORE_PLACES = [
  "red fort", "india gate", "lotus temple", "bahai lotus temple", "humayuns tomb",
  "jama masjid", "swaminarayan akshardham", "qutb minar", "gurdwara bangla sahib",
  "lodhi garden", "rashtrapati bhavan", "dilli haat", "raj ghat", "birla mandir",
  "dargah nizamuddin aulia", "sunder nursery", "iskcon temple", "agrassen ki baoli",
  "purana qila", "national museum", "nehru planetarium", "gurudwara sis ganj sahib"
];

const DELHI_ANCHORS: Array<[string, number, number, string]> = [
  ["Red Fort",28.6562,77.2410,"fort"],
  ["India Gate",28.6129,77.2295,"monument"],
  ["Bahá’í Lotus Temple",28.5535,77.2588,"temple"],
  ["Humayun's Tomb",28.5933,77.2507,"heritage"],
  ["Jama Masjid",28.6507,77.2334,"mosque"],
  ["Swaminarayan Akshardham",28.6127,77.2773,"temple"],
  ["Qutb Minar",28.5245,77.1855,"monument"],
  ["Gurdwara Bangla Sahib",28.6268,77.2090,"place of worship"],
  ["Lodhi Garden",28.5933,77.2197,"park"],
  ["Rashtrapati Bhavan",28.6143,77.1996,"heritage"],
  ["Dilli Haat - INA",28.5747,77.2067,"culture"],
  ["Raj Ghat",28.6407,77.2495,"memorial"],
  ["Shri Laxmi Narayan Temple (Birla Mandir)",28.6328,77.1990,"temple"],
  ["Dargah Nizamuddin Aulia",28.5913,77.2420,"shrine"],
  ["Sunder Nursery",28.5938,77.2452,"park"],
  ["ISKCON Temple - Glory of India",28.5537,77.2510,"temple"],
  ["Agrasen ki Baoli",28.6260,77.2250,"heritage"],
  ["Purana Qila",28.6096,77.2430,"fort"],
  ["National Museum",28.6118,77.2195,"museum"],
  ["Nehru Planetarium",28.6027,77.1990,"museum"]
];

const KERALA_CORE_PLACES = [
  "kochi", "fort kochi", "thiruvananthapuram", "trivandrum", "guruvayoor", "guruvayur",
  "munnar", "alappuzha", "alleppey", "thekkady", "wayanad", "kovalam", "varkala",
  "kozhikode", "calicut", "kumarakom", "bekal", "kollam", "wagamon", "vagamon",
  "malampuzha", "ponmudi", "jadayu earth center", "jatayu earth center", "athirappilly",
  "sree padmanabhaswamy temple", "padmanabhaswamy temple", "guruvayur temple",
  "sabarimala", "bekal fort", "kuttanad", "pookode lake", "poo kode lake",
] as const;

function isDelhiDestination(destination: string) {
  const normalized = normalizeName(destination);
  return normalized === "delhi" || normalized === "new delhi" || normalized === "delhi india" || normalized === "new delhi india";
}

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
      { headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination search)" }, cache: "force-cache", next: { revalidate: 21600 } },
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
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.websiteUri,places.rating,places.userRatingCount",
      },
      body: JSON.stringify(body), cache: "force-cache", next: { revalidate: 21600 },
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
        rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : undefined,
        userRatingCount: Number.isFinite(Number(place.userRatingCount)) ? Number(place.userRatingCount) : undefined,
      } as DiscoveredPlace;
    }).filter(Boolean) as DiscoveredPlace[];
  } catch {
    return [] as DiscoveredPlace[];
  }
}

function isLowQualityWikipediaTitle(name: string) {
  const title = name.trim();
  return [
    /^(?:list of\b|bids? for\b|antipodes on earth$|equator$|prime meridian$|geographical centre\b|geographical center\b|natural earth$|null island$|radio clock$|hops$)/i,
    /^(?:geography|history|climate|economy|demographics|transport|education|administration|politics|infrastructure) of\b/i,
    /\b(?:municipal district|administrative district|electoral district|county|province|region|prefecture|department|municipality|commune|borough|district)\s*$/i,
    /\b(?:basalts?|sandstone|limestone|glacier|glacial|geology|rock formation|power station|facilities in)\b/i,
    /\b(?:olympic bids?|bids for the olympics|facilities in)\b/i,
    /\(disambiguation\)$/i,
  ].some((pattern) => pattern.test(title));
}
function importanceScore(place: DiscoveredPlace) {
  const type = place.type.toLowerCase();
  const text = (place.name + " " + (place.description ?? "")).toLowerCase();
  let score = 0;
  // Curated destination anchors and actual attractions outrank ordinary map records.
  if (isKeralaCorePlace(place.name)) score += 80;
  const typeScores: Record<string, number> = {
    // Towns are useful as destinations, but must not outrank attractions to visit.
    city: 0, town: 0, municipality: -3, village: -8,
    attraction: 45, tourist_attraction: 45, historical_landmark: 42,
    viewpoint: 38, museum: 36, theme_park: 35, amusement_park: 35, zoo: 32,
    aquarium: 32, gallery: 25, art_gallery: 25, fort: 42, castle: 40,
    archaeological_site: 38, ruins: 32, monument: 30, memorial: 25,
    waterfall: 28, beach: 30, peak: 24, cave: 22, natural_feature: 24,
    nature_reserve: 22, national_park: 30, park: 18, garden: 18, botanical_garden: 22,
    water_park: 28, place_of_worship: 20, hindu_temple: 25, church: 22, mosque: 22, landmark: 8,
  };
  score += typeScores[type] ?? 0;
  // A nearby Wikipedia article alone is weak evidence of tourist relevance.
  // Exact curated articles and OSM attraction tags should rank ahead of general articles.
  if (place.wikipedia) score += place.description === "Named destination place from Wikipedia." ? 2 : 8;
  if (place.website) score += 5;
  if (place.address) score += 2;
  if (Number.isFinite(place.rating)) score += Math.max(0, Number(place.rating) - 3) * 5;
  if (Number.isFinite(place.userRatingCount) && Number(place.userRatingCount) > 0) {
    score += Math.min(14, Math.log10(Number(place.userRatingCount) + 1) * 3);
  }
  if (/national park|wildlife sanctuary|palace|temple|church|mosque|sanctuary|reserve|falls|fort|museum|beach|lake|backwater|heritage|monument|viewpoint|botanical garden|tea estate|zoo|aquarium/.test(text)) score += 12;
  if (place.group === "Attraction") score += 8;
  if (place.group === "History") score += 7;
  if (place.group === "Nature") score += 6;
  return score;
}

async function discoverBroadPlacesUncached(
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
    // Do not make every Places page load wait on a second round of public
    // geocoding when the trip already has saved coordinates/bounds. Infer a
    // sensible search scope from the saved box instead; only geocode again
    // when no usable bounds were saved.
    if (coverage.bounds) {
      const height = coverage.bounds.north - coverage.bounds.south;
      const width = coverage.bounds.east - coverage.bounds.west;
      const span = Math.max(height, width);
      coverage = {
        ...coverage,
        scope: span > 1.5 ? "state" : span > 0.5 ? "district" : "city",
      };
    } else {
      try {
        const classified = await destinationCoverage(destination, storedCoverage.center);
        coverage = {
          ...coverage,
          scope: classified.scope,
          state: classified.state,
          district: classified.district,
          bounds: classified.bounds,
        };
      } catch {
        // Keep the stored trip geometry if classification is temporarily unavailable.
      }
    }
  }

  if (coverage.center.latitude === 0 && coverage.center.longitude === 0) {
    throw new Error("Could not locate destination: " + destination);
  }

  // Scope controls the geographic search:
  // state = the whole state; district = the district plus a small surrounding
  // ring so nearby districts are useful; city/place = the geocoded area only.
  let searchBounds = coverage.bounds;
  // Older trip links send only the center coordinates. Always build a local
  // search box when stored/geocoded geometry is missing, never a global search.
  if (!searchBounds) {
    const latPad = coverage.scope === "state" ? 1.4 : coverage.scope === "district" ? 0.65 : coverage.scope === "city" ? 0.22 : 0.12;
    const lonPad = latPad / Math.max(Math.cos(coverage.center.latitude * Math.PI / 180), 0.25);
    searchBounds = {
      south: Math.max(-90, coverage.center.latitude - latPad),
      north: Math.min(90, coverage.center.latitude + latPad),
      west: Math.max(-180, coverage.center.longitude - lonPad),
      east: Math.min(180, coverage.center.longitude + lonPad),
    };
  }
  if (searchBounds && (coverage.scope === "city" || coverage.scope === "place")) {
    // Geocoders often return a very tight administrative bbox for cities and
    // named attractions. That is too restrictive for travel discovery: nearby
    // landmarks can sit just outside the administrative boundary.
    const latPad = coverage.scope === "city" ? 0.30 : 0.12;
    const lonPad = coverage.scope === "city" ? 0.30 : 0.12;
    searchBounds = {
      south: searchBounds.south - latPad,
      north: searchBounds.north + latPad,
      west: searchBounds.west - lonPad,
      east: searchBounds.east + lonPad,
    };
  } else if (coverage.scope === "district" && searchBounds) {
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

  // Run nearby-stop suggestions alongside the main place providers instead of
  // waiting for all attractions to finish before starting this extra lookup.
  const [cellResults, wikiResults, coreResults, googleResults, destinationResults, nearbyDestinations] = await Promise.all([
    Promise.all(cells.map(overpassCell)),
    Promise.all(cells.map(async (cell) => {
      const cellCenter = {
        latitude: (cell.south + cell.north) / 2,
        longitude: (cell.west + cell.east) / 2,
      };
      const heightKm = (cell.north - cell.south) * 111;
      const widthKm = (cell.east - cell.west) * 111 * Math.max(Math.cos(cellCenter.latitude * Math.PI / 180), 0.25);
      const radiusMeters = Math.min(50000, Math.max(5000, Math.ceil(Math.max(heightKm, widthKm) * 500)));
      // Wikipedia geosearch is a supplementary local source only. Keep the
      // radius bounded and let the merge layer verify distance from destination.
      return wikipediaFallback(cellCenter, Math.min(radiusMeters, coverage.scope === "state" ? 50000 : 30000));
    })),
    isKeralaDestination(destination) ? wikipediaExactPlaces([

      "Munnar", "Alappuzha", "Kochi", "Fort Kochi", "Thiruvananthapuram",
      "Guruvayur", "Guruvayur Temple", "Sree Padmanabhaswamy Temple",
      "Thekkady", "Wayanad", "Kovalam", "Varkala", "Kozhikode",
      "Kumarakom", "Bekal Fort", "Kollam", "Wagamon", "Malampuzha",
      "Ponmudi", "Jatayu Earth's Center", "Athirappilly Falls", "Kuttanad",
      "Pookode Lake", "Sabarimala",
    ]) : isDelhiDestination(destination) ? wikipediaExactPlaces(DELHI_CORE_PLACES.map((name) => name.replace(/\s+/g, " "))) : Promise.resolve([] as DiscoveredPlace[]),
    // Google Places is the strongest source for famous, visitor-facing attractions
    // when configured. Keep it parallel with the free sources so it adds quality
    // without making each destination wait for the others.
    googleFallback(destination, searchBounds, coverage.center, Math.min(limit, 20)),
    Promise.resolve([] as DiscoveredPlace[]),
    nearbyDestinationSearch(searchBounds, coverage),
  ]);

  const unique = new Map<string, DiscoveredPlace>();
  const keysByName = new Map<string, string[]>();
  const addPlaces = (
    items: DiscoveredPlace[],
    options: { allowOutsideBounds?: boolean; maxDistanceKm?: number } = {},
  ) => {
    for (const place of items) {
      // Never trust provider-supplied distance values: some sources calculate
      // distance from a search tile, or omit it entirely. The destination's
      // resolved coordinates are the single source of truth.
      const actualDistanceKm = haversineKm(coverage.center, place);
      const measured = { ...place, distanceKm: actualDistanceKm };
      if (!options.allowOutsideBounds && !insideBounds(place, searchBounds)) continue;
      if (measured.description === "Named destination place from Wikipedia." &&
          isLowQualityWikipediaTitle(measured.name)) continue;
      const maxDistanceKm = options.maxDistanceKm ??
        (coverage.scope === "state" ? 320 : coverage.scope === "district" ? 140 : coverage.scope === "city" ? 50 : 35);
      if (actualDistanceKm > maxDistanceKm) continue;
      const nameKey = normalizeName(measured.name);
      if (!nameKey) continue;

      // Different providers often return the same attraction with coordinates
      // a few hundred metres apart. Merge those into one pin/card, but preserve
      // same-named places in broad regions when they are genuinely far apart.
      const sameNameKeys = keysByName.get(nameKey) ?? [];
      const duplicateKey = sameNameKeys.find((key) => {
        const existing = unique.get(key);
        return existing && haversineKm(existing, measured) <= 1.5;
      });
      const key = duplicateKey ??
        nameKey + ":" + Math.round(measured.latitude * 10000) + ":" + Math.round(measured.longitude * 10000);
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, measured);
        keysByName.set(nameKey, [...sameNameKeys, key]);
        continue;
      }

      // Prefer the more informative/high-confidence record while retaining
      // useful metadata that only the other provider supplied.
      const preferred = importanceScore(measured) > importanceScore(existing) ? measured : existing;
      const secondary = preferred === measured ? existing : measured;
      unique.set(key, {
        ...secondary,
        ...preferred,
        description: preferred.description && preferred.description !== "Real place record from OpenStreetMap."
          ? preferred.description : secondary.description,
        website: preferred.website ?? secondary.website,
        wikipedia: preferred.wikipedia ?? secondary.wikipedia,
        address: preferred.address ?? secondary.address,
        openingHours: preferred.openingHours ?? secondary.openingHours,
        rating: preferred.rating ?? secondary.rating,
        userRatingCount: preferred.userRatingCount ?? secondary.userRatingCount,
      });
    }
  };

  addPlaces(cellResults.flat());
  addPlaces(wikiResults.flat());
  addPlaces(coreResults);
  addPlaces(googleResults);
  addPlaces(destinationResults);

  // Seed major Delhi attractions even when free POI providers return sparse data.
  // These are well-known destination anchors, not a replacement for live discovery.
  if (isDelhiDestination(destination)) {
    addPlaces(DELHI_ANCHORS.map(([name, latitude, longitude, type]) => ({
      id: "delhi-anchor-" + normalizeName(name), name, type,
      group: groupFor(name + " " + type), latitude, longitude,
      distanceKm: haversineKm(coverage.center, { latitude, longitude }),
      description: "Major Delhi attraction.",
    })));
  }

  // Curated Ooty/Nilgiris must-visits keep the page useful when public POI
  // providers are sparse or temporarily unavailable.
  if (isOotyDestination(destination)) {
    // These verified Nilgiris landmarks may sit outside a geocoder's tiny town
    // boundary. The distance cap still keeps results local to Ooty.
    addPlaces(OOTY_ANCHORS.map(([name, latitude, longitude, type, description]) => ({
      id: "ooty-anchor-" + normalizeName(name), name, type,
      group: groupFor(name + " " + type), latitude, longitude,
      distanceKm: haversineKm(coverage.center, { latitude, longitude }),
      description,
    })), { allowOutsideBounds: true, maxDistanceKm: 50 });
  }

  // Keep a curated set of major Kerala attractions even when free providers
  // return only a few local records or saved bounds are misclassified as a city.
  if (isKeralaDestination(destination)) {
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
    })), { allowOutsideBounds: true, maxDistanceKm: 320 });
  }

  let places = [...unique.values()].map((place) => ({
    ...place, distanceKm: haversineKm(coverage.center, place),
  }));

  console.info("Roveo places discovery:", {
    destination, cellCount: cells.length,
    overpassCounts: cellResults.map((items) => items.length),
    wikipediaCount: wikiResults.flat().length,
    coreCount: coreResults.length,
    googleCount: googleResults.length,
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
    nearbyDestinations,
    source: "openstreetmap",
    fetchedAt: new Date().toISOString(),
  };
}


/**
 * Cache the complete merged discovery result, not just individual provider
 * responses. Place catalogs change slowly, and this avoids repeating several
 * external lookups whenever someone returns to the same destination.
 */
const getCachedBroadPlaces = unstable_cache(
  async (
    destination: string,
    maxResults: number,
    desiredQuery: string,
    storedCoverage?: DestinationCoverage,
  ) => discoverBroadPlacesUncached(destination, 0, maxResults, desiredQuery, storedCoverage),
  ["roveo-broad-place-discovery-v1"],
  { revalidate: 21600 },
);

export async function discoverBroadPlaces(
  destination: string,
  _legacyRadiusMeters = 0,
  maxResults = 200,
  desiredQuery = "",
  storedCoverage?: DestinationCoverage,
): Promise<PlaceDiscoveryResult> {
  return getCachedBroadPlaces(destination, maxResults, desiredQuery, storedCoverage);
}
