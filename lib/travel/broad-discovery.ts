import { discoverPlaces, openTravelProvider } from "./open";
import type { Coordinates, DiscoveredPlace } from "./types";

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

function groupFor(text: string): DiscoveredPlace["group"] {
  const value = text.toLowerCase();
  if (/museum|gallery|temple|church|mosque|worship|theatre|cultural/.test(value)) return "Culture";
  if (/fort|palace|monument|historic|heritage|memorial|ruin|castle/.test(value)) return "History";
  if (/park|garden|beach|waterfall|lake|hill|mountain|nature|wildlife|viewpoint/.test(value)) return "Nature";
  if (/amusement|theme|water park|zoo|aquarium|activity|attraction/.test(value)) return "Attraction";
  return "Activity";
}

async function destinationAnchors(destination: string, fallback: Coordinates) {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      limit: "1",
      q: destination,
      addressdetails: "1",
    });
    const response = await fetch(
      "https://nominatim.openstreetmap.org/search?" + params.toString(),
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Roveo/1.0 (travel planner; regional discovery)",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return [fallback];
    const data = await response.json();
    const first = Array.isArray(data) ? data[0] : null;
    const box = Array.isArray(first?.boundingbox) ? first.boundingbox.map(Number) : [];
    if (box.length !== 4 || box.some((value: number) => !Number.isFinite(value))) {
      return [fallback];
    }

    const south = box[0];
    const north = box[1];
    const west = box[2];
    const east = box[3];
    const height = Math.abs(north - south);
    const width = Math.abs(east - west);

    // Cities usually fit well around one center. Large regions/states need
    // multiple discovery anchors so one local cluster cannot dominate.
    if (Math.max(height, width) < 1.2) return [fallback];

    const points = [
      fallback,
      { latitude: south + height * 0.25, longitude: west + width * 0.25 },
      { latitude: south + height * 0.25, longitude: west + width * 0.75 },
      { latitude: south + height * 0.75, longitude: west + width * 0.25 },
      { latitude: south + height * 0.75, longitude: west + width * 0.75 },
    ];

    const unique = new Map<string, Coordinates>();
    for (const point of points) {
      unique.set(point.latitude.toFixed(3) + ":" + point.longitude.toFixed(3), point);
    }
    return [...unique.values()];
  } catch {
    return [fallback];
  }
}

async function wikipediaSupplement(
  destination: string,
  center: Coordinates,
  radiusMeters: number,
  limit: number,
) {
  const params = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggsprimary: "all",
    ggsnamespace: "0",
    ggscoord: center.latitude + "|" + center.longitude,
    ggsradius: String(Math.min(radiusMeters, 50000)),
    ggslimit: String(Math.min(Math.max(limit, 20), 100)),
    prop: "extracts|info|coordinates",
    exintro: "1",
    explaintext: "1",
    exchars: "700",
    inprop: "url",
    format: "json",
    origin: "*",
  });

  const response = await fetch(
    "https://en.wikipedia.org/w/api.php?" + params.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Roveo/1.0 (travel planner; broad place discovery)",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) return [] as DiscoveredPlace[];

  const data = await response.json();
  const pages = Object.values(data.query?.pages ?? {}) as any[];

  return pages
    .map((page: any) => {
      const coordinate = page.coordinates?.[0];
      const latitude = Number(coordinate?.lat);
      const longitude = Number(coordinate?.lon);
      const name = String(page.title ?? "").trim();
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      const description = String(page.extract ?? "").trim();
      const lower = (name + " " + description).toLowerCase();
      const distanceKm = haversineKm(center, { latitude, longitude });

      if (distanceKm > radiusMeters / 1000) return null;

      return {
        id: "wikipedia-" + String(page.pageid ?? name),
        name,
        type: "landmark",
        group: groupFor(lower),
        latitude,
        longitude,
        distanceKm,
        description: description || "Named destination place.",
        website: page.fullurl,
      } as DiscoveredPlace;
    })
    .filter(Boolean) as DiscoveredPlace[];
}

