import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateBudget } from "@/lib/budget/calculate";
import { searchStays } from "@/lib/accommodation/staying";

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

    let accommodationSource = "roveo";
    let accommodationConfidence = "fallback";
    let liveStay: { name:string; totalPrice:number; currency:string; platform:string; url?:string } | null = null;

    if (process.env.STAYINGAPI_KEY && trip.startDate) {
      const checkIn = new Date(String(trip.startDate) + "T00:00:00Z");
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + Number(trip.days));
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      try {
        const stays = await searchStays({
          location: trip.destination,
          checkIn: iso(checkIn),
          checkOut: iso(checkOut),
          adults: Number(trip.people),
          stayPreference: trip.stayPreference,
        });
        if (stays.length) {
          const sorted = [...stays].sort((a,b)=>a.totalPrice-b.totalPrice);
          const chosen = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
          liveStay = {name:chosen.name,totalPrice:chosen.totalPrice,currency:chosen.currency,platform:chosen.platform,url:chosen.url};
          if (chosen.currency === "INR") {
            calculation.items.accommodation = Number(chosen.totalPrice);
            accommodationSource = "stayingapi";
            accommodationConfidence = "live";
          }
        }
      } catch (error) {
        console.error("Live accommodation estimate failed:", error);
      }
    }

    const subtotal =
      calculation.items.destinationTravel +
      calculation.items.accommodation +
      calculation.items.localTransport +
      calculation.items.food +
      calculation.items.activities +
      calculation.items.other;
    calculation.items.contingency = Math.round(subtotal * 0.1 * 100) / 100;
    calculation.subtotal = Math.round(subtotal * 100) / 100;
    calculation.total = Math.round((subtotal + calculation.items.contingency) * 100) / 100;
    calculation.remaining = Math.round((calculation.budget - calculation.total) * 100) / 100;

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
