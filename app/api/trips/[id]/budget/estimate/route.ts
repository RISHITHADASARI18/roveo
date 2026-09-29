import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateBudget } from "@/lib/budget/calculate";

export const runtime = "nodejs";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  try {
    const result = await db.query(
      `SELECT id, trip_id AS "tripId",
        destination_travel AS "destinationTravel",
        accommodation,
        local_transport AS "localTransport",
        food,
        activities,
        other,
        contingency,
        total,
        currency,
        confidence,
        source,
        generated_at AS "generatedAt"
       FROM trip_cost_estimates
       WHERE trip_id = $1`,
      [tripId],
    );

    return NextResponse.json({ estimate: result.rows[0] ?? null });
  } catch (error) {
    console.error("GET budget estimate failed:", error);
    return NextResponse.json(
      { error: "Could not load the trip cost estimate." },
      { status: 500 },
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  try {
    const tripResult = await db.query(
      `SELECT days, people, budget,
        travel_method AS "travelMethod",
        local_travel_method AS "localTravelMethod",
        stay_preference AS "stayPreference"
       FROM trips
       WHERE id = $1`,
      [tripId],
    );

    const trip = tripResult.rows[0];
    if (!trip) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const calculation = calculateBudget({
      days: Number(trip.days),
      people: Number(trip.people),
      budget: Number(trip.budget),
      travelMethod: trip.travelMethod,
      localTravelMethod: trip.localTravelMethod,
      stayPreference: trip.stayPreference,
    });

    const saved = await db.query(
      `INSERT INTO trip_cost_estimates (
        trip_id,
        destination_travel,
        accommodation,
        local_transport,
        food,
        activities,
        other,
        contingency,
        total,
        currency,
        confidence,
        source,
        generated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (trip_id) DO UPDATE SET
        destination_travel = EXCLUDED.destination_travel,
        accommodation = EXCLUDED.accommodation,
        local_transport = EXCLUDED.local_transport,
        food = EXCLUDED.food,
        activities = EXCLUDED.activities,
        other = EXCLUDED.other,
        contingency = EXCLUDED.contingency,
        total = EXCLUDED.total,
        currency = EXCLUDED.currency,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        generated_at = NOW()
      RETURNING id,
        trip_id AS "tripId",
        destination_travel AS "destinationTravel",
        accommodation,
        local_transport AS "localTransport",
        food,
        activities,
        other,
        contingency,
        total,
        currency,
        confidence,
        source,
        generated_at AS "generatedAt"`,
      [
        tripId,
        calculation.items.destinationTravel,
        calculation.items.accommodation,
        calculation.items.localTransport,
        calculation.items.food,
        calculation.items.activities,
        calculation.items.other,
        calculation.items.contingency,
        calculation.total,
        calculation.currency,
        calculation.confidence,
        calculation.source,
      ],
    );

    await db.query(
      "UPDATE trips SET updated_at = NOW() WHERE id = $1",
      [tripId],
    );

    return NextResponse.json(
      { estimate: saved.rows[0], calculation },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST budget estimate failed:", error);
    return NextResponse.json(
      { error: "Could not generate the trip cost estimate." },
      { status: 500 },
    );
  }
}
