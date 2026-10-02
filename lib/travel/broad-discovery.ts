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

type Coverage = {
  anchors: Coordinates[];
  regional: boolean;
  heightDegrees: number;
  widthDegrees: number;
  bounds?: { south: number; north: number; west: number; east: number };
};

async function destinationCoverage(destination: string, fallback: Coordinates): Promise<Coverage> {
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
          "User-Agent": "Roveo/1.0 (travel planner; destination coverage)",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return { anchors: [fallback], regional: false, heightDegrees: 0, widthDegrees: 0 };
    }

    const data = await response.json();
    const first = Array.isArray(data) ? data[0] : null;
    const box = Array.isArray(first?.boundingbox) ? first.boundingbox.map(Number) : [];
    if (box.length !== 4 || box.some((value: number) => !Number.isFinite(value))) {
      return { anchors: [fallback], regional: false, heightDegrees: 0, widthDegrees: 0 };
    }

    const south = box[0];
    const north = box[1];
    const west = box[2];
    const east = box[3];
    const heightDegrees = Math.abs(north - south);
    const widthDegrees = Math.abs(east - west);
    const maxDimension = Math.max(heightDegrees, widthDegrees);

    const addressType = String(first?.addresstype ?? first?.type ?? "").toLowerCase();
    const regionalType = /state|country|region|county|province|territory|district/.test(addressType);
    const regional = regionalType || maxDimension >= 1.2;

    if (!regional) {
      return {
        anchors: [fallback],
        regional: false,
        heightDegrees,
        widthDegrees,
        bounds: { south, north, west, east },
      };
    }

    // Destination size, not an arbitrary search radius, determines coverage.
    // Generate a small adaptive grid so a whole state/region is explored
    // across multiple areas instead of around one geocoded center.
    const aspect = widthDegrees / Math.max(heightDegrees, 0.25);
    let columns = Math.max(2, Math.ceil(Math.sqrt(10 * aspect)));
    let rows = Math.max(2, Math.ceil(10 / columns));

    while (columns * rows > 12) {
      if (columns > rows) columns -= 1;
      else rows -= 1;
    }

    const points: Coordinates[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        points.push({
          latitude: south + heightDegrees * ((row + 0.5) / rows),
          longitude: west + widthDegrees * ((column + 0.5) / columns),
        });
      }
    }

    // Keep the destination's geocoded center in the coverage set when it is
    // not already represented by a grid cell.
    points.push(fallback);

    const unique = new Map<string, Coordinates>();
    for (const point of points) {
      unique.set(
        point.latitude.toFixed(3) + ":" + point.longitude.toFixed(3),
        point,
      );
    }

    return {
      anchors: [...unique.values()],
      regional: true,
      heightDegrees,
      widthDegrees,
      bounds: { south, north, west, east },
    };
  } catch {
    return { anchors: [fallback], regional: false, heightDegrees: 0, widthDegrees: 0 };
  }
}

async function wikipediaSupplement(
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

    const distanceKm = haversineKm(center, { latitude, longitude });
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
  _legacyRadiusMeters = 0,
  maxResults = 200,
) {
  const limit = Math.min(Math.max(Math.round(maxResults), 1), 250);

  // Resolve the actual destination boundary first. This is deliberately
  // independent of the requested radius: a state/country is not represented
  // by a 30 km circle around one point.
  const initialCoverage = await destinationCoverage(destination, {
    latitude: 0,
    longitude: 0,
  });

  const destinationRadius = initialCoverage.bounds
    ? Math.min(
        50000,
        Math.max(
          5000,
          Math.ceil(
            (Math.max(initialCoverage.heightDegrees, initialCoverage.widthDegrees) * 111000) / 2,
          ),
        ),
      )
    : 15000;

  const primary = await discoverPlaces(
    destination,
    destinationRadius,
    limit,
    "",
    initialCoverage.bounds,
  );

  const coverage =
    initialCoverage.bounds
      ? initialCoverage
      : await destinationCoverage(destination, primary.center);

  const anchorRadius = coverage.regional
    ? Math.min(
        50000,
        Math.max(
          15000,
          Math.ceil(
            (Math.sqrt(
              coverage.heightDegrees ** 2 + coverage.widthDegrees ** 2,
            ) * 111000) /
              Math.max(coverage.anchors.length / 2, 1),
          ),
        ),
      )
    : destinationRadius;

  const perAnchorLimit = Math.min(
    60,
    Math.max(20, Math.ceil(limit / coverage.anchors.length)),
  );

  const wikiByAnchor = await Promise.all(
    coverage.anchors.map((anchor) =>
      wikipediaSupplement(anchor, anchorRadius, perAnchorLimit),
    ),
  );

  const osmResults = coverage.regional
    ? await Promise.all(
        coverage.anchors.map((anchor) =>
          osmSupplement(
            destination,
            anchor,
            anchorRadius,
            Math.min(20, Math.ceil(limit / coverage.anchors.length)),
          ),
        ),
      )
    : [
        await osmSupplement(
          destination,
          primary.center,
          anchorRadius,
          Math.min(limit, 100),
        ),
      ];
  const osm = osmResults.flat();
  const wiki = wikiByAnchor.flat();

  const unique = new Map<string, DiscoveredPlace & {
    _broadScore: number;
    _coverageDistanceKm: number;
  }>();

  const add = (place: DiscoveredPlace, sourceWeight: number) => {
    const key = place.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (!key) return;

    const coverageDistanceKm = coverage.regional
      ? Math.min(
          ...coverage.anchors.map((anchor) =>
            haversineKm(anchor, {
              latitude: place.latitude,
              longitude: place.longitude,
            }),
          ),
        )
      : place.distanceKm;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, {
        ...place,
        _broadScore: sourceWeight,
        _coverageDistanceKm: coverageDistanceKm,
      });
      return;
    }

    const currentScore = Number(existing._broadScore ?? 0);
    if (sourceWeight > currentScore) {
      unique.set(key, {
        ...existing,
        ...place,
        _broadScore: sourceWeight,
        _coverageDistanceKm: Math.min(
          existing._coverageDistanceKm,
          coverageDistanceKm,
        ),
      });
    }
  };

  primary.places.forEach((place) => add(place, 100));
  wiki.forEach((place) =>
    add(place, 112 + Math.min(18, place.distanceKm / 20)),
  );
  osm.forEach((place) => add(place, 55));

  const scored = [...unique.values()].map((place) => {
    const sourceScore = Number(place._broadScore ?? 0);
    const distanceScore = coverage.regional
      ? Math.max(0, 24 - place._coverageDistanceKm / 4)
      : Math.max(0, 30 - place._coverageDistanceKm / 2);

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
      const clean = { ...place } as DiscoveredPlace & {
        _broadScore?: number;
        _coverageDistanceKm?: number;
      };
      delete clean._broadScore;
      delete clean._coverageDistanceKm;
      return clean;
    }),
    source: "google" as const,
    fetchedAt: new Date().toISOString(),
  };
}
