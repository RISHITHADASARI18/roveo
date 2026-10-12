import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildSmartItinerary } from "@/lib/travel/itinerary";
import type { PlannerPlace } from "@/lib/travel/itinerary-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TripDestination = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  order: number;
};

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const p = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * p;
  const dLon = (b.longitude - a.longitude) * p;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * p) * Math.cos(b.latitude * p) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function allocateDays(totalDays: number, destinationCount: number) {
  const allocations = Array.from({ length: destinationCount }, () => 0);
  if (!destinationCount || !totalDays) return allocations;

  // If there are enough days, give every destination at least one day before
  // spreading the remaining days in the user's chosen route order.
  if (totalDays >= destinationCount) {
    allocations.fill(1);
    for (let extra = totalDays - destinationCount, index = 0; extra > 0; extra -= 1, index += 1) {
      allocations[index % destinationCount] += 1;
    }
    return allocations;
  }

  // A short trip can contain more stops than days. Keep every destination
  // represented by grouping consecutive route stops into the available days.
  for (let index = 0; index < destinationCount; index += 1) {
    allocations[index % totalDays] += 1;
  }
  return allocations;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });

  let body: { days?: unknown } = {};
  try { body = await request.json(); } catch {}

  try {
    const trip = await db.query("SELECT days FROM trips WHERE id = $1", [tripId]);
    if (trip.rowCount === 0) return NextResponse.json({ error: "Trip not found." }, { status: 404 });

    await db.query("ALTER TABLE trip_places ADD COLUMN IF NOT EXISTS destination_id BIGINT");

    const dayCount = Math.max(1, Math.min(30, Number(body.days ?? trip.rows[0].days ?? 1) || 1));
    const placesResult = await db.query(
      "SELECT id, name, latitude, longitude, category, description, address, website_url AS \"websiteUrl\", destination_id AS \"destinationId\" FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC",
      [tripId]
    );

    const places: PlannerPlace[] = placesResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      category: row.category ? String(row.category) : undefined,
      description: row.description ? String(row.description) : undefined,
      address: row.address ? String(row.address) : undefined,
      websiteUrl: row.websiteUrl ? String(row.websiteUrl) : undefined,
      destinationId: row.destinationId == null ? null : String(row.destinationId),
    }));

    let destinations: TripDestination[] = [];
    try {
      const destinationResult = await db.query(
        `SELECT id, destination_name AS name, latitude, longitude, order_index AS "order"
           FROM trip_destinations
          WHERE trip_id = $1
          ORDER BY order_index ASC`,
        [tripId]
      );
      destinations = destinationResult.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        order: Number(row.order),
      })).filter((item) => item.name && Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
    } catch (error) {
      // Older trips may not have the multi-destination table yet; retain the
      // original single-destination planner as a backward-compatible fallback.
      console.warn("Could not load trip destinations for itinerary planning:", error);
    }

    if (destinations.length <= 1) {
      const days = buildSmartItinerary(places, dayCount).map((day) => ({
        ...day,
        destinationName: destinations[0]?.name ?? "",
      }));
      return NextResponse.json({
        tripId,
        days,
        selectedPlaceCount: places.length,
        plannedPlaceCount: days.reduce((sum, day) => sum + day.items.length, 0),
        destinations: destinations.map((item) => ({ id: item.id, name: item.name, order: item.order })),
        planner: {
          strategy: "geographic-clusters-and-nearest-neighbour",
          message: "Selected places are grouped by geographic proximity first, then ordered to reduce backtracking within each day.",
        },
      });
    }

    // Associate each saved attraction with the closest selected destination.
    // Places from Delhi must not be clustered into the Agra/Jaipur day just
    // because all saved attractions previously lived in one trip-wide list.
    const placesByDestination = new Map<string, PlannerPlace[]>(
      destinations.map((destination) => [destination.id, []])
    );
    for (const place of places) {
      // New saves carry the exact destination selected in Places to Explore.
      // Older saved places without this field are safely assigned to the nearest destination.
      const assigned = place.destinationId
        ? destinations.find((destination) => destination.id === place.destinationId)
        : undefined;
      const destination = assigned ?? [...destinations].sort((a, b) =>
        distanceKm(place, a) - distanceKm(place, b)
      )[0];
      if (destination) placesByDestination.get(destination.id)!.push(place);
    }

    const allocations = allocateDays(dayCount, destinations.length);
    let days: Array<Record<string, unknown>> = [];

    if (dayCount >= destinations.length) {
      let dayNumber = 1;
      destinations.forEach((destination, index) => {
        const destinationDays = buildSmartItinerary(
          placesByDestination.get(destination.id) ?? [],
          allocations[index]
        );
        for (const day of destinationDays) {
          days.push({
            ...day,
            dayNumber: dayNumber++,
            destinationId: destination.id,
            destinationName: destination.name,
          });
        }
      });
    } else {
      // When the user chooses fewer days than destinations, retain every stop
      // by grouping consecutive route destinations into each available day.
      const destinationBuckets = Array.from({ length: dayCount }, () => [] as TripDestination[]);
      destinations.forEach((destination, index) => destinationBuckets[index % dayCount].push(destination));
      days = destinationBuckets.map((bucket, index) => {
        const bucketPlaces = bucket.flatMap((destination) => placesByDestination.get(destination.id) ?? []);
        const planned = buildSmartItinerary(bucketPlaces, 1)[0];
        return {
          ...planned,
          dayNumber: index + 1,
          destinationIds: bucket.map((destination) => destination.id),
          destinationName: bucket.map((destination) => destination.name).join(" · "),
        };
      });
    }

    return NextResponse.json({
      tripId,
      days,
      selectedPlaceCount: places.length,
      plannedPlaceCount: days.reduce((sum, day) => sum + (Array.isArray(day.items) ? day.items.length : 0), 0),
      destinations: destinations.map((item) => ({ id: item.id, name: item.name, order: item.order })),
      planner: {
        strategy: "route-destination-groups-and-nearest-neighbour",
        message: "Your selected destinations are planned in route order, with each destination's places grouped into its own day cluster.",
      },
    });
  } catch (error) {
    console.error("POST /api/trips/[id]/itinerary/plan failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not build the smart itinerary." }, { status: 500 });
  }
}
