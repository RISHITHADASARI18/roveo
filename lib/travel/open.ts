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
  const radius = Math.min(Math.max(Math.round(radiusMeters), 1000), 50000);
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 250);
  const searchText = desiredQuery.trim();

  async function geocodeWithNominatim(): Promise<Coordinates | null> {
    try {
      const params = new URLSearchParams({
        format: "jsonv2",
        limit: "1",
        q: destination,
        addressdetails: "1",
      });
      const response = await fetchWithTimeout(
        NOMINATIM_URL + "?" + params.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Roveo/1.0 (travel planner; destination discovery)",
          },
          cache: "no-store",
        },
        3000,
      );
      if (!response.ok) return null;
      const data = await response.json();
      const first = Array.isArray(data) ? data[0] : null;
      if (!first) return null;
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      return Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : null;
    } catch {
      return null;
    }
  }

  const googleApiKey =
    process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;

  let center = await geocodeWithNominatim();

  if (!center && googleApiKey) {
    try {
      const response = await fetchWithTimeout(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Goog-Api-Key": googleApiKey,
            "X-Goog-FieldMask": "places.location,places.displayName",
          },
          body: JSON.stringify({
            textQuery: destination,
            pageSize: 1,
            languageCode: "en",
          }),
          cache: "no-store",
        },
        4000,
      );
      if (response.ok) {
        const data = await response.json();
        const location = data.places?.[0]?.location;
        const latitude = Number(location?.latitude);
        const longitude = Number(location?.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          center = { latitude, longitude };
        }
      }
    } catch {
      // OSM fallback below will provide a clear error if no center is available.
    }
  }

  if (!center) {
    throw new Error("Destination could not be located. Try a city or landmark name.");
  }

  function classifyGooglePlace(primaryType: string): DiscoveredPlace["group"] {
    const type = primaryType.toLowerCase();
    if (/museum|art_gallery|cultural_landmark|place_of_worship|theater|library/.test(type)) {
      return "Culture";
    }
    if (/historical_landmark|monument|memorial|castle|ruin/.test(type)) {
      return "History";
    }
    if (/park|zoo|aquarium|garden|beach|natural/.test(type)) {
      return "Nature";
    }
    if (/tourist_attraction|amusement_park|landmark|viewpoint/.test(type)) {
      return "Attraction";
    }
    return "Activity";
  }

  async function discoverWithGoogle(): Promise<DiscoveredPlace[]> {
    if (!googleApiKey) return [];

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

    const body: Record<string, unknown> = searchText
      ? {
          textQuery: searchText + " in " + destination,
          pageSize: Math.min(limit, 20),
          languageCode: "en",
          locationBias: {
            circle: {
              center: { latitude: center!.latitude, longitude: center!.longitude },
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
          maxResultCount: Math.min(limit, 20),
          rankPreference: "POPULARITY",
          languageCode: "en",
          locationRestriction: {
            circle: {
              center: { latitude: center!.latitude, longitude: center!.longitude },
              radius,
            },
          },
        };

    const endpoint = searchText
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
      5000,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        "Google Places returned " +
          response.status +
          ": " +
          errorBody.slice(0, 220),
      );
    }

    const data = await response.json();
    const results = Array.isArray(data.places) ? data.places : [];

    return results
      .map((place: any, index: number) => {
        const latitude = Number(place.location?.latitude);
        const longitude = Number(place.location?.longitude);
        const name = String(place.displayName?.text ?? "").trim();
        const primaryType = String(
          place.primaryType ?? place.types?.[0] ?? "place",
        ).trim();

        if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        return {
          id: "google-" + String(place.id ?? index),
          name,
          type: primaryType || "place",
          group: classifyGooglePlace(primaryType),
          latitude,
          longitude,
          distanceKm: haversineKm(center!, { latitude, longitude }),
          description: searchText
            ? "Matched your search for " + searchText + " in " + destination + "."
            : "Popular place to visit in " + destination + ".",
          website: place.websiteUri,
          address: place.formattedAddress,
        } as DiscoveredPlace;
      })
      .filter(Boolean) as DiscoveredPlace[];
  }

  if (googleApiKey) {
    try {
      const googlePlaces = await discoverWithGoogle();
      if (googlePlaces.length) {
        const unique = new Map<string, DiscoveredPlace>();
        for (const place of googlePlaces) {
          const key = place.name.toLowerCase();
          if (!unique.has(key)) unique.set(key, place);
        }

        return {
          center,
          places: [...unique.values()]
            .sort((a, b) => a.distanceKm - b.distanceKm)
            .slice(0, limit),
          source: "google",
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      console.warn(
        "Google Places discovery failed; falling back to OpenStreetMap.",
        error,
      );
    }
  }

  // Fast live OSM fallback. Keep the query deliberately small so a Vercel
  // serverless request does not spend its whole lifetime waiting on Overpass.
  const fallbackQuery = searchText
    ? searchText + " " + destination
    : destination + " tourist attractions landmarks parks museums temples";

  try {
    const params = new URLSearchParams({
      q: fallbackQuery,
      format: "jsonv2",
      limit: "40",
      addressdetails: "1",
      "accept-language": "en",
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
      4000,
    );

    if (response.ok) {
      const results = await response.json();
      const unique = new Map<string, DiscoveredPlace>();

      for (const item of Array.isArray(results) ? results : []) {
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        const name = String(
          item.name || item.display_name?.split(",")[0] || "",
        ).trim();

        if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          continue;
        }

        const category = String(
          item.type || item.class || "place",
        ).toLowerCase();

        const group: DiscoveredPlace["group"] =
          /museum|gallery|theatre|theater|arts|temple|church|shrine|mosque|worship/.test(
            category,
          )
            ? "Culture"
            : /park|garden|beach|nature|viewpoint|peak|waterfall/.test(category)
              ? "Nature"
              : /monument|memorial|castle|ruins|historic|fort|archaeological/.test(
                    category,
                  )
                ? "History"
                : "Attraction";

        const place: DiscoveredPlace = {
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
        };

        const key = name.toLowerCase();
        if (!unique.has(key)) unique.set(key, place);
      }

      const places = [...unique.values()]
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

      if (places.length) {
        return {
          center,
          places,
          source: "openstreetmap",
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch (error) {
    console.warn("Nominatim place discovery failed.", error);
  }

  throw new Error(
    "No live places were returned for " +
      destination +
      ". Try a city name or a more specific search.",
  );
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
