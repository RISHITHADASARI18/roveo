import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTravelProvider } from "@/lib/travel";
import type { TravelMode } from "@/lib/travel/types";

export const runtime = "nodejs";

type RouteItem = {
  itemId: number;
  dayId: number;
  dayNumber: number;
  position: number;
  tripPlaceId: number;
  name: string;
  latitude: number;
  longitude: number;
};

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function modeFromLocalTravelMethod(value: string): TravelMode | null {
  switch (value.trim().toLowerCase()) {
    case "car":
    case "taxi":
      return "DRIVE";
    case "walking":
      return "WALK";
    case "bike":
      return "BICYCLE";
    case "public transport":
      return "TRANSIT";
    default:
      return null;
  }
}

function requestedMode(value: unknown, fallback: TravelMode): TravelMode | null {
  if (value === undefined || value === null || value === "") return fallback;
  return ["DRIVE", "WALK", "BICYCLE", "TRANSIT"].includes(String(value))
    ? String(value) as TravelMode
    : null;
}

function minutes(seconds: number) {
  return Math.round(seconds / 60);
}

async function loadTripItems(tripId: number): Promise<RouteItem[]> {
  const result = await db.query(
    `SELECT
      i.id AS "itemId",
      d.id AS "dayId",
      d.day_number AS "dayNumber",
      i.position,
      p.id AS "tripPlaceId",
      p.name,
      p.latitude,
      p.longitude
     FROM itinerary_days d
     JOIN itinerary_items i ON i.day_id = d.id
     JOIN trip_places p ON p.id = i.trip_place_id
     WHERE d.trip_id = $1
     ORDER BY d.day_number ASC, i.position ASC`,
    [tripId]
  );

  return result.rows.map((row) => ({
    itemId: Number(row.itemId),
    dayId: Number(row.dayId),
    dayNumber: Number(row.dayNumber),
    position: Number(row.position),
    tripPlaceId: Number(row.tripPlaceId),
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  try {
    const trip = await db.query(
      `SELECT local_travel_method AS "localTravelMethod"
       FROM trips
       WHERE id = $1`,
      [tripId]
    );

    if (trip.rowCount === 0) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const result = await db.query(
      `SELECT
        id,
        day_id AS "dayId",
        from_item_id AS "fromItemId",
        to_item_id AS "toItemId",
        mode,
        provider,
        distance_meters AS "distanceMeters",
        duration_seconds AS "durationSeconds",
        encoded_polyline AS "encodedPolyline",
        generated_at AS "generatedAt"
       FROM itinerary_route_legs
       WHERE trip_id = $1
       ORDER BY day_id ASC, from_item_id ASC`,
      [tripId]
    );

    return NextResponse.json({
      tripId,
      mode: modeFromLocalTravelMethod(trip.rows[0].localTravelMethod),
      routes: result.rows.map((row) => ({
        ...row,
        distanceKm: Math.round((Number(row.distanceMeters) / 1000) * 100) / 100,
        durationMinutes: minutes(Number(row.durationSeconds)),
      })),
    });
  } catch (error) {
    console.error("GET /api/trips/[id]/routes failed:", error);
    return NextResponse.json({ error: "Could not load trip routes." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  let body: { mode?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is allowed; the trip's local travel preference is used.
  }

  try {
    const trip = await db.query(
      `SELECT local_travel_method AS "localTravelMethod"
       FROM trips
       WHERE id = $1`,
      [tripId]
    );

    if (trip.rowCount === 0) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const fallbackMode = modeFromLocalTravelMethod(trip.rows[0].localTravelMethod);
    if (!fallbackMode) {
      return NextResponse.json(
        { error: "This trip has an unsupported local travel method." },
        { status: 400 }
      );
    }

    const mode = requestedMode(body.mode, fallbackMode);
    if (!mode) {
      return NextResponse.json({ error: "Invalid route mode." }, { status: 400 });
    }

    if (mode === "TRANSIT") {
      return NextResponse.json(
        { error: "Public-transit route management is not available with the current routing provider." },
        { status: 400 }
      );
    }

    const items = await loadTripItems(tripId);
    const legs: Array<{
      dayId: number;
      fromItemId: number;
      toItemId: number;
      fromPlace: string;
      toPlace: string;
      mode: TravelMode;
      provider: string;
      distanceMeters: number;
      durationSeconds: number;
      encodedPolyline?: string;
    }> = [];

    for (let index = 1; index < items.length; index += 1) {
      const from = items[index - 1];
      const to = items[index];

      if (from.dayId !== to.dayId) continue;

      const result = await getTravelProvider().computeRoute({
        origin: { latitude: from.latitude, longitude: from.longitude },
        destination: { latitude: to.latitude, longitude: to.longitude },
        mode,
      });

      legs.push({
        dayId: from.dayId,
        fromItemId: from.itemId,
        toItemId: to.itemId,
        fromPlace: from.name,
        toPlace: to.name,
        mode,
        provider: result.provider,
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds,
        encodedPolyline: result.encodedPolyline,
      });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM itinerary_route_legs WHERE trip_id = $1 AND mode = $2",
        [tripId, mode]
      );

      for (const leg of legs) {
        await client.query(
          `INSERT INTO itinerary_route_legs (
            trip_id, day_id, from_item_id, to_item_id, mode, provider,
            distance_meters, duration_seconds, encoded_polyline
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (from_item_id, to_item_id, mode)
          DO UPDATE SET
            provider = EXCLUDED.provider,
            distance_meters = EXCLUDED.distance_meters,
            duration_seconds = EXCLUDED.duration_seconds,
            encoded_polyline = EXCLUDED.encoded_polyline,
            generated_at = NOW()`,
          [
            tripId,
            leg.dayId,
            leg.fromItemId,
            leg.toItemId,
            leg.mode,
            leg.provider,
            leg.distanceMeters,
            leg.durationSeconds,
            leg.encodedPolyline ?? null,
          ]
        );
      }

      await client.query("UPDATE trips SET updated_at = NOW() WHERE id = $1", [tripId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return NextResponse.json({
      tripId,
      mode,
      routeCount: legs.length,
      routes: legs.map((leg) => ({
        ...leg,
        distanceKm: Math.round((leg.distanceMeters / 1000) * 100) / 100,
        durationMinutes: minutes(leg.durationSeconds),
      })),
    });
  } catch (error) {
    console.error("POST /api/trips/[id]/routes failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not calculate trip routes." },
      { status: 502 }
    );
  }
}
