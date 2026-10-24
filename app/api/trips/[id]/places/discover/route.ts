import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { discoverPlaces } from "@/lib/travel/open";
import { discoverBroadPlaces } from "@/lib/travel/broad-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  const url = new URL(request.url);
  const maxResults = Number(url.searchParams.get("maxResults") ?? "200");
  const desiredQuery = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const destinationId = Number(url.searchParams.get("destinationId"));
  const hasDestinationId = Number.isInteger(destinationId) && destinationId > 0;
  // Number(null) is 0, which falsely made omitted query parameters look
  // like real coordinates (0,0) and a valid all-zero bounding box.
  const readCoordinate = (key: string) => {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === "") return Number.NaN;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const suppliedLat = readCoordinate("lat");
  const suppliedLon = readCoordinate("lon");
  const suppliedSouth = readCoordinate("south");
  const suppliedNorth = readCoordinate("north");
  const suppliedWest = readCoordinate("west");
  const suppliedEast = readCoordinate("east");

  try {
    const trip = await db.query(
      `SELECT id, destination, destination_lat, destination_lon,
              destination_south, destination_north, destination_west, destination_east
         FROM trips WHERE id = $1`,
      [tripId]
    );
    if (!trip.rows[0]) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    // Phase 2: discovery is scoped to one selected trip destination at a time.
    // This keeps Delhi, Agra and Jaipur independent instead of accidentally
    // discovering everything around only the first destination.
    let row = trip.rows[0];
    if (hasDestinationId) {
      const selected = await db.query(
        `SELECT destination_name AS destination, latitude AS destination_lat, longitude AS destination_lon,
                bounding_south AS destination_south, bounding_north AS destination_north,
                bounding_west AS destination_west, bounding_east AS destination_east
           FROM trip_destinations
          WHERE id = $1 AND trip_id = $2`,
        [destinationId, tripId]
      );
      if (!selected.rows[0]) {
        return NextResponse.json({ error: "Trip destination not found." }, { status: 404 });
      }
      row = { ...row, ...selected.rows[0] };
    }
    // Database NULLs must stay missing. Number(null) is 0, which can
    // accidentally create a valid-looking bounding box at (0, 0) and filter
    // every real attraction out of the destination results.
    const readOptionalCoordinate = (value: unknown): number | undefined => {
      if (value === null || value === undefined || value === "") return undefined;
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    };
    const lat = readOptionalCoordinate(row.destination_lat);
    const lon = readOptionalCoordinate(row.destination_lon);
    const south = readOptionalCoordinate(row.destination_south);
    const north = readOptionalCoordinate(row.destination_north);
    const west = readOptionalCoordinate(row.destination_west);
    const east = readOptionalCoordinate(row.destination_east);
    const suppliedBounds = [suppliedSouth, suppliedNorth, suppliedWest, suppliedEast].every(Number.isFinite)
      ? { south: suppliedSouth, north: suppliedNorth, west: suppliedWest, east: suppliedEast }
      : undefined;
    const savedBounds = [south, north, west, east].every((value) => value !== undefined)
      ? { south: south!, north: north!, west: west!, east: east! }
      : undefined;
    const storedBounds = suppliedBounds ?? savedBounds;
    let storedCoverage =
      Number.isFinite(suppliedLat) && Number.isFinite(suppliedLon)
        ? {
            center: { latitude: suppliedLat, longitude: suppliedLon },
            // The Places page supplies the center but not always the bounding
            // box. Only reuse a complete, non-null saved bounding box.
            bounds: storedBounds,
          }
        : lat !== undefined && lon !== undefined
        ? {
            center: { latitude: lat, longitude: lon },
            bounds: storedBounds,
          }
        : undefined;

    // Backfill coordinates for older trips that only stored the destination name.
    if (!storedCoverage) {
      let recovered: { center: { latitude: number; longitude: number }; bounds: { south: number; north: number; west: number; east: number } | undefined } | null = null;
      try {
        const params = new URLSearchParams({
          q: String(row.destination), format: "jsonv2", limit: "1",
          addressdetails: "1", namedetails: "1", "accept-language": "en",
        });
        const response = await fetch("https://nominatim.openstreetmap.org/search?" + params, {
          headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination backfill)" },
          cache: "no-store",
        });
        if (response.ok) {
          const data = await response.json();
          const first = Array.isArray(data) ? data[0] : null;
          const latitude = Number(first?.lat);
          const longitude = Number(first?.lon);
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            const box = Array.isArray(first?.boundingbox) ? first.boundingbox.map(Number) : [];
            recovered = {
              center: { latitude, longitude },
              bounds: box.length === 4 && box.every((v: number) => Number.isFinite(v))
                ? { south: box[0], north: box[1], west: box[2], east: box[3] }
                : undefined,
            };
          }
        }
      } catch {
        // Try Photon below.
      }

      if (!recovered) {
        try {
          const params = new URLSearchParams({ q: String(row.destination), limit: "1", lang: "en" });
          const response = await fetch("https://photon.komoot.io/api/?" + params, {
            headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner; destination backfill)" },
            cache: "no-store",
          });
          if (response.ok) {
            const data = await response.json();
            const feature = Array.isArray(data?.features) ? data.features[0] : null;
            const coords = feature?.geometry?.coordinates;
            const longitude = Number(coords?.[0]);
            const latitude = Number(coords?.[1]);
            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
              const box = Array.isArray(feature?.bbox) ? feature.bbox.map(Number) : [];
              recovered = {
                center: { latitude, longitude },
                bounds: box.length === 4 && box.every((v: number) => Number.isFinite(v))
                  ? { south: box[1], north: box[3], west: box[0], east: box[2] }
                  : undefined,
              };
            }
          }
        } catch {
          // Both free geocoders failed.
        }
      }

      if (recovered) {
        storedCoverage = recovered;
        await db.query(
          `UPDATE trips
              SET destination_lat = $1, destination_lon = $2,
                  destination_south = $3, destination_north = $4,
                  destination_west = $5, destination_east = $6,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $7`,
          [
            recovered.center.latitude, recovered.center.longitude,
            recovered.bounds?.south ?? null, recovered.bounds?.north ?? null,
            recovered.bounds?.west ?? null, recovered.bounds?.east ?? null, tripId,
          ],
        );
      }
    }

    // Keep broad-region discovery working even when public geocoders are temporarily unavailable.
    // These coordinates also let the discovery layer classify the destination as a state.
    if (!storedCoverage && /^kerala(?:,\\s*india)?$/i.test(String(row.destination).trim())) {
      storedCoverage = {
        center: { latitude: 10.8505, longitude: 76.2711 },
        bounds: { south: 8.17, north: 12.80, west: 74.85, east: 77.40 },
      };
    }

    if (!storedCoverage) {
      return NextResponse.json({ error: "Could not locate destination: " + String(row.destination) }, { status: 502 });
    }

    const result = desiredQuery
      ? await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 1000), desiredQuery, storedCoverage)
      : await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 1000), "", storedCoverage);

    return NextResponse.json({
      tripId,
      destinationId: hasDestinationId ? destinationId : null,
      destination: row.destination,
      ...result
    });
  } catch (error) {
    console.error("GET /api/trips/[id]/places/discover failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not discover places." }, { status: 502 });
  }
}
