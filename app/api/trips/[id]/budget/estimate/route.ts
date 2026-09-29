import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function estimateDestinationTravel(method: string, people: number) {
  const m = method.toLowerCase();
  const perPerson = m.includes("flight") ? 6500 : m.includes("train") ? 1600 : m.includes("bus") ? 1200 : 2200;
  return perPerson * people;
}

function estimateAccommodation(stay: string, days: number, people: number) {
  const nights = Math.max(0, days - 1);
  const s = stay.toLowerCase();
  const roomPerNight = s.includes("hostel") ? 700 : s.includes("homestay") ? 1800 : s.includes("other") ? 1500 : 2500;
  return roomPerNight * Math.max(1, Math.ceil(people / 2)) * nights;
}

function estimateLocalTransport(method: string, days: number) {
  const m = method.toLowerCase();
  const daily = m.includes("walking") ? 100 : m.includes("public") ? 350 : m.includes("bike") ? 600 : m.includes("taxi") ? 1200 : 900;
  return daily * days;
}

function buildEstimate(trip: any) {
  const destinationTravel = estimateDestinationTravel(trip.travelMethod, trip.people);
  const accommodation = estimateAccommodation(trip.stayPreference, trip.days, trip.people);
  const localTransport = estimateLocalTransport(trip.localTravelMethod, trip.days);
  const food = 900 * trip.days * trip.people;
  const activities = 500 * Math.max(1, Math.min(trip.days, 5)) * trip.people;
  const other = 0;
  const subtotal = destinationTravel + accommodation + localTransport + food + activities + other;
  const contingency = round(subtotal * 0.10);
  const total = round(subtotal + contingency);

  return {
    items: {
      destinationTravel: round(destinationTravel),
      accommodation: round(accommodation),
      localTransport: round(localTransport),
      food: round(food),
      activities: round(activities),
      other,
      contingency,
    },
    subtotal: round(subtotal),
    contingency,
    total,
    budget: trip.budget,
    remaining: round(trip.budget - total),
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
    note: "Fallback estimates only. Live route, hotel and transport providers will replace these values in the next backend stage.",
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  try {
    const result = await db.query(
      `SELECT id, trip_id AS "tripId", destination_travel AS "destinationTravel", accommodation,
        local_transport AS "localTransport", food, activities, other, contingency, total,
        currency, confidence, source, generated_at AS "generatedAt"
       FROM trip_cost_estimates WHERE trip_id = $1`,
      [tripId],
    );
    return NextResponse.json({ estimate: result.rows[0] ?? null });
  } catch (error) {
    console.error("GET budget estimate failed:", error);
    return NextResponse.json({ error: "Could not load the trip cost estimate." }, { status: 500 });
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  try {
    const tripResult = await db.query(
      `SELECT days, people, budget,
        travel_method AS "travelMethod",
        local_travel_method AS "localTravelMethod",
        stay_preference AS "stayPreference"
       FROM trips WHERE id = $1`,
      [tripId],
    );

    const trip = tripResult.rows[0];
    if (!trip) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    trip.days = Number(trip.days);
    trip.people = Number(trip.people);
    trip.budget = Number(trip.budget);

    const estimate = buildEstimate(trip);

    const saved = await db.query(
      `INSERT INTO trip_cost_estimates (
        trip_id, destination_travel, accommodation, local_transport, food,
        activities, other, contingency, total, currency, confidence, source, generated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (trip_id) DO UPDATE SET
        destination_travel=EXCLUDED.destination_travel,
        accommodation=EXCLUDED.accommodation,
        local_transport=EXCLUDED.local_transport,
        food=EXCLUDED.food,
        activities=EXCLUDED.activities,
        other=EXCLUDED.other,
        contingency=EXCLUDED.contingency,
        total=EXCLUDED.total,
        currency=EXCLUDED.currency,
        confidence=EXCLUDED.confidence,
        source=EXCLUDED.source,
        generated_at=NOW()
      RETURNING id, trip_id AS "tripId", destination_travel AS "destinationTravel",
        accommodation, local_transport AS "localTransport", food, activities, other,
        contingency, total, currency, confidence, source, generated_at AS "generatedAt"`,
      [
        tripId,
        estimate.items.destinationTravel,
        estimate.items.accommodation,
        estimate.items.localTransport,
        estimate.items.food,
        estimate.items.activities,
        estimate.items.other,
        estimate.items.contingency,
        estimate.total,
        estimate.currency,
        estimate.confidence,
        estimate.source,
      ],
    );

    await db.query("UPDATE trips SET updated_at = NOW() WHERE id = $1", [tripId]);

    return NextResponse.json(
      { estimate: saved.rows[0], calculation: estimate },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST budget estimate failed:", error);
    return NextResponse.json({ error: "Could not generate the trip cost estimate." }, { status: 500 });
  }
}
