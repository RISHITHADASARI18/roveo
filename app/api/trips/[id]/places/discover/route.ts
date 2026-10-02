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
  const radiusKm = Number(url.searchParams.get("radiusKm") ?? "50");
  const maxResults = Number(url.searchParams.get("maxResults") ?? "200");
  const desiredQuery = (url.searchParams.get("q") ?? "").trim().slice(0, 120);

  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    return NextResponse.json({ error: "radiusKm must be between 1 and 50." }, { status: 400 });
  }

  try {
    const trip = await db.query("SELECT id, destination FROM trips WHERE id = $1", [tripId]);
    if (!trip.rows[0]) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    const result = desiredQuery
      ? await discoverPlaces(String(trip.rows[0].destination), radiusKm * 1000, Math.min(Math.max(Math.round(maxResults), 1), 250), desiredQuery)
      : await discoverBroadPlaces(String(trip.rows[0].destination), radiusKm * 1000, Math.min(Math.max(Math.round(maxResults), 1), 250));

    return NextResponse.json({ tripId, destination: trip.rows[0].destination, ...result });
  } catch (error) {
    console.error("GET /api/trips/[id]/places/discover failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not discover places." }, { status: 502 });
  }
}
