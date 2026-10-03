import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 120) {
    return NextResponse.json({ locations: [] });
  }

  try {
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      addressdetails: "1",
      namedetails: "1",
      extratags: "1",
      limit: "6",
      "accept-language": "en",
    });
    const response = await fetch(NOMINATIM_URL + "?" + params, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Roveo/1.0 (travel planner; location search)",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json({ locations: [] }, { status: 502 });
    }

    const data = await response.json();
    const locations = (Array.isArray(data) ? data : [])
      .map((item: any) => {
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        const box = Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        return {
          id: String(item.osm_type ?? "place").charAt(0).toUpperCase() + String(item.osm_id ?? ""),
          name: String(
            item.namedetails?.name ??
            item.name ??
            item.display_name?.split(",")[0] ??
            q
          ).trim(),
          displayName: String(item.display_name ?? "").trim(),
          lat,
          lon,
          boundingBox:
            box.length === 4 && box.every((value: number) => Number.isFinite(value))
              ? { south: box[0], north: box[1], west: box[2], east: box[3] }
              : null,
          type: String(item.type ?? item.class ?? "place"),
          importance: Number(item.importance) || 0,
        };
      })
      .filter(Boolean);

    return NextResponse.json({ locations });
  } catch (error) {
    console.error("GET /api/geocode/search failed:", error);
    return NextResponse.json({ locations: [] }, { status: 502 });
  }
}
