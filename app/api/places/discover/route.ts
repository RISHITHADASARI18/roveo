import { NextResponse } from "next/server";
import { discoverPlaces } from "@/lib/travel/open";
import { discoverBroadPlaces } from "@/lib/travel/broad-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const destination = (url.searchParams.get("destination") ?? "").trim().slice(0, 160);
  const maxResults = Number(url.searchParams.get("maxResults") ?? "200");
  const desiredQuery = (url.searchParams.get("q") ?? "").trim().slice(0, 120);

  if (!destination) return NextResponse.json({ error: "A destination is required." }, { status: 400 });
  try {
    const result = desiredQuery
      ? await discoverBroadPlaces(destination, 0, Math.min(Math.max(Math.round(maxResults), 1), 1000), desiredQuery)
      : await discoverBroadPlaces(destination, 0, Math.min(Math.max(Math.round(maxResults), 1), 1000));

    return NextResponse.json({ tripId: null, destination, ...result });
  } catch (error) {
    console.error("GET /api/places/discover failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not discover places." }, { status: 502 });
  }
}
