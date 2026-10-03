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

  try {
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
    const storedCoverage =
      Number.isFinite(lat) && Number.isFinite(lon)
        ? {
            center: { latitude: lat, longitude: lon },
            bounds:
              [south, north, west, east].every(Number.isFinite)
                ? { south, north, west, east }
                : undefined,
          }
        : undefined;

    const result = desiredQuery
      ? await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 250), desiredQuery, storedCoverage)
      : await discoverBroadPlaces(String(row.destination), 0, Math.min(Math.max(Math.round(maxResults), 1), 250), "", storedCoverage);

    return NextResponse.json({ tripId, destination: trip.rows[0].destination, ...result });
  } catch (error) {
    console.error("GET /api/trips/[id]/places/discover failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not discover places." }, { status: 502 });
  }
}