async function osmSupplement(
  destination: string,
  center: Coordinates,
  radiusMeters: number,
  limit: number,
) {
  const queries = [
    "tourist attraction " + destination,
    "theme park " + destination,
    "water park " + destination,
    "amusement park " + destination,
    "museum " + destination,
    "fort " + destination,
    "palace " + destination,
    "temple " + destination,
    "park " + destination,
    "waterfall " + destination,
    "viewpoint " + destination,
    "beach " + destination,
  ];

  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        return await openTravelProvider.searchPlaces({
          textQuery: query,
          latitude: center.latitude,
          longitude: center.longitude,
          maxResults: 20,
        });
      } catch {
        return [];
      }
    }),
  );

  const unique = new Map<string, DiscoveredPlace>();
  for (const place of results.flat()) {
    if (!place.name || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
    const latitude = place.latitude;
    const longitude = place.longitude;
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    const distanceKm = haversineKm(center, {
      latitude,
      longitude,
    });
    if (distanceKm > radiusMeters / 1000) continue;

    const key = place.name.trim().toLowerCase();
    if (unique.has(key)) continue;

    unique.set(key, {
      id: "osm-" + place.id,
      name: place.name,
      type: place.types[0] || "place",
      group: groupFor(place.name + " " + place.types.join(" ")),
      latitude,
      longitude,
      distanceKm,
      description: place.address || "Place discovered from OpenStreetMap.",
      address: place.address,
    });
  }

  return [...unique.values()].slice(0, limit);
}

export async function discoverBroadPlaces(
  destination: string,
  radiusMeters = 50000,
  maxResults = 200,
) {
  const radius = Math.min(Math.max(Math.round(radiusMeters), 1000), 50000);
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 250);

  const primary = await discoverPlaces(destination, radius, limit, "");

  const anchors = await destinationAnchors(destination, primary.center);

  // Wikipedia geosearch is used at several anchors for large destinations.
  // This prevents a single central city/area from dominating the discovery list.
  const wikiByAnchor = await Promise.all(
    anchors.map((anchor) =>
      wikipediaSupplement(destination, anchor, radius, Math.min(60, Math.max(20, Math.ceil(limit / anchors.length)))),
    ),
  );

  // Keep OSM as a lighter supplementary source at the primary center. Its
  // geocoder is rate-limited, so we deliberately do not fan it out across
  // every regional anchor.
  const osm = await osmSupplement(destination, primary.center, radius, Math.min(limit, 100));
  const wiki = wikiByAnchor.flat();

  const unique = new Map<string, DiscoveredPlace>();
  const add = (place: DiscoveredPlace, sourceWeight: number) => {
    const key = place.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (!key) return;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...place, _broadScore: sourceWeight } as DiscoveredPlace & { _broadScore: number });
      return;
    }

    const currentScore = Number((existing as any)._broadScore ?? 0);
    if (sourceWeight > currentScore) {
      unique.set(key, {
        ...existing,
        ...place,
        _broadScore: sourceWeight,
      } as DiscoveredPlace & { _broadScore: number });
    }
  };

  // Google gives strong place relevance, while Wikipedia's regional anchors
  // are important for large destinations because they surface named landmarks
  // that may be far from the destination's geocoded center.
  primary.places.forEach((place) => add(place, 100));
  wiki.forEach((place) =>
    add(place, 112 + Math.min(18, place.distanceKm / 20)),
  );
  osm.forEach((place) => add(place, 55));

  const scored = [...unique.values()].map((place) => {
    const sourceScore = Number((place as any)._broadScore ?? 0);
    const distanceScore = Math.max(0, 30 - place.distanceKm / 2);
    const typeScore =
      place.group === "Attraction" ? 18 :
      place.group === "History" ? 16 :
      place.group === "Nature" ? 14 :
      place.group === "Culture" ? 12 : 8;

    return {
      place,
      score: sourceScore + distanceScore + typeScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    center: primary.center,
    places: scored.slice(0, limit).map(({ place }) => {
      const clean = { ...place } as DiscoveredPlace & { _broadScore?: number };
      delete clean._broadScore;
      return clean;
    }),
    source: "google" as const,
    fetchedAt: new Date().toISOString(),
  };
}
