import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTravelProvider } from "@/lib/travel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validMode(value: string | null) {
  return value === "DRIVE" || value === "WALK" || value === "BICYCLE";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  const url = new URL(request.url);
  const fromPlaceId = Number(url.searchParams.get("fromPlaceId"));
  const toPlaceId = Number(url.searchParams.get("toPlaceId"));
  const mode = (url.searchParams.get("mode") || "DRIVE").toUpperCase();

  if (!Number.isInteger(fromPlaceId) || fromPlaceId <= 0 || !Number.isInteger(toPlaceId) || toPlaceId <= 0) {
    return NextResponse.json({ error: "Valid fromPlaceId and toPlaceId are required." }, { status: 400 });
  }
  if (fromPlaceId === toPlaceId) {
    return NextResponse.json({ error: "The two places must be different." }, { status: 400 });
  }
  if (!validMode(mode)) {
    return NextResponse.json({ error: "mode must be DRIVE, WALK, or BICYCLE." }, { status: 400 });
  }

  try {
    const result = await db.query(
      `SELECT id, name, latitude, longitude
       FROM trip_places
       WHERE trip_id = $1 AND id = ANY($2::bigint[])`,
      [tripId, [fromPlaceId, toPlaceId]]
    );

    if (result.rows.length !== 2) {
      return NextResponse.json({ error: "Both places must belong to this trip." }, { status: 404 });
    }

    const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
    const from = byId.get(fromPlaceId);
    const to = byId.get(toPlaceId);

    const provider = getTravelProvider();
    const route = await provider.computeRoute({
      origin: { latitude: Number(from.latitude), longitude: Number(from.longitude) },
      destination: { latitude: Number(to.latitude), longitude: Number(to.longitude) },
      mode: mode as "DRIVE" | "WALK" | "BICYCLE",
    });

    return NextResponse.json({
      from: { id: fromPlaceId, name: from.name },
      to: { id: toPlaceId, name: to.name },
      mode,
      provider: route.provider,
      distanceKm: route.distanceMeters / 1000,
      durationMinutes: route.durationSeconds / 60,
      encodedPolyline: route.encodedPolyline ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET /api/trips/[id]/places/route failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not calculate the place route." },
      { status: 502 }
    );
  }
}
