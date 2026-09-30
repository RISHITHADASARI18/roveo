import type {
  Coordinates,
  DiscoveredPlace,
  PlaceDiscoveryResult,
  PlaceSearchRequest,
  RouteRequest,
  RouteResult,
  TravelPlace,
  TravelProvider,
} from "./types";

const OSRM_URL = "https://router.project-osrm.org";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const FETCH_TIMEOUT_MS = 3500;
const OVERPASS_TIMEOUT_MS = 2500;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function profileForMode(mode: RouteRequest["mode"]) {
  switch (mode) {
    case "WALK": return "foot";
    case "BICYCLE": return "bike";
    case "DRIVE": return "driving";
    case "TRANSIT":
      throw new Error("Public-transit routing is not available in the open routing provider.");
  }
}

async function osrmFetch(url: string) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Roveo/1.0 (travel planner)",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error("Open routing service failed (" + response.status + "): " + body.slice(0, 300));
  }

  return response.json();
}

function haversineKm(a: Coordinates, b: Coordinates) {
  const p = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * p;
  const dLon = (b.longitude - a.longitude) * p;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * p) *
      Math.cos(b.latitude * p) *
      Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function classify(tags: Record<string, string>): DiscoveredPlace["group"] {
  const tourism = tags.tourism ?? "";
  const historic = tags.historic ?? "";
  const leisure = tags.leisure ?? "";
  const natural = tags.natural ?? "";
  const amenity = tags.amenity ?? "";

  if (
    ["attraction", "theme_park", "museum", "zoo", "aquarium", "gallery", "viewpoint"].includes(tourism)
  ) return "Attraction";

  if (
    ["monument", "memorial", "castle", "ruins", "archaeological_site", "fort", "yes"].includes(historic)
  ) return "History";

  if (
    ["park", "nature_reserve", "garden", "beach", "water_park"].includes(leisure) ||
    ["waterfall", "peak", "cave", "beach"].includes(natural)
  ) return "Nature";

  if (
    ["place_of_worship", "arts_centre", "theatre", "community_centre"].includes(amenity) ||
    ["artwork", "information"].includes(tourism)
  ) return "Culture";

  return "Activity";
}

function buildAddress(tags: Record<string, string>) {
  return [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"] ?? tags["addr:town"],
    tags["addr:state"],
  ]
    .filter(Boolean)
    .join(", ");
}

