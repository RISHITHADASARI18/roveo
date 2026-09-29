import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type TripInput = {
  source?: unknown;
  destination?: unknown;
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

  if (!source || !destination || !days || !people || budget === null || !travel || !localTravel || !stay) {
    return NextResponse.json(
      { error: "Source, destination, days, people, budget, travel, local travel and stay are required." },
      { status: 400 }
    );
  }

  try {
    const result = await db.query(
      `INSERT INTO trips (
        source, destination, days, people, budget,
        travel_method, local_travel_method, stay_preference
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id, source, destination, days, people, budget,
        travel_method AS "travel",
        local_travel_method AS "localTravel",
        stay_preference AS "stay",
        created_at AS "createdAt",
        updated_at AS "updatedAt"`,
      [source, destination, days, people, budget, travel, localTravel, stay]
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
