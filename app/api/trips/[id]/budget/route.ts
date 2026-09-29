import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const CATEGORIES = ["destinationTravel","accommodation","localTransport","food","activities","other","contingency"] as const;
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
    const result=await db.query(
      `SELECT
        destination_travel AS "destinationTravel",
        accommodation,
        local_transport AS "localTransport",
        food,
        activities,
        other,
        contingency
       FROM trip_budgets WHERE trip_id=$1`,[tripId]);
    if(!result.rows[0])return NextResponse.json({budget:null});
    return NextResponse.json({budget:buildBreakdown(result.rows[0])});
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
        updated_at=NOW()
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