import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type LocationInput = {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  boundingBox?: { south?: unknown; north?: unknown; west?: unknown; east?: unknown } | null;
};

type TripInput = {
  source?: LocationInput | unknown;
  destination?: LocationInput | unknown;
  days?: unknown;
  people?: unknown;
  budget?: unknown;
  travel?: unknown;
  localTravel?: unknown;
  stay?: unknown;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function location(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as LocationInput;
  const name = text(item.name);
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  const box = item.boundingBox;
  const south = Number(box?.south);
  const north = Number(box?.north);
  const west = Number(box?.west);
  const east = Number(box?.east);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    name,
    lat,
    lon,
    south: Number.isFinite(south) ? south : null,
    north: Number.isFinite(north) ? north : null,
    west: Number.isFinite(west) ? west : null,
    east: Number.isFinite(east) ? east : null,
  };
}

function positiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function GET() {
  try {
    const result = await db.query(
      `SELECT
        id, source, destination, days, people, budget,
        travel_method AS "travel",
        local_travel_method AS "localTravel",
        stay_preference AS "stay",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM trips
       ORDER BY created_at DESC
       LIMIT 50`
    );
    return NextResponse.json({ trips: result.rows });
  } catch (error) {
    console.error("GET /api/trips failed:", error);
    return NextResponse.json(
      { error: "Database is not available. Check DATABASE_URL and run db/schema.sql." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let body: TripInput;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const source = text(body.source);
  const destination = text(body.destination);
  const days = positiveInteger(body.days);
  const people = positiveInteger(body.people);
  const budget = nonNegativeNumber(body.budget);
  const travel = text(body.travel);
  const localTravel = text(body.localTravel);
  const stay = text(body.stay);

  if (!sourceLocation || !destinationLocation || !days || !people || budget === null || !travel || !localTravel || !stay) {
    return NextResponse.json(
      { error: "Source, destination, days, people, budget, travel, local travel and stay are required." },
      { status: 400 }
    );
  }

  try {
    await db.query(`
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lat DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lon DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lon DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_south DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_north DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_west DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_east DOUBLE PRECISION;
    `);

    const result = await db.query(
      `INSERT INTO trips (
        source, destination, days, people, budget,
        travel_method, local_travel_method, stay_preference,
        source_lat, source_lon, destination_lat, destination_lon,
        destination_south, destination_north, destination_west, destination_east
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING
        id, source, destination, days, people, budget,
        travel_method AS "travel",
        local_travel_method AS "localTravel",
        stay_preference AS "stay",
        source_lat AS "sourceLat",
        source_lon AS "sourceLon",
        destination_lat AS "destinationLat",
        destination_lon AS "destinationLon",
        created_at AS "createdAt",
        updated_at AS "updatedAt"`,
      [
        source, destination, days, people, budget, travel, localTravel, stay,
        sourceLocation.lat, sourceLocation.lon,
        destinationLocation.lat, destinationLocation.lon,
        destinationLocation.south, destinationLocation.north,
        destinationLocation.west, destinationLocation.east
      ]
    );

    return NextResponse.json({ trip: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error("POST /api/trips failed:", error);
    return NextResponse.json(
      { error: "Could not save the trip. Make sure PostgreSQL is configured and the trips table exists." },
      { status: 500 }
    );
  }
}
