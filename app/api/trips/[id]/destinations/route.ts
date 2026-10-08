import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

function tripIdFromParams(params: Promise<{ id: string }>) {
  return params.then((value) => {
    const id = Number(value.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  });
}

function parseLocation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    name?: unknown; lat?: unknown; lon?: unknown;
    boundingBox?: { south?: unknown; north?: unknown; west?: unknown; east?: unknown } | null;
  };
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const box = item.boundingBox;
  const numberOrNull = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return {
    name, lat, lon,
    south: numberOrNull(box?.south),
    north: numberOrNull(box?.north),
    west: numberOrNull(box?.west),
    east: numberOrNull(box?.east),
  };
}

async function syncLegacyDestination(tripId: number) {
  const first = await db.query(
    `SELECT destination_name, latitude, longitude,
            bounding_south, bounding_north, bounding_west, bounding_east
       FROM trip_destinations
      WHERE trip_id = $1
      ORDER BY order_index
      LIMIT 1`,
    [tripId]
  );
  if (!first.rows[0]) return;
  const item = first.rows[0];
  await db.query(
    `UPDATE trips
        SET destination = $2,
            destination_lat = $3,
            destination_lon = $4,
            destination_south = $5,
            destination_north = $6,
            destination_west = $7,
            destination_east = $8,
            updated_at = NOW()
      WHERE id = $1`,
    [
      tripId, item.destination_name, item.latitude, item.longitude,
      item.bounding_south, item.bounding_north, item.bounding_west, item.bounding_east
    ]
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = await tripIdFromParams(params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  try {
    const result = await db.query(
      `SELECT
        id, destination_name AS name, latitude AS lat, longitude AS lon,
        bounding_south AS south, bounding_north AS north,
        bounding_west AS west, bounding_east AS east,
        order_index AS "order", days
       FROM trip_destinations
       WHERE trip_id = $1
       ORDER BY order_index`,
      [tripId]
    );
    return NextResponse.json({ destinations: result.rows });
  } catch (error) {
    console.error("GET trip destinations failed:", error);
    return NextResponse.json({ error: "Could not load destinations." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = await tripIdFromParams(params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  let body: { destination?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const destination = parseLocation(body.destination);
  if (!destination) return NextResponse.json({ error: "A valid destination is required." }, { status: 400 });

  try {
    const existing = await db.query(
      `SELECT id FROM trip_destinations WHERE trip_id = $1 AND LOWER(destination_name) = LOWER($2) LIMIT 1`,
      [tripId, destination.name]
    );
    if (existing.rows[0]) return NextResponse.json({ error: "That destination is already in the trip." }, { status: 409 });

    const maxResult = await db.query(
      `SELECT COALESCE(MAX(order_index), 0) AS max_order FROM trip_destinations WHERE trip_id = $1`,
      [tripId]
    );
    const order = Number(maxResult.rows[0].max_order) + 1;

    const result = await db.query(
      `INSERT INTO trip_destinations (
        trip_id, destination_name, latitude, longitude,
        bounding_south, bounding_north, bounding_west, bounding_east, order_index
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, destination_name AS name, latitude AS lat, longitude AS lon,
                bounding_south AS south, bounding_north AS north,
                bounding_west AS west, bounding_east AS east,
                order_index AS "order", days`,
      [tripId, destination.name, destination.lat, destination.lon, destination.south, destination.north, destination.west, destination.east, order]
    );
    return NextResponse.json({ destination: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error("POST trip destination failed:", error);
    return NextResponse.json({ error: "Could not add destination." }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = await tripIdFromParams(params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  const id = Number(new URL(request.url).searchParams.get("destinationId"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid destinationId is required." }, { status: 400 });
  }

  try {
    const count = await db.query(`SELECT COUNT(*)::int AS count FROM trip_destinations WHERE trip_id = $1`, [tripId]);
    if (Number(count.rows[0].count) <= 1) {
      return NextResponse.json({ error: "A trip must keep at least one destination." }, { status: 400 });
    }

    const deleted = await db.query(
      `DELETE FROM trip_destinations WHERE id = $1 AND trip_id = $2 RETURNING id`,
      [id, tripId]
    );
    if (!deleted.rows[0]) return NextResponse.json({ error: "Destination not found." }, { status: 404 });

    await db.query(
      `UPDATE trip_destinations
          SET order_index = order_index - 1, updated_at = NOW()
        WHERE trip_id = $1 AND order_index > (
          SELECT COALESCE(MAX(order_index), 1) FROM trip_destinations WHERE trip_id = $1
        )`,
      [tripId]
    );

    // Re-number every remaining destination safely and keep the legacy first destination in sync.
    const remaining = await db.query(
      `SELECT id FROM trip_destinations WHERE trip_id = $1 ORDER BY order_index, id`,
      [tripId]
    );
    await db.query(`UPDATE trip_destinations SET order_index = order_index + 1000 WHERE trip_id = $1`, [tripId]);
    for (let index = 0; index < remaining.rows.length; index += 1) {
      await db.query(
        `UPDATE trip_destinations SET order_index = $2, updated_at = NOW() WHERE id = $1`,
        [remaining.rows[index].id, index + 1]
      );
    }
    await syncLegacyDestination(tripId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE trip destination failed:", error);
    return NextResponse.json({ error: "Could not remove destination." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = await tripIdFromParams(params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  let body: { destinationIds?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const destinationIds = Array.isArray(body.destinationIds)
    ? body.destinationIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  try {
    const current = await db.query(
      `SELECT id FROM trip_destinations WHERE trip_id = $1 ORDER BY order_index`,
      [tripId]
    );
    const currentIds = current.rows.map((row) => Number(row.id));
    if (destinationIds.length !== currentIds.length || new Set(destinationIds).size !== currentIds.length ||
        currentIds.some((id) => !destinationIds.includes(id))) {
      return NextResponse.json({ error: "destinationIds must contain every trip destination exactly once." }, { status: 400 });
    }

    await db.query(`UPDATE trip_destinations SET order_index = order_index + 1000 WHERE trip_id = $1`, [tripId]);
    for (let index = 0; index < destinationIds.length; index += 1) {
      await db.query(
        `UPDATE trip_destinations SET order_index = $2, updated_at = NOW() WHERE id = $1 AND trip_id = $3`,
        [destinationIds[index], index + 1, tripId]
      );
    }
    await syncLegacyDestination(tripId);

    const result = await db.query(
      `SELECT id, destination_name AS name, latitude AS lat, longitude AS lon,
              order_index AS "order", days
         FROM trip_destinations
        WHERE trip_id = $1
        ORDER BY order_index`,
      [tripId]
    );
    return NextResponse.json({ destinations: result.rows });
  } catch (error) {
    console.error("PATCH trip destinations failed:", error);
    return NextResponse.json({ error: "Could not reorder destinations." }, { status: 500 });
  }
}
