import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateBudget, type BudgetDestination, type BudgetPlace } from "@/lib/budget/calculate";
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
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

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
      `SELECT id, source, source_lat AS "sourceLatitude", source_lon AS "sourceLongitude",
        days, people, budget, destination, start_date AS "startDate",
        travel_method AS "travelMethod", local_travel_method AS "localTravelMethod",
        stay_preference AS "stayPreference"
       FROM trips WHERE id = $1`,
      [tripId],
    );
    const trip = tripResult.rows[0];
    if (!trip) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    let destinations: BudgetDestination[] = [];
    try {
      const destinationResult = await db.query(
        `SELECT destination_name AS name, latitude, longitude
           FROM trip_destinations WHERE trip_id = $1 ORDER BY order_index ASC`,
        [tripId],
      );
      destinations = destinationResult.rows.map((row) => ({
        name: String(row.name),
        latitude: row.latitude == null ? null : Number(row.latitude),
        longitude: row.longitude == null ? null : Number(row.longitude),
      }));
    } catch (error) {
      // Older installations may not have the multi-destination table yet.
      console.warn("Could not load trip destinations for budget; using the legacy destination.", error);
    }
    if (destinations.length === 0) {
      let latitude: number | null = null;
      let longitude: number | null = null;
      try {
        const legacy = await db.query(
          `SELECT destination_lat AS latitude, destination_lon AS longitude FROM trips WHERE id = $1`,
          [tripId],
        );
        if (legacy.rows[0]) {
          latitude = legacy.rows[0].latitude == null ? null : Number(legacy.rows[0].latitude);
          longitude = legacy.rows[0].longitude == null ? null : Number(legacy.rows[0].longitude);
        }
      } catch { /* coordinate columns may not exist on an older deployment */ }
      destinations = [{ name: String(trip.destination), latitude, longitude }];
    }

    let selectedPlaces: BudgetPlace[] = [];
    try {
      const placesResult = await db.query(
        `SELECT name, category FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC`,
        [tripId],
      );
      selectedPlaces = placesResult.rows.map((row) => ({
        name: String(row.name || ""),
        category: row.category == null ? null : String(row.category),
      }));
    } catch (error) {
      console.warn("Could not load saved places for budget; using the default activity allowance.", error);
    }

    const calculation = calculateBudget({
      days: Number(trip.days),
      people: Number(trip.people),
      budget: Number(trip.budget),
      source: String(trip.source || ""),
      sourceLatitude: trip.sourceLatitude == null ? null : Number(trip.sourceLatitude),
      sourceLongitude: trip.sourceLongitude == null ? null : Number(trip.sourceLongitude),
      destinations,
      destination: String(trip.destination || ""),
      travelMethod: String(trip.travelMethod || ""),
      localTravelMethod: String(trip.localTravelMethod || ""),
      stayPreference: String(trip.stayPreference || ""),
      selectedPlaces,
    });

    let accommodationSource = "roveo";
    let accommodationConfidence = "fallback";
    let liveStay: { name: string; totalPrice: number; currency: string; platform: string; url?: string } | null = null;

    if (process.env.STAYINGAPI_KEY && trip.startDate) {
      const checkIn = new Date(String(trip.startDate).slice(0, 10) + "T00:00:00Z");
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + Number(trip.days));
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      try {
        const stays = await searchStays({
          location: String(trip.destination),
          checkIn: iso(checkIn),
          checkOut: iso(checkOut),
          adults: Number(trip.people),
          stayPreference: String(trip.stayPreference || ""),
        });
        const validStays = stays.filter((stay) =>
          Number.isFinite(stay.totalPrice) && stay.totalPrice >= 0 && stay.currency === "INR"
        );
        if (validStays.length) {
          const sorted = [...validStays].sort((a, b) => a.totalPrice - b.totalPrice);
          const chosen = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
          liveStay = { name: chosen.name, totalPrice: chosen.totalPrice, currency: chosen.currency, platform: chosen.platform, url: chosen.url };
          calculation.items.accommodation = Math.round(chosen.totalPrice * 100) / 100;
          accommodationSource = "stayingapi";
          accommodationConfidence = "live";
          calculation.explanations.accommodation =
            `Live provider price for ${chosen.name} (${chosen.platform}) for the selected dates and party size. Verify room occupancy and cancellation terms before booking.`;
          calculation.assumptions.push("Accommodation uses a live INR provider result; availability and prices may change before booking.");
        }
      } catch (error) {
        console.error("Live accommodation estimate failed:", error);
      }
    }

    const coreKeys = ["destinationTravel", "accommodation", "localTransport", "food", "activities", "other"] as const;
    let subtotal = coreKeys.reduce((sum, key) => sum + calculation.items[key], 0);
    // Live accommodation prices can change the estimate after the base
    // calculation, so enforce the same hard budget ceiling again here.
    const budgetLimit = Math.max(0, Number(trip.budget) || 0);
    if (subtotal > budgetLimit) {
      const totalCents = Math.floor(budgetLimit * 100);
      const shares = coreKeys.map((key) => {
        const exactCents = calculation.items[key] / subtotal * totalCents;
        return { key, cents: Math.floor(exactCents), remainder: exactCents - Math.floor(exactCents) };
      });
      let centsLeft = totalCents - shares.reduce((sum, item) => sum + item.cents, 0);
      shares.sort((a, b) => b.remainder - a.remainder);
      for (let index = 0; centsLeft > 0; index = (index + 1) % shares.length) {
        shares[index].cents += 1;
        centsLeft -= 1;
      }
      for (const share of shares) calculation.items[share.key] = share.cents / 100;
      subtotal = coreKeys.reduce((sum, key) => sum + calculation.items[key], 0);
      calculation.assumptions.push("The raw estimate was above your budget, so category targets were fitted within your budget. Confirm actual prices and prioritize essentials before booking.");
    }
    // Keep contingency outside the stated budget; recommend a separate buffer
    // in the UI instead of making the plan exceed the user's amount.
    calculation.items.contingency = 0;
    calculation.subtotal = Math.round(subtotal * 100) / 100;
    calculation.total = Math.min(budgetLimit, Math.round(subtotal * 100) / 100);
    calculation.remaining = Math.max(0, Math.round((budgetLimit - calculation.total) * 100) / 100);

    const saved = await db.query(
      `INSERT INTO trip_cost_estimates (
        trip_id, destination_travel, accommodation, local_transport, food,
        activities, other, contingency, total, currency, confidence, source, generated_at
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
      RETURNING id, trip_id AS "tripId",
        destination_travel AS "destinationTravel", accommodation,
        local_transport AS "localTransport", food, activities, other, contingency,
        total, currency, confidence, source, generated_at AS "generatedAt"`,
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

    await db.query("UPDATE trips SET updated_at = NOW() WHERE id = $1", [tripId]);

    return NextResponse.json({
      estimate: saved.rows[0],
      calculation,
      liveStay,
      pricing: { accommodationSource, accommodationConfidence },
    }, { status: 201 });
  } catch (error) {
    console.error("POST budget estimate failed:", error);
    return NextResponse.json({ error: "Could not generate the trip cost estimate." }, { status: 500 });
  }
}
