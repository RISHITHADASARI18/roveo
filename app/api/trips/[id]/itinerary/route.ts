import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type ItineraryItemInput = {
  tripPlaceId?: unknown;
  position?: unknown;
  startTime?: unknown;
  durationMinutes?: unknown;
  travelTimeMinutes?: unknown;
};

type ItineraryDayInput = {
  dayNumber?: unknown;
  items?: unknown;
};

function positiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function tripExists(tripId: number) {
  const result = await db.query("SELECT 1 FROM trips WHERE id = $1", [tripId]);
  return result.rowCount === 1;
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
    if (!(await tripExists(tripId))) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const result = await db.query(
      `SELECT
        d.id AS "dayId",
        d.day_number AS "dayNumber",
        i.id AS "itemId",
        i.position,
        i.start_time AS "startTime",
        i.duration_minutes AS "durationMinutes",
        i.travel_time_minutes AS "travelTimeMinutes",
        p.id AS "tripPlaceId",
        p.name,
        p.latitude,
        p.longitude,
        p.category,
        p.description,
        p.photo_url AS "photoUrl",
        p.website_url AS "websiteUrl",
        p.address
       FROM itinerary_days d
       LEFT JOIN itinerary_items i ON i.day_id = d.id
       LEFT JOIN trip_places p ON p.id = i.trip_place_id
       WHERE d.trip_id = $1
       ORDER BY d.day_number ASC, i.position ASC`,
      [tripId]
    );

    const days = new Map<number, {
      dayId: string;
      dayNumber: number;
      items: unknown[];
    }>();

    for (const row of result.rows) {
      if (!days.has(row.dayNumber)) {
        days.set(row.dayNumber, {
          dayId: row.dayId,
          dayNumber: row.dayNumber,
          items: [],
        });
      }

      if (row.itemId !== null) {
        days.get(row.dayNumber)!.items.push({
          itemId: row.itemId,
          tripPlaceId: row.tripPlaceId,
          position: row.position,
          startTime: row.startTime,
          durationMinutes: row.durationMinutes,
          travelTimeMinutes: row.travelTimeMinutes,
          place: row.tripPlaceId
            ? {
                id: row.tripPlaceId,
                name: row.name,
                latitude: row.latitude,
                longitude: row.longitude,
                category: row.category,
                description: row.description,
                photoUrl: row.photoUrl,
                websiteUrl: row.websiteUrl,
                address: row.address,
              }
            : null,
        });
      }
    }

    return NextResponse.json({ days: Array.from(days.values()) });
  } catch (error) {
    console.error("GET /api/trips/[id]/itinerary failed:", error);
    return NextResponse.json(
      { error: "Could not load the saved itinerary." },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  let body: { days?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  if (!Array.isArray(body.days)) {
    return NextResponse.json({ error: "days must be an array." }, { status: 400 });
  }

  const days = body.days as ItineraryDayInput[];
  const normalizedDays = days.map((day) => ({
    dayNumber: positiveInteger(day.dayNumber),
    items: Array.isArray(day.items) ? day.items as ItineraryItemInput[] : null,
  }));

  if (normalizedDays.some((day) => !day.dayNumber || !day.items)) {
    return NextResponse.json(
      { error: "Each day needs a positive dayNumber and an items array." },
      { status: 400 }
    );
  }

  const dayNumbers = normalizedDays.map((day) => day.dayNumber as number);
  if (new Set(dayNumbers).size !== dayNumbers.length) {
    return NextResponse.json({ error: "Duplicate dayNumber values are not allowed." }, { status: 400 });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    if (!(await tripExists(tripId))) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    await client.query("DELETE FROM itinerary_days WHERE trip_id = $1", [tripId]);

    for (const day of normalizedDays) {
      const dayResult = await client.query(
        "INSERT INTO itinerary_days (trip_id, day_number) VALUES ($1, $2) RETURNING id",
        [tripId, day.dayNumber]
      );
      const dayId = dayResult.rows[0].id;

      const seenPositions = new Set<number>();

      for (const rawItem of day.items!) {
        const position = positiveInteger(rawItem.position);
        const tripPlaceId = positiveInteger(rawItem.tripPlaceId);
        const durationMinutes = rawItem.durationMinutes === undefined || rawItem.durationMinutes === null
          ? null
          : positiveInteger(rawItem.durationMinutes);
        const travelTimeMinutes = rawItem.travelTimeMinutes === undefined || rawItem.travelTimeMinutes === null
          ? null
          : nonNegativeInteger(rawItem.travelTimeMinutes);
        const startTime = text(rawItem.startTime) || null;

        if (!position || seenPositions.has(position)) {
          throw new Error("Each itinerary item needs a unique positive position within its day.");
        }
        seenPositions.add(position);

        if (!tripPlaceId) {
          throw new Error("Each itinerary item needs a valid tripPlaceId.");
        }

        const placeResult = await client.query(
          "SELECT 1 FROM trip_places WHERE id = $1 AND trip_id = $2",
          [tripPlaceId, tripId]
        );

        if (placeResult.rowCount === 0) {
          throw new Error("An itinerary place does not belong to this trip.");
        }

        await client.query(
          `INSERT INTO itinerary_items (
            day_id, trip_place_id, position,
            start_time, duration_minutes, travel_time_minutes
          )
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            dayId,
            tripPlaceId,
            position,
            startTime,
            durationMinutes,
            travelTimeMinutes,
          ]
        );
      }
    }

    await client.query(
      "UPDATE trips SET updated_at = NOW() WHERE id = $1",
      [tripId]
    );

    await client.query("COMMIT");
    return NextResponse.json({ saved: true, days: normalizedDays.length });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("PUT /api/trips/[id]/itinerary failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the itinerary." },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
