import { NextResponse } from "next/server";
import { discoverBroadPlaces } from "@/lib/travel/broad-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const destination = (url.searchParams.get("destination") ?? "").trim().slice(0, 160);
  const radiusKm = Number(url.searchParams.get("radiusKm") ?? "50");
  const maxResults = Number(url.searchParams.get("maxResults") ?? "200");

  if (!destination) return NextResponse.json({ error: "A destination is required." }, { status: 400 });
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    return NextResponse.json({ error: "radiusKm must be between 1 and 50." }, { status: 400 });
  }

  try {
    const result = await discoverBroadPlaces(
      destination,
      radiusKm * 1000,
      Number.isFinite(maxResults) ? Math.min(Math.max(Math.round(maxResults), 1), 250) : 200,
    );

    return NextResponse.json({ tripId: null, destination, ...result });
  } catch (error) {
    console.error("GET /api/places/discover failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not discover places." },
      { status: 502 },
    );
  }
}
