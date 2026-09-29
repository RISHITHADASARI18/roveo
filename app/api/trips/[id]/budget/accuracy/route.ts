import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluateBudgetAccuracy } from "@/lib/budget/accuracy";

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
      `SELECT
        budget,
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
        source
       FROM trip_cost_estimates e
       JOIN trips t ON t.id = e.trip_id
       WHERE e.trip_id = $1`,
      [tripId],
    );

    const estimate = result.rows[0];
    if (!estimate) {
      return NextResponse.json(
        { error: "No stored estimate exists for this trip." },
        { status: 404 },
      );
    }

    const report = evaluateBudgetAccuracy({
      budget: Number(estimate.budget),
      total: Number(estimate.total),
      components: {
        destinationTravel: Number(estimate.destinationTravel),
        accommodation: Number(estimate.accommodation),
        localTransport: Number(estimate.localTransport),
        food: Number(estimate.food),
        activities: Number(estimate.activities),
        other: Number(estimate.other),
        contingency: Number(estimate.contingency),
      },
      currency: estimate.currency,
      confidence: estimate.confidence,
      source: estimate.source,
    });

    return NextResponse.json({
      tripId,
      estimate: {
        total: Number(estimate.total),
        budget: Number(estimate.budget),
        currency: estimate.currency,
        confidence: estimate.confidence,
        source: estimate.source,
      },
      accuracy: report,
    });
  } catch (error) {
    console.error("GET budget accuracy failed:", error);
    return NextResponse.json(
      { error: "Could not evaluate budget accuracy." },
      { status: 500 },
    );
  }
}
