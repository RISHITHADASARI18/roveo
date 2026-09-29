import { NextResponse } from "next/server";
import { getTravelProvider } from "@/lib/travel";

export const runtime = "nodejs";

function validCoordinate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const provider = getTravelProvider();

    if (body.action === "route") {
      const { origin, destination, mode = "DRIVE" } = body;

      if (
        !origin ||
        !destination ||
        !validCoordinate(origin.latitude) ||
        !validCoordinate(origin.longitude) ||
        !validCoordinate(destination.latitude) ||
        !validCoordinate(destination.longitude)
      ) {
        return NextResponse.json(
          { error: "Route requires valid origin and destination coordinates." },
          { status: 400 },
        );
      }

      if (!["DRIVE", "WALK", "BICYCLE", "TRANSIT"].includes(mode)) {
        return NextResponse.json({ error: "Invalid travel mode." }, { status: 400 });
      }

      const result = await provider.computeRoute({
        origin,
        destination,
        mode,
      });

      return NextResponse.json({ result });
    }

    if (body.action === "places") {
      if (typeof body.textQuery !== "string" || !body.textQuery.trim()) {
        return NextResponse.json(
          { error: "places requires a textQuery." },
          { status: 400 },
        );
      }

      const result = await provider.searchPlaces({
        textQuery: body.textQuery.trim(),
        latitude: body.latitude,
        longitude: body.longitude,
        radiusMeters: body.radiusMeters,
        maxResults: body.maxResults,
      });

      return NextResponse.json({ result });
    }

    return NextResponse.json(
      { error: "Unsupported travel action. Use route or places." },
      { status: 400 },
    );
  } catch (error) {
    console.error("POST /api/travel failed:", error);

    const message =
      error instanceof Error ? error.message : "Travel provider request failed.";

    const status = message.includes("not configured") ? 503 : 502;

    return NextResponse.json({ error: message }, { status });
  }
}