export async function discoverPlaces(
  destination: string,
  radiusMeters = 30000,
  maxResults = 200,
  desiredQuery = "",
): Promise<PlaceDiscoveryResult> {
  const geoParams = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    q: destination,
    addressdetails: "1",
  });

  const geoResponse = await fetchWithTimeout(
    NOMINATIM_URL + "?" + geoParams.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Roveo/1.0 (travel planner; destination discovery)",
      },
      cache: "no-store",
    },
  );

  if (!geoResponse.ok) {
    throw new Error("Destination geocoding failed (" + geoResponse.status + ").");
  }

  const geoData = await geoResponse.json();
  const first = Array.isArray(geoData) ? geoData[0] : null;

  if (!first) {
    throw new Error("Destination was not found. Try a city or landmark.");
  }

  const center: Coordinates = {
    latitude: Number(first.lat),
    longitude: Number(first.lon),
  };

  if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) {
    throw new Error("Destination returned invalid coordinates.");
  }

  const radius = Math.min(Math.max(Math.round(radiusMeters), 1000), 50000);
  const googleApiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;

  if (googleApiKey) {
    try {
      const fieldMask = [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.primaryType",
        "places.types",
        "places.googleMapsUri",
        "places.websiteUri",
      ].join(",");

      const body: Record<string, unknown> = desiredQuery.trim()
        ? {
            textQuery: desiredQuery.trim() + " in " + destination,
            pageSize: Math.min(Math.max(maxResults, 1), 20),
            languageCode: "en",
            locationBias: {
              circle: {
                center: { latitude: center.latitude, longitude: center.longitude },
                radius,
              },
            },
            rankPreference: "RELEVANCE",
          }
        : {
            includedTypes: [
              "tourist_attraction",
              "museum",
              "art_gallery",
              "park",
              "historical_landmark",
              "cultural_landmark",
              "zoo",
              "aquarium",
              "amusement_park",
              "place_of_worship",
            ],
            maxResultCount: Math.min(Math.max(maxResults, 1), 20),
            rankPreference: "POPULARITY",
            languageCode: "en",
            locationRestriction: {
              circle: {
                center: { latitude: center.latitude, longitude: center.longitude },
                radius,
              },
            },
          };

      const endpoint = desiredQuery.trim()
        ? "https://places.googleapis.com/v1/places:searchText"
        : "https://places.googleapis.com/v1/places:searchNearby";

      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Goog-Api-Key": googleApiKey,
            "X-Goog-FieldMask": fieldMask,
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
        4500,
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          "Google Places discovery failed (" +
            response.status +
            "): " +
            errorBody.slice(0, 300),
        );
      }

      const googleData = await response.json();
      const googlePlaces = Array.isArray(googleData.places) ? googleData.places : [];
      const places: DiscoveredPlace[] = googlePlaces
        .map((place: any, index: number) => {
          const latitude = Number(place.location?.latitude);
          const longitude = Number(place.location?.longitude);
          const name = String(place.displayName?.text ?? "").trim();
          const primaryType = String(place.primaryType ?? place.types?.[0] ?? "place");

          if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

          const typeText = primaryType.toLowerCase();
          const group: DiscoveredPlace["group"] =
            /museum|art_gallery|cultural_landmark|place_of_worship/.test(typeText)
              ? "Culture"
              : /historical_landmark/.test(typeText)
                ? "History"
                : /park|zoo|aquarium|natural/.test(typeText)
                  ? "Nature"
                  : /tourist_attraction|amusement_park|landmark/.test(typeText)
                    ? "Attraction"
                    : "Activity";

          return {
            id: "google-" + String(place.id ?? index),
            name,
            type: primaryType,
            group,
            latitude,
            longitude,
            distanceKm: haversineKm(center, { latitude, longitude }),
            description: desiredQuery.trim()
              ? "Matched your search for " + desiredQuery.trim() + " in " + destination + "."
              : "Popular place to visit in " + destination + ".",
            website: place.websiteUri,
            address: place.formattedAddress,
          } as DiscoveredPlace;
        })
        .filter(Boolean) as DiscoveredPlace[];

      if (places.length) {
        return {
          center,
          places: places
            .sort((a, b) => a.distanceKm - b.distanceKm)
            .slice(0, Math.min(Math.max(maxResults, 1), 250)),
          source: "google",
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      console.warn("Google Places discovery unavailable; using OpenStreetMap fallback.", error);
    }
  }

  const query = `[out:json][timeout:35];
(
  nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork|information"](around:${radius},${center.latitude},${center.longitude});
  nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|yes"](around:${radius},${center.latitude},${center.longitude});
  nwr["leisure"~"park|nature_reserve|garden|beach|water_park"](around:${radius},${center.latitude},${center.longitude});
  nwr["natural"~"waterfall|peak|cave|beach"](around:${radius},${center.latitude},${center.longitude});
  nwr["amenity"~"place_of_worship|arts_centre|theatre|community_centre"](around:${radius},${center.latitude},${center.longitude});
);
out center tags;`;

  let data: any = null;
  let lastError = "Unknown place discovery error.";

  for (const overpassUrl of OVERPASS_URLS.slice(0, 1)) {
    try {
      const response = await fetchWithTimeout(
        overpassUrl,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Roveo/1.0 (travel planner; place discovery)",
          },
          body: new URLSearchParams({ data: query }),
          cache: "no-store",
        },
        OVERPASS_TIMEOUT_MS,
      );

      if (!response.ok) {
        const body = await response.text();
        lastError =
          "Place discovery service failed (" +
          response.status +
          "): " +
          body.slice(0, 300);
        continue;
      }

      data = await response.json();
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown place discovery error.";
    }
  }

  if (!data) {
    // Large cities can make Overpass queries too expensive for a short-lived
    // serverless request. Fall back to Nominatim's live search so the UI still
    // gets real mapped places instead of remaining stuck on "Searching…".
    const fallbackQueries = [
      destination + " tourist attractions landmarks parks museums temples",
    ];
    const fallbackPlaces: DiscoveredPlace[] = [];

    for (const fallbackQuery of fallbackQueries) {
      try {
        const params = new URLSearchParams({
          q: fallbackQuery,
          format: "jsonv2",
          limit: "40",
          addressdetails: "1",
        });
        const response = await fetchWithTimeout(
          NOMINATIM_URL + "?" + params.toString(),
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "Roveo/1.0 (travel planner; place discovery)",
            },
            cache: "no-store",
          },
          2500,
        );
        if (!response.ok) continue;
        const results = await response.json();

        for (const item of Array.isArray(results) ? results : []) {
          const latitude = Number(item.lat);
          const longitude = Number(item.lon);
          const name = String(
            item.name || item.display_name?.split(",")[0] || ""
          ).trim();

          if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            continue;
          }

          const category = String(item.type || item.class || "place").toLowerCase();
          const group: DiscoveredPlace["group"] =
            /museum|gallery|theatre|arts|temple|church|shrine|mosque/.test(category)
              ? "Culture"
              : /park|garden|beach|nature|viewpoint|peak|waterfall/.test(category)
                ? "Nature"
                : /monument|memorial|castle|ruins|historic|fort|archaeological/.test(category)
                  ? "History"
                  : "Attraction";

          fallbackPlaces.push({
            id:
              "nominatim-" +
              String(item.osm_type ?? "place") +
              "-" +
              String(item.osm_id ?? name),
            name,
            type: category,
            group,
            latitude,
            longitude,
            distanceKm: haversineKm(center, { latitude, longitude }),
            description: item.display_name,
            address: item.display_name,
          });
        }
      } catch {
        // Try the next fallback query.
      }
    }

    const uniqueFallback = new Map<string, DiscoveredPlace>();
    for (const place of fallbackPlaces) {
      const key = place.name.toLowerCase();
      if (!uniqueFallback.has(key)) uniqueFallback.set(key, place);
    }

    const sortedFallback = [...uniqueFallback.values()]
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, Math.min(Math.max(maxResults, 1), 250));

    if (!sortedFallback.length) {
      throw new Error(
        "Live place discovery is temporarily unavailable. Please try again in a moment."
      );
    }

    return {
      center,
      places: sortedFallback,
      source: "openstreetmap",
      fetchedAt: new Date().toISOString(),
    };
  }

  const seen = new Set<string>();
  const places: DiscoveredPlace[] = [];

  for (const item of Array.isArray(data.elements) ? data.elements : []) {
    const tags = (item.tags ?? {}) as Record<string, string>;
    const latitude = Number(item.lat ?? item.center?.lat);
    const longitude = Number(item.lon ?? item.center?.lon);
    const name = tags["name:en"] ?? tags.name ?? "";

    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const id = String(item.type ?? "place") + "-" + String(item.id);
    const nameKey = name.trim().toLowerCase();

    if (seen.has(nameKey)) continue;
    seen.add(nameKey);

    places.push({
      id,
      name: name.trim(),
      type:
        tags.tourism ??
        tags.historic ??
        tags.leisure ??
        tags.natural ??
        tags.amenity ??
        "place",
      group: classify(tags),
      latitude,
      longitude,
      distanceKm: haversineKm(center, { latitude, longitude }),
      description: tags["description:en"] ?? tags.description,
      openingHours: tags.opening_hours,
      website: tags.website ?? tags["contact:website"],
      wikipedia: tags.wikipedia,
      address: buildAddress(tags) || undefined,
    });
  }

  places.sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    center,
    places: places.slice(0, Math.min(Math.max(maxResults, 1), 250)),
    source: "openstreetmap",
    fetchedAt: new Date().toISOString(),
  };
}

