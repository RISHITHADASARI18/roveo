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
  const suppliedLat = Number(url.searchParams.get("lat"));
  const suppliedLon = Number(url.searchParams.get("lon"));
  const suppliedSouth = Number(url.searchParams.get("south"));
  const suppliedNorth = Number(url.searchParams.get("north"));
  const suppliedWest = Number(url.searchParams.get("west"));
  const suppliedEast = Number(url.searchParams.get("east"));

  try {
    // Existing production databases may predate the exact-location columns.
    // Add them before the SELECT so place discovery works without requiring a manual migration.
    await db.query(`
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lon DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_south DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_north DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_west DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_east DOUBLE PRECISION;
    `);

    const trip = await db.query(
      `SELECT id, destination, destination_lat, destination_lon,
              destination_south, destination_north, destination_west, destination_east
         FROM trips WHERE id = $1`,
      [tripId]
    );
    if (!trip.rows[0]) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    const row = trip.rows[0];
    const lat = Number(row.destination_lat);
    const lon = Number(row.destination_lon);
    const south = Number(row.destination_south);
    const north = Number(row.destination_north);
    const west = Number(row.destination_west);
    const east = Number(row.destination_east);
    let storedCoverage =
      Number.isFinite(suppliedLat) && Number.isFinite(suppliedLon)
        ? {
            center: { latitude: suppliedLat, longitude: suppliedLon },
            bounds:
              [suppliedSouth, suppliedNorth, suppliedWest, suppliedEast].every(Number.isFinite)
                ? { south: suppliedSouth, north: suppliedNorth, west: suppliedWest, east: suppliedEast }
                : undefined,
          }
        : Number.isFinite(lat) && Number.isFinite(lon)
        ? {
            center: { latitude: lat, longitude: lon },
            bounds:
              [south, north, west, east].every(Number.isFinite)
                ? { south, north, west, east }
                : undefined,
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

    if (!storedCoverage) {
      return NextResponse.json({ error: "Could not locate destination: " + String(row.destination) }, { status: 502 });
    }

    const result = desiredQuery
      ? await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 1000), desiredQuery, storedCoverage)
      : await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 1000), "", storedCoverage);

    return NextResponse.json({ tripId, destination: trip.rows[0].destination, ...result });
  } catch (error) {
    console.error("GET /api/trips/[id]/places/discover failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not discover places." }, { status: 502 });
  }
}
