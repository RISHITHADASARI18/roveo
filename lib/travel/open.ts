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
      "places.rating",
      "places.userRatingCount",
    ].join(",");

    // Automatic discovery must work for cities as well as broad regions/states.
    // A single 30 km circle around the geocoded center misses places such as
    // Munnar or beaches when the destination is an entire state like Kerala.
    // For automatic discovery, query several travel categories and merge them.
    // Destination discovery is category-driven. Important places can belong
    // to entertainment, family attractions, shopping, religion, beaches,
    // gardens, museums and many other categories, so one generic query is
    // not enough. We merge several focused searches and rank the result set.
    const queries = searchText
      ? [searchText + " in " + destination]
      : [
          "most famous must visit places in " + destination,
          "top tourist attractions and landmarks in " + destination,
          "amusement parks theme parks and water parks in " + destination,
          "family attractions entertainment and activities in " + destination,
          "historic monuments forts palaces and heritage sites in " + destination,
          "museums galleries cultural and art places in " + destination,
          "famous temples churches mosques and religious places in " + destination,
          "parks gardens lakes viewpoints and scenic places in " + destination,
          "nature attractions waterfalls hills mountains and wildlife in " + destination,
          "beaches coastal places and waterfront attractions in " + destination,
          "famous markets shopping streets and local attractions in " + destination,
          "popular food streets restaurants and culinary attractions in " + destination,
        ];

    const endpoint = "https://places.googleapis.com/v1/places:searchText";

    const responses = await Promise.all(
      queries.map(async (textQuery, queryIndex) => {
        const body: Record<string, unknown> = {
          textQuery,
          pageSize: 20,
          languageCode: "en",
          rankPreference: "RELEVANCE",
        };

        // Automatic destination discovery is intentionally not restricted to
        // one arbitrary center point. Explicit searches can use the radius.
        if (searchText) {
          body.locationBias = {
            circle: {
              center: { latitude: center!.latitude, longitude: center!.longitude },
              radius,
            },
          };
        }

        try {
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
            console.warn("Google Places query failed:", textQuery, response.status);
            return { queryIndex, places: [] as any[] };
          }

          const data = await response.json();
          return {
            queryIndex,
            places: Array.isArray(data.places) ? data.places : [],
          };
        } catch (error) {
          console.warn("Google Places query failed:", textQuery, error);
          return { queryIndex, places: [] as any[] };
        }
      }),
    );

    const results = responses.flatMap((result) =>
      result.places.map((place) => ({ place, queryIndex: result.queryIndex })),
    );

    return results
      .map(({ place, queryIndex }, index) => {
        const latitude = Number(place.location?.latitude);
        const longitude = Number(place.location?.longitude);
        const name = String(place.displayName?.text ?? "").trim();
        const primaryType = String(
          place.primaryType ?? place.types?.[0] ?? "place",
        ).trim();
        const types = Array.isArray(place.types)
          ? place.types.map((type: unknown) => String(type).toLowerCase())
          : [];

        if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        const categoryBoost =
          queryIndex === 0 ? 40 :
          queryIndex === 1 ? 32 :
          queryIndex === 2 ? 30 :
          queryIndex === 3 ? 28 :
          20;

        const typeBoost =
          /amusement_park|theme_park|water_park|tourist_attraction|landmark/.test(types.join(" "))
            ? 18
            : /museum|historical_landmark|monument|castle|palace|fort|zoo|aquarium/.test(types.join(" "))
              ? 15
              : /park|garden|beach|natural_feature|place_of_worship|shopping_mall/.test(types.join(" "))
                ? 10
                : 5;

        const rating = Number(place.rating ?? 0);
        const reviewCount = Number(place.userRatingCount ?? 0);
        const ratingBoost = Number.isFinite(rating) ? rating * 2 : 0;
        const popularityBoost =
          reviewCount > 10000 ? 15 :
          reviewCount > 3000 ? 10 :
          reviewCount > 500 ? 6 :
          reviewCount > 100 ? 3 : 0;

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
          _discoveryScore: categoryBoost + typeBoost + ratingBoost + popularityBoost,
        } as DiscoveredPlace & { _discoveryScore: number };
      })
      .filter(Boolean) as Array<DiscoveredPlace & { _discoveryScore: number }>;

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
            .sort((a, b) => {
              const scoreDiff =
                ((b as DiscoveredPlace & { _discoveryScore?: number })._discoveryScore ?? 0) -
                ((a as DiscoveredPlace & { _discoveryScore?: number })._discoveryScore ?? 0);
              if (scoreDiff !== 0) return scoreDiff;
              return a.distanceKm - b.distanceKm;
            })
            .slice(0, limit)
            .map((place) => {
              const clean = { ...place } as DiscoveredPlace & { _discoveryScore?: number };
              delete clean._discoveryScore;
              return clean;
            }),
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

  // Free live fallback: Wikimedia geosearch is much more reliable for named
  // tourist/landmark places than sending a long natural-language query to Nominatim.
  try {
    const params = new URLSearchParams({
      action: "query",
      generator: "geosearch",
      ggsprimary: "all",
      ggsnamespace: "0",
      ggscoord: center.latitude + "|" + center.longitude,
      ggsradius: String(radius),
      ggslimit: String(Math.min(limit, 50)),
      prop: "extracts|info|coordinates",
      exintro: "1",
      explaintext: "1",
      exchars: "500",
      inprop: "url",
      format: "json",
      origin: "*",
    });

    const response = await fetchWithTimeout(
      "https://en.wikipedia.org/w/api.php?" + params.toString(),
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
      const data = await response.json();
      const pages = Object.values(data.query?.pages ?? {}) as any[];
      const places = pages
        .map((page: any) => {
          const coordinate = page.coordinates?.[0];
          const latitude = Number(coordinate?.lat);
          const longitude = Number(coordinate?.lon);
          const name = String(page.title ?? "").trim();
          if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

          const text = String(page.extract ?? "").trim();
          const lower = (name + " " + text).toLowerCase();
          const group: DiscoveredPlace["group"] =
            /museum|temple|church|mosque|palace|fort|monument|heritage|historical|cathedral|shrine|memorial/.test(lower)
              ? "Culture"
              : /beach|waterfall|hill|mountain|park|forest|lake|backwater|wildlife|sanctuary|viewpoint|garden|peak/.test(lower)
                ? "Nature"
                : /tourist|attraction|palace|fort|landmark|museum/.test(lower)
                  ? "Attraction"
                  : "Activity";

          return {
            id: "wikipedia-" + String(page.pageid ?? name),
            name,
            type: "landmark",
            group,
            latitude,
            longitude,
            distanceKm: haversineKm(center, { latitude, longitude }),
            description: text || "Live place record from Wikipedia geosearch.",
            website: page.fullurl,
          } as DiscoveredPlace;
        })
        .filter(Boolean) as DiscoveredPlace[];

      if (places.length) {
        return {
          center,
          places: places
            .sort((a, b) => a.distanceKm - b.distanceKm)
            .slice(0, limit),
          source: "openstreetmap",
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch (error) {
    console.warn("Wikimedia place discovery failed.", error);
  }

  // Final free fallback through Nominatim. Keep the query short because
  // Nominatim is designed for geocoding/search, not broad POI discovery.
  try {
    const queries = searchText
      ? [searchText + " " + destination, searchText]
      : ["tourist attraction " + destination, "landmark " + destination, "museum " + destination];
    const unique = new Map<string, DiscoveredPlace>();

    for (const query of queries) {
      const params = new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "20",
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
        2500,
      );
      if (!response.ok) continue;
      const results = await response.json();
      for (const item of Array.isArray(results) ? results : []) {
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        const name = String(item.name || item.display_name?.split(",")[0] || "").trim();
        if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        const distanceKm = haversineKm(center, { latitude, longitude });
        if (distanceKm > radius / 1000) continue;
        const category = String(item.type || item.class || "place").toLowerCase();
        const group: DiscoveredPlace["group"] =
          /museum|gallery|theatre|theater|arts|temple|church|shrine|mosque|worship/.test(category)
            ? "Culture"
            : /park|garden|beach|nature|viewpoint|peak|waterfall/.test(category)
              ? "Nature"
              : /monument|memorial|castle|ruins|historic|fort|archaeological/.test(category)
                ? "History"
                : "Attraction";
        const place: DiscoveredPlace = {
          id: "nominatim-" + String(item.osm_type ?? "place") + "-" + String(item.osm_id ?? name),
          name,
          type: category,
          group,
          latitude,
          longitude,
          distanceKm,
          description: item.display_name,
          address: item.display_name,
        };
        const key = name.toLowerCase();
        if (!unique.has(key)) unique.set(key, place);
      }
      if (unique.size >= limit) break;
    }

    if (unique.size) {
      return {
        center,
        places: [...unique.values()].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit),
        source: "openstreetmap",
        fetchedAt: new Date().toISOString(),
      };
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