export const openTravelProvider: TravelProvider = {
  async computeRoute(request: RouteRequest): Promise<RouteResult> {
    const profile = profileForMode(request.mode);
    const coordinates = [
      request.origin.longitude + "," + request.origin.latitude,
      request.destination.longitude + "," + request.destination.latitude,
    ].join(";");

    const url =
      OSRM_URL +
      "/route/v1/" +
      profile +
      "/" +
      coordinates +
      "?overview=full&geometries=polyline6&alternatives=false";

    const data = await osrmFetch(url);

    if (data.code !== "Ok" || !data.routes?.[0]) {
      throw new Error(data.message || "Open routing service returned no route.");
    }

    const route = data.routes[0];

    return {
      provider: "open",
      distanceMeters: Number(route.distance ?? 0),
      durationSeconds: Number(route.duration ?? 0),
      encodedPolyline:
        typeof route.geometry === "string" ? route.geometry : undefined,
    };
  },

  async searchPlaces(request: PlaceSearchRequest): Promise<TravelPlace[]> {
    const params = new URLSearchParams({
      q: request.textQuery,
      format: "jsonv2",
      limit: String(Math.min(Math.max(request.maxResults ?? 10, 1), 20)),
      addressdetails: "1",
    });

    if (
      typeof request.latitude === "number" &&
      typeof request.longitude === "number"
    ) {
      params.set("lat", String(request.latitude));
      params.set("lon", String(request.longitude));
    }

    const response = await fetchWithTimeout(
      NOMINATIM_URL + "?" + params.toString(),
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Roveo/1.0 (travel planner)",
        },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        "Open places service failed (" +
          response.status +
          "): " +
          body.slice(0, 300),
      );
    }

    const data = await response.json();

    return (Array.isArray(data) ? data : []).map((place: any, index: number) => ({
      id: String(place.osm_type ?? "place") + "-" + String(place.osm_id ?? index),
      name: place.display_name?.split(",")[0] ?? "Unnamed place",
      address: place.display_name,
      latitude: Number(place.lat),
      longitude: Number(place.lon),
      types: [place.type].filter(Boolean),
    }));
  },
};
