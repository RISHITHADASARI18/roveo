import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { estimatePlaceCosts } from "@/lib/budget/place-costs";

export const runtime = "nodejs";

const CATEGORIES = ["destinationTravel","accommodation","localTransport","food","activities","other","contingency"] as const;

let accommodationPropertyColumnReady: Promise<void> | null = null;
async function ensureAccommodationPropertyColumn() {
  if (!accommodationPropertyColumnReady) {
    accommodationPropertyColumnReady = Promise.all([
      db.query("ALTER TABLE trip_cost_estimates ADD COLUMN IF NOT EXISTS accommodation_property JSONB"),
      db.query("ALTER TABLE trip_budgets ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE"),
    ]).then(() => undefined).catch((error) => { accommodationPropertyColumnReady = null; throw error; });
  }
  return accommodationPropertyColumnReady;
}
type Category = typeof CATEGORIES[number];

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function number(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function buildBreakdown(row:any) {
  const items = CATEGORIES.map(category => ({
    category,
    amount: Number(row[category] || 0),
  }));
  const subtotal = items.filter(x=>x.category!=="contingency").reduce((s,x)=>s+x.amount,0);
  const contingency = Number(row.contingency || 0);
  const total = subtotal + contingency;
  return { items, subtotal, contingency, total };
}

export async function GET(_request: Request,{params}:{params:Promise<{id:string}>}) {
  const tripId=tripIdFromParams(await params);
  if(!tripId)return NextResponse.json({error:"Invalid trip id."},{status:400});
  try {
    await ensureAccommodationPropertyColumn();
    const result=await db.query(
      `SELECT
        destination_travel AS "destinationTravel",
        accommodation,
        local_transport AS "localTransport",
        food,
        activities,
        other,
        contingency,
        updated_at AS "updatedAt",
        is_manual AS "isManual"
       FROM trip_budgets WHERE trip_id=$1`,[tripId]);
    // Estimates are also persisted in trip_cost_estimates. If a trip has an
    // estimate but no manually saved budget row yet, use that as the initial
    // budget instead of returning an empty state.
        const estimateResult = await db.query(
      `SELECT destination_travel AS "destinationTravel", accommodation,
        local_transport AS "localTransport", food, activities, other, contingency,
        confidence AS "estimateConfidence", source AS "estimateSource",
        accommodation_property AS "accommodationProperty",
        generated_at AS "generatedAt"
       FROM trip_cost_estimates WHERE trip_id=$1`, [tripId]);
        const trip = await db.query("SELECT people FROM trips WHERE id = $1", [tripId]);
    const places = await db.query(
      "SELECT name, category FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC",
      [tripId],
    );
    if (!trip.rows[0]) return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    const people = Number(trip.rows[0]?.people ?? 1);
    const placeCosts = estimatePlaceCosts(
      places.rows.map((place) => ({ name: String(place.name), category: place.category == null ? null : String(place.category) })),
      people,
    );
    const provisionalUnpricedAllowance = placeCosts.unpricedPlaceCount * 250 * people;
    // Older versions could leave a stale/default trip_budgets row beside a newer
    // generated estimate. Pick the record most recently updated so the page does
    // not display zeroes or outdated values just because a budget row exists.
    const savedBudget = result.rows[0] ?? null;
    const generatedEstimate = estimateResult.rows[0] ?? null;
    // Compare timestamps inside PostgreSQL. Converting timestamptz values to
    // JavaScript Date truncates sub-millisecond precision; two writes made
    // close together can otherwise look equal and cause an older estimate to
    // overwrite a newer manual edit after refresh.
    const recencyResult = savedBudget && generatedEstimate
      ? await db.query(
          `SELECT (b.updated_at >= e.generated_at) AS "budgetIsNewer"
             FROM trip_budgets b
             JOIN trip_cost_estimates e ON e.trip_id = b.trip_id
            WHERE b.trip_id = $1`,
          [tripId],
        )
      : null;
    const budgetIsNewer = Boolean(recencyResult?.rows[0]?.budgetIsNewer);
    const initialBudget = savedBudget && (savedBudget.isManual || !generatedEstimate || budgetIsNewer)
      ? savedBudget
      : generatedEstimate;
    const tripDetails = { days: Number(trip.rows[0].days), people, budget: Number(trip.rows[0].budget), source: String(trip.rows[0].source ?? ""), destination: String(trip.rows[0].destination ?? "") };
    if(!initialBudget)return NextResponse.json({budget:null, trip: tripDetails, placeCosts: { ...placeCosts, provisionalUnpricedAllowance }});
    return NextResponse.json({
      budget:buildBreakdown(initialBudget),
      trip: tripDetails,
      placeCosts: { ...placeCosts, provisionalUnpricedAllowance },
      accommodationProperty: estimateResult.rows[0]?.accommodationProperty ?? null,
      initializedFromEstimate:!result.rows[0] && Boolean(estimateResult.rows[0]),
      accommodationStatus: (() => {
        const confidence = String(estimateResult.rows[0]?.estimateConfidence ?? "");
        if (confidence === "provider-listed-price-not-confirmed") return "provider-listed-price-not-confirmed";
        if (confidence === "estimate-no-priced-results") return "estimate-no-priced-results";
        if (confidence === "estimate-no-overnight-stay") return "estimate-no-overnight-stay";
        if (confidence === "estimate-invalid-stay-dates") return "estimate-invalid-stay-dates";
        if (confidence === "estimate-unsupported-currency") return "estimate-unsupported-currency";
        if (confidence === "estimate-provider-not-configured") return "estimate-provider-not-configured";
        return "estimated";
      })(),
    });
  } catch(error) {
    console.error("GET /api/trips/[id]/budget failed:",error);
    return NextResponse.json({error:"Could not load the trip budget."},{status:500});
  }
}

export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}) {
  const tripId=tripIdFromParams(await params);
  if(!tripId)return NextResponse.json({error:"Invalid trip id."},{status:400});
  let body:any;
  try{body=await request.json();}catch{return NextResponse.json({error:"Invalid JSON request body."},{status:400});}
  const values=CATEGORIES.map(c=>number(body[c]));
  if(values.some(v=>v===null))return NextResponse.json({error:"All budget amounts must be non-negative numbers."},{status:400});
  try {
    const trip=await db.query("SELECT budget FROM trips WHERE id=$1",[tripId]);
    if(!trip.rows[0])return NextResponse.json({error:"Trip not found."},{status:404});
    const result=await db.query(
      `INSERT INTO trip_budgets
       (trip_id,destination_travel,accommodation,local_transport,food,activities,other,contingency)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(trip_id) DO UPDATE SET
        destination_travel=EXCLUDED.destination_travel,
        accommodation=EXCLUDED.accommodation,
        local_transport=EXCLUDED.local_transport,
        food=EXCLUDED.food,
        activities=EXCLUDED.activities,
        other=EXCLUDED.other,
        contingency=EXCLUDED.contingency,
        updated_at=NOW(),
        is_manual=TRUE
       RETURNING destination_travel AS "destinationTravel",accommodation,
        local_transport AS "localTransport",food,activities,other,contingency`,
      [tripId,...values]);
    const budget=buildBreakdown(result.rows[0]);
    await db.query("UPDATE trips SET updated_at=NOW() WHERE id=$1",[tripId]);
    return NextResponse.json({budget});
  } catch(error) {
    console.error("PUT /api/trips/[id]/budget failed:",error);
    return NextResponse.json({error:"Could not save the trip budget."},{status:500});
  }
}