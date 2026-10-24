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

// Ask OSRM for actual road distance and duration before ordering a driving
// itinerary. The public demo service is best-effort, so failures safely fall
// back to the planner's geographic estimates instead of breaking trip planning.
async function loadRoadMetrics(places: PlannerPlace[], localTravelMethod: string) {
  if (places.length < 2 || places.length > 70 || !/car|taxi/i.test(localTravelMethod)) return undefined;

  const coordinates = places.map((place) => place.longitude + "," + place.latitude).join(";");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(
      "https://router.project-osrm.org/table/v1/driving/" + coordinates + "?annotations=distance,duration",
      {
        headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel itinerary planner)" },
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (!response.ok) return undefined;
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.distances) || !Array.isArray(data.durations)) return undefined;
    if (data.distances.length !== places.length || data.durations.length !== places.length) return undefined;

    const indexes = new Map(places.map((place, index) => [place.id, index]));
    const fallbackKm = (a: PlannerPlace, b: PlannerPlace) => distanceKm(a, b);
    return {
      distanceKm: (a: PlannerPlace, b: PlannerPlace) => {
        const from = indexes.get(a.id), to = indexes.get(b.id);
        const meters = from == null || to == null ? null : data.distances[from]?.[to];
        return typeof meters === "number" && Number.isFinite(meters) ? meters / 1000 : fallbackKm(a, b);
      },
      travelMinutes: (a: PlannerPlace, b: PlannerPlace) => {
        const from = indexes.get(a.id), to = indexes.get(b.id);
        const seconds = from == null || to == null ? null : data.durations[from]?.[to];
        return typeof seconds === "number" && Number.isFinite(seconds)
          ? Math.max(1, Math.round(seconds / 60))
          : Math.max(10, Math.round(fallbackKm(a, b) * 4));
      },
      source: "osrm-road-matrix",
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
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
    const trip = await db.query("SELECT days, destination, local_travel_method FROM trips WHERE id = $1", [tripId]);
    if (trip.rowCount === 0) return NextResponse.json({ error: "Trip not found." }, { status: 404 });


    const dayCount = Math.max(1, Math.min(30, Number(body.days ?? trip.rows[0].days ?? 1) || 1));
    const placesResult = await db.query(
      "SELECT id, name, latitude, longitude, category, description, address, website_url AS \"websiteUrl\", destination_id AS \"destinationId\" FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC",
      [tripId]
    );

    // SQL NULL becomes 0 when passed through Number(null), which can silently
    // create fake stops near (0, 0). Reject missing/out-of-range coordinates before
    // geographic clustering so invalid legacy rows cannot distort the whole plan.
    const places: PlannerPlace[] = placesResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? "").trim(),
      latitude: row.latitude == null ? NaN : Number(row.latitude),
      longitude: row.longitude == null ? NaN : Number(row.longitude),
      category: row.category ? String(row.category) : undefined,
      description: row.description ? String(row.description) : undefined,
      address: row.address ? String(row.address) : undefined,
      websiteUrl: row.websiteUrl ? String(row.websiteUrl) : undefined,
      destinationId: row.destinationId == null ? null : String(row.destinationId),
    })).filter((place) =>
      place.name &&
      Number.isFinite(place.latitude) && place.latitude >= -90 && place.latitude <= 90 &&
      Number.isFinite(place.longitude) && place.longitude >= -180 && place.longitude <= 180
    );

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
        name: String(row.name ?? "").trim(),
        latitude: row.latitude == null ? NaN : Number(row.latitude),
        longitude: row.longitude == null ? NaN : Number(row.longitude),
        order: Number(row.order),
      })).filter((item) =>
        item.name &&
        Number.isFinite(item.latitude) && item.latitude >= -90 && item.latitude <= 90 &&
        Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180
      );
    } catch (error) {
      // Older trips may not have the multi-destination table yet; retain the
      // original single-destination planner as a backward-compatible fallback.
      console.warn("Could not load trip destinations for itinerary planning:", error);
    }

    if (destinations.length <= 1) {
      const roadMetrics = await loadRoadMetrics(places, String(trip.rows[0].local_travel_method ?? "Taxi"));
      const days = buildSmartItinerary(places, dayCount, roadMetrics).map((day) => ({
        ...day,
        destinationName: destinations[0]?.name ?? String(trip.rows[0].destination ?? ""),
      }));
      return NextResponse.json({
        tripId,
        days,
        selectedPlaceCount: places.length,
        plannedPlaceCount: days.reduce((sum, day) => sum + day.items.length, 0),
        destinations: destinations.map((item) => ({ id: item.id, name: item.name, order: item.order })),
        planner: {
          strategy: roadMetrics ? "road-distance-clusters-and-nearest-neighbour" : "geographic-clusters-and-nearest-neighbour",
          distanceSource: roadMetrics ? "OSRM road distance and duration matrix" : "straight-line geographic estimate (road matrix unavailable or unsupported travel mode)",
          message: roadMetrics
            ? "Selected places are grouped and ordered using road distances and estimated driving durations, while balancing visit time across the days."
            : "Selected places are grouped geographically and ordered to reduce backtracking; road-distance data was unavailable, so transfer times are estimates.",
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
      for (let index = 0; index < destinations.length; index += 1) {
        const destination = destinations[index];
        const destinationPlaces = placesByDestination.get(destination.id) ?? [];
        const roadMetrics = await loadRoadMetrics(destinationPlaces, String(trip.rows[0].local_travel_method ?? "Taxi"));
        const destinationDays = buildSmartItinerary(
          destinationPlaces,
          allocations[index],
          roadMetrics
        );
        for (const day of destinationDays) {
          days.push({
            ...day,
            dayNumber: dayNumber++,
            destinationId: destination.id,
            destinationName: destination.name,
          });
        }
      }
    } else {
      // When the user chooses fewer days than destinations, retain every stop
      // by grouping consecutive route destinations into each available day.
      const destinationBuckets = Array.from({ length: dayCount }, () => [] as TripDestination[]);
      // Keep destinations in consecutive route order. Modulo assignment would
      // incorrectly put destination 1 and destination 3 on day 1, then send
      // the traveler back to destination 2 on day 2.
      destinations.forEach((destination, index) => {
        const dayIndex = Math.min(dayCount - 1, Math.floor(index * dayCount / destinations.length));
        destinationBuckets[dayIndex].push(destination);
      });
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
        distanceSource: /car|taxi/i.test(String(trip.rows[0].local_travel_method ?? "Taxi"))
          ? "OSRM road matrix where available; geographic estimates as fallback"
          : "geographic estimate for planning; saved routes use the selected travel mode",
        message: dayCount < destinations.length
          ? "Your destinations are kept in route order, but this trip has fewer days than destinations. Some days combine destinations and may involve long transfers; add more days for a more realistic pace. Road distances are used where the routing service supports them."
          : "Your selected destinations are planned in route order. Places are grouped by destination and balanced by visit duration; road distances and driving times are used when the routing service supports them.",
      },
    });
  } catch (error) {
    console.error("POST /api/trips/[id]/itinerary/plan failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not build the smart itinerary." }, { status: 500 });
  }
}
