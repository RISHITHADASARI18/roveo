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
  destinations?: unknown;
  days?: unknown;
  people?: unknown;
  budget?: unknown;
  travel?: unknown;
  localTravel?: unknown;
  stay?: unknown;
  startDate?: unknown;
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

function parseDestinations(value: unknown, fallback: LocationInput | unknown) {
  const raw = Array.isArray(value) ? value : [fallback];
  const parsed = raw.map(location).filter((item): item is NonNullable<ReturnType<typeof location>> => Boolean(item));
  const unique = parsed.filter((item, index, items) =>
    items.findIndex((candidate) => candidate.name.toLowerCase() === item.name.toLowerCase()) === index
  );
  return unique;
}

async function ensureTripDestinationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_destinations (
      id BIGSERIAL PRIMARY KEY,
      trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      destination_name TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      bounding_south DOUBLE PRECISION,
      bounding_north DOUBLE PRECISION,
      bounding_west DOUBLE PRECISION,
      bounding_east DOUBLE PRECISION,
      order_index INTEGER NOT NULL CHECK (order_index > 0),
      days INTEGER CHECK (days IS NULL OR days > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (trip_id, order_index),
      UNIQUE (trip_id, destination_name)
    );
    CREATE INDEX IF NOT EXISTS trip_destinations_trip_id_idx
      ON trip_destinations (trip_id, order_index);
  `);
}

export async function GET() {
  try {
    await ensureTripDestinationsTable();
    const result = await db.query(`
      SELECT
        t.id, t.source, t.destination, t.days, t.people, t.budget,
        t.travel_method AS "travel",
        t.local_travel_method AS "localTravel",
        t.stay_preference AS "stay",
        t.start_date AS "startDate",
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",
        COALESCE(
          json_agg(
            json_build_object(
              'id', td.id,
              'name', td.destination_name,
              'lat', td.latitude,
              'lon', td.longitude,
              'boundingBox', json_build_object(
                'south', td.bounding_south,
                'north', td.bounding_north,
                'west', td.bounding_west,
                'east', td.bounding_east
              ),
              'order', td.order_index,
              'days', td.days
            ) ORDER BY td.order_index
          ) FILTER (WHERE td.id IS NOT NULL),
          '[]'::json
        ) AS destinations
      FROM trips t
      LEFT JOIN trip_destinations td ON td.trip_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT 50
    `);
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

  const sourceLocation = location(body.source);
  const destinations = parseDestinations(body.destinations, body.destination);
  const firstDestination = destinations[0] ?? null;
  const days = positiveInteger(body.days);
  const people = positiveInteger(body.people);
  const budget = nonNegativeNumber(body.budget);
  const travel = text(body.travel);
  const localTravel = text(body.localTravel);
  const stay = text(body.stay);
  const startDate = text(body.startDate) || null;

  if (!sourceLocation || destinations.length === 0 || !days || !people || budget === null || !travel || !localTravel || !stay) {
    return NextResponse.json(
      { error: "Source, at least one destination, days, people, budget, travel, local travel and stay are required." },
      { status: 400 }
    );
  }

  try {
    await db.query(`
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_date DATE;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lat DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lon DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lon DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_south DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_north DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_west DOUBLE PRECISION;
      ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_east DOUBLE PRECISION;
    `);
    await ensureTripDestinationsTable();

    const result = await db.query(
      `INSERT INTO trips (
        source, destination, days, people, budget,
        travel_method, local_travel_method, stay_preference, start_date,
        source_lat, source_lon, destination_lat, destination_lon,
        destination_south, destination_north, destination_west, destination_east
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING
        id, source, destination, days, people, budget,
        travel_method AS "travel",
        local_travel_method AS "localTravel",
        stay_preference AS "stay",
        start_date AS "startDate",
        source_lat AS "sourceLat",
        source_lon AS "sourceLon",
        destination_lat AS "destinationLat",
        destination_lon AS "destinationLon",
        created_at AS "createdAt",
        updated_at AS "updatedAt"`,
      [
        sourceLocation.name, firstDestination.name, days, people, budget, travel, localTravel, stay, startDate,
        sourceLocation.lat, sourceLocation.lon,
        firstDestination.lat, firstDestination.lon,
        firstDestination.south, firstDestination.north,
        firstDestination.west, firstDestination.east
      ]
    );

    const trip = result.rows[0];

    for (let index = 0; index < destinations.length; index += 1) {
      const item = destinations[index];
      await db.query(
        `INSERT INTO trip_destinations (
          trip_id, destination_name, latitude, longitude,
          bounding_south, bounding_north, bounding_west, bounding_east,
          order_index, days
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [
          trip.id, item.name, item.lat, item.lon,
          item.south, item.north, item.west, item.east,
          index + 1
        ]
      );
    }

    const savedDestinations = await db.query(
      `SELECT
        id, destination_name AS name, latitude AS lat, longitude AS lon,
        bounding_south AS south, bounding_north AS north,
        bounding_west AS west, bounding_east AS east,
        order_index AS "order", days
       FROM trip_destinations
       WHERE trip_id = $1
       ORDER BY order_index`,
      [trip.id]
    );

    return NextResponse.json(
      { trip: { ...trip, destinations: savedDestinations.rows } },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/trips failed:", error);
    return NextResponse.json(
      { error: "Could not save the trip. Make sure PostgreSQL is configured and the trips table exists." },
      { status: 500 }
    );
  }
}
