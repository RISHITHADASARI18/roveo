import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildSmartItinerary } from "@/lib/travel/itinerary";
import type { PlannerPlace } from "@/lib/travel/itinerary-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  let body: { days?: unknown } = {};
  try { body = await request.json(); } catch {}

  try {
    const trip = await db.query("SELECT days FROM trips WHERE id = $1", [tripId]);
    if (trip.rowCount === 0) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    const dayCount = Math.max(1, Math.min(30, Number(body.days ?? trip.rows[0].days ?? 1) || 1));
    const placesResult = await db.query(
      "SELECT id, name, latitude, longitude, category, description, address FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC",
      [tripId]
    );

    const places: PlannerPlace[] = placesResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      category: row.category ? String(row.category) : undefined,
      description: row.description ? String(row.description) : undefined,
      address: row.address ? String(row.address) : undefined,
    }));

    const days = buildSmartItinerary(places, dayCount);
    return NextResponse.json({
      tripId,
      days,
      selectedPlaceCount: places.length,
      plannedPlaceCount: days.reduce((sum, day) => sum + day.items.length, 0),
      planner: {
        strategy: "geographic-clusters-and-nearest-neighbour",
        message: "Selected places are grouped by geographic proximity first, then ordered to reduce backtracking within each day.",
      },
    });
  } catch (error) {
    console.error("POST /api/trips/[id]/itinerary/plan failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not build the smart itinerary." }, { status: 500 });
  }
}
