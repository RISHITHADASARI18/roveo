import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type PlaceInput = {
  provider?: unknown;
  providerPlaceId?: unknown;
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  category?: unknown;
  description?: unknown;
  photoUrl?: unknown;
  websiteUrl?: unknown;
  address?: unknown;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
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
        id,
        provider,
        provider_place_id AS "providerPlaceId",
        name,
        latitude,
        longitude,
        category,
        description,
        photo_url AS "photoUrl",
        website_url AS "websiteUrl",
        address,
        created_at AS "createdAt"
       FROM trip_places
       WHERE trip_id = $1
       ORDER BY created_at ASC, id ASC`,
      [tripId]
    );

    return NextResponse.json({ places: result.rows });
  } catch (error) {
    console.error("GET /api/trips/[id]/places failed:", error);
    return NextResponse.json(
      { error: "Could not load saved places." },
      { status: 500 }
    );
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

  let body: PlaceInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const provider = text(body.provider) || "openstreetmap";
  const providerPlaceId = text(body.providerPlaceId) || null;
  const name = text(body.name);
  const latitude = finiteNumber(body.latitude);
  const longitude = finiteNumber(body.longitude);
  const category = text(body.category) || null;
  const description = text(body.description) || null;
  const photoUrl = text(body.photoUrl) || null;
  const websiteUrl = text(body.websiteUrl) || null;
  const address = text(body.address) || null;

  if (!name || latitude === null || longitude === null) {
    return NextResponse.json(
      { error: "Name, latitude and longitude are required." },
      { status: 400 }
    );
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return NextResponse.json({ error: "Invalid latitude or longitude." }, { status: 400 });
  }

  try {
    if (!(await tripExists(tripId))) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const result = await db.query(
      `INSERT INTO trip_places (
        trip_id, provider, provider_place_id, name,
        latitude, longitude, category, description,
        photo_url, website_url, address
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (trip_id, provider_place_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        category = EXCLUDED.category,
        description = EXCLUDED.description,
        photo_url = EXCLUDED.photo_url,
        website_url = EXCLUDED.website_url,
        address = EXCLUDED.address
      RETURNING
        id,
        provider,
        provider_place_id AS "providerPlaceId",
        name,
        latitude,
        longitude,
        category,
        description,
        photo_url AS "photoUrl",
        website_url AS "websiteUrl",
        address,
        created_at AS "createdAt"`,
      [
        tripId, provider, providerPlaceId, name,
        latitude, longitude, category, description,
        photoUrl, websiteUrl, address
      ]
    );

    return NextResponse.json({ place: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error("POST /api/trips/[id]/places failed:", error);
    return NextResponse.json(
      { error: "Could not save the place." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  const placeId = Number(new URL(request.url).searchParams.get("placeId"));
  if (!Number.isInteger(placeId) || placeId <= 0) {
    return NextResponse.json({ error: "A valid placeId is required." }, { status: 400 });
  }

  try {
    const result = await db.query(
      "DELETE FROM trip_places WHERE id = $1 AND trip_id = $2 RETURNING id",
      [placeId, tripId]
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: "Saved place not found." }, { status: 404 });
    }

    return NextResponse.json({ deleted: true, placeId });
  } catch (error) {
    console.error("DELETE /api/trips/[id]/places failed:", error);
    return NextResponse.json(
      { error: "Could not delete the saved place." },
      { status: 500 }
    );
  }
}
