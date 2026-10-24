import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateBudget } from "@/lib/budget/calculate";
import { searchStays } from "@/lib/accommodation/staying";
import { estimatePlaceCosts } from "@/lib/budget/place-costs";

export const runtime = "nodejs";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type CostPlace = { name: string; category?: string | null; latitude?: number | null; longitude?: number | null; destinationId?: string | null };
type RoutePoint = { latitude: number; longitude: number };

function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

async function estimateSelectedRouteDistance(places: CostPlace[]) {
  const points = places.filter((place) =>
    place.latitude != null && place.longitude != null &&
    Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude)) &&
    Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude))
  ).slice(0, 50).map((place) => ({
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
  }));
  if (points.length < 2) return { km: 0, source: "not-enough-geocoded-places" };

  const fallback = () => {
    const remaining = points.slice(1);
    let current = points[0];
    let km = 0;
    while (remaining.length) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((candidate, index) => {
        const distance = haversineKm(current, candidate) * 1.3;
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      });
      const next = remaining.splice(bestIndex, 1)[0];
      km += bestDistance;
      current = next;
    }
    return { km: Math.round(km * 1.2 * 10) / 10, source: "geographic route estimate with road and detour buffer" };
  };

  const coordinates = points.map((point) => point.longitude + "," + point.latitude).join(";");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch("https://router.project-osrm.org/table/v1/driving/" + coordinates + "?annotations=distance", {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel budget planner)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return fallback();
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.distances) || data.distances.length !== points.length) return fallback();

    const remaining = points.map((_, index) => index).slice(1);
    let current = 0;
    let metres = 0;
    while (remaining.length) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((candidate, index) => {
        const distance = data.distances[current]?.[candidate];
        if (typeof distance === "number" && Number.isFinite(distance) && distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      const next = remaining.splice(bestIndex, 1)[0];
      if (!Number.isFinite(bestDistance)) return fallback();
      metres += bestDistance;
      current = next;
    }
    return { km: Math.round((metres / 1000) * 1.2 * 10) / 10, source: "OSRM road-distance matrix plus 20% allowance for local detours" };
  } catch {
    return fallback();
  } finally {
    clearTimeout(timeout);
  }
}

async function estimateOrderedRouteDistance(points: RoutePoint[], useRoadRouting: boolean) {
  if (points.length < 2) return { km: 0, source: "not-enough-geocoded-route-points" };
  const straightLineKm = points.slice(1).reduce((sum, point, index) => sum + haversineKm(points[index], point), 0);
  const fallback = () => ({
    km: Math.round(straightLineKm * (useRoadRouting ? 1.3 : 1) * 10) / 10,
    source: useRoadRouting ? "straight-line distance plus 30% road detour estimate" : "great-circle distance estimate for air travel",
  });
  if (!useRoadRouting) return fallback();

  const coordinates = points.map((point) => point.longitude + "," + point.latitude).join(";");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch("https://router.project-osrm.org/table/v1/driving/" + coordinates + "?annotations=distance", {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel budget planner)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return fallback();
    const data = await response.json();
    if (data.code !== "Ok" || !Array.isArray(data.distances) || data.distances.length !== points.length) return fallback();
    let metres = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const leg = data.distances[index]?.[index + 1];
      if (typeof leg !== "number" || !Number.isFinite(leg)) return fallback();
      metres += leg;
    }
    return { km: Math.round((metres / 1000) * 1.1 * 10) / 10, source: "OSRM road-distance matrix plus 10% routing buffer" };
  } catch {
    return fallback();
  } finally {
    clearTimeout(timeout);
  }
}

function estimateDestinationTravelCost(method: string, people: number, roundTripKm: number) {
  if (!(roundTripKm > 0)) return null;
  const mode = method.toLowerCase();
  if (/flight|air/.test(mode)) return Math.round(Math.max(3000, roundTripKm * 2.7 + 2000) * people);
  if (/train|rail/.test(mode)) return Math.round(Math.max(300, roundTripKm * 0.7 + 250) * people);
  if (/bus|coach/.test(mode)) return Math.round(Math.max(250, roundTripKm * 1.05 + 200) * people);
  if (/public transport|public transit/.test(mode)) return Math.round(Math.max(250, roundTripKm * 0.8 + 200) * people);
  if (/taxi|cab/.test(mode)) return Math.round(roundTripKm * 22 + 500);
  if (/car|self.?drive/.test(mode)) return Math.round(roundTripKm * 12 + 300);
  return null;
}

function estimateLocalTransportCost(method: string, days: number, people: number, routeKm: number) {
  const mode = method.toLowerCase();
  if (/taxi|cab/.test(mode) && routeKm > 0) return Math.round(routeKm * 22 + days * 200);
  if (/car|self.?drive/.test(mode) && routeKm > 0) return Math.round(routeKm * 11 + days * 150);
  if (/bike|scooter/.test(mode) && routeKm > 0) return Math.round(routeKm * 5 + days * 100);
  if (/public|bus|metro|train/.test(mode)) return Math.round(350 * people * days);
  if (/walk/.test(mode)) return Math.round(100 * people * days);
  return routeKm > 0 ? Math.round(routeKm * 22 + days * 200) : 0;
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
    return NextResponse.json(
      { error: "Could not load the trip cost estimate." },
      { status: 500 },
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  try {
    const tripResult = await db.query(
      `SELECT days, people, budget, source, destination,
        source_lat AS "sourceLat", source_lon AS "sourceLon",
        destination_lat AS "destinationLat", destination_lon AS "destinationLon",
        start_date AS "startDate",
        travel_method AS "travelMethod",
        local_travel_method AS "localTravelMethod",
        stay_preference AS "stayPreference"
       FROM trips
       WHERE id = $1`,
      [tripId],
    );

    const trip = tripResult.rows[0];
    if (!trip) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const calculation = calculateBudget({
      days: Number(trip.days),
      people: Number(trip.people),
      budget: Number(trip.budget),
      travelMethod: trip.travelMethod,
      localTravelMethod: trip.localTravelMethod,
      destination: trip.destination,
      stayPreference: trip.stayPreference,
    });

    let destinationTravelSource = "Roveo fallback estimate because source/destination coordinates are unavailable";
    let destinationTravelDistanceKm = 0;
    try {
      const destinationResult = await db.query(
        `SELECT destination_name AS name, latitude, longitude
           FROM trip_destinations WHERE trip_id = $1 ORDER BY order_index ASC`,
        [tripId],
      );
      const routeDestinations: RoutePoint[] = destinationResult.rows
        .filter((row) => row.latitude != null && row.longitude != null)
        .map((row) => ({ latitude: Number(row.latitude), longitude: Number(row.longitude) }));
      const sourcePoint = trip.sourceLat != null && trip.sourceLon != null
        ? { latitude: Number(trip.sourceLat), longitude: Number(trip.sourceLon) }
        : null;
      const fallbackDestination = trip.destinationLat != null && trip.destinationLon != null
        ? { latitude: Number(trip.destinationLat), longitude: Number(trip.destinationLon) }
        : null;
      const orderedDestinations = routeDestinations.length ? routeDestinations : fallbackDestination ? [fallbackDestination] : [];
      if (sourcePoint && orderedDestinations.length) {
        const routePoints = [sourcePoint, ...orderedDestinations, sourcePoint];
        const useRoadRouting = /car|taxi|bus|coach/i.test(String(trip.travelMethod));
        const routeDistance = await estimateOrderedRouteDistance(routePoints, useRoadRouting);
        const method = String(trip.travelMethod).toLowerCase();
        // There is no rail-routing provider configured. Approximate rail distance
        // from the ordered city-to-city route instead of treating it as a car route.
        const modeDistanceKm = /train|rail|public transport|public transit/.test(method)
          ? Math.round(routeDistance.km * 1.3 * 10) / 10
          : routeDistance.km;
        destinationTravelDistanceKm = modeDistanceKm;
        const routeCost = estimateDestinationTravelCost(String(trip.travelMethod), Number(trip.people), modeDistanceKm);
        if (routeCost !== null) {
          calculation.items.destinationTravel = routeCost;
          destinationTravelSource = (/train|rail/.test(method) ? "Approximate rail distance based on 1.3x ordered city-to-city distance" : /public transport|public transit/.test(method) ? "Approximate transit distance based on 1.3x ordered city-to-city distance" : routeDistance.source) + "; fare calculated from a mode-specific planning rate, not a live carrier quote";
        }
      }
    } catch (error) {
      // Older deployments may not yet have multi-destination coordinates.
      console.warn("Could not estimate destination travel from route coordinates:", error);
    }

    const savedPlaces = await db.query(
      "SELECT name, category, latitude, longitude, destination_id AS \"destinationId\" FROM trip_places WHERE trip_id = $1 ORDER BY created_at ASC, id ASC",
      [tripId],
    );
    const costPlaces: CostPlace[] = savedPlaces.rows.map((place) => ({
      name: String(place.name),
      category: place.category == null ? null : String(place.category),
      latitude: place.latitude == null ? null : Number(place.latitude),
      longitude: place.longitude == null ? null : Number(place.longitude),
      destinationId: place.destinationId == null ? null : String(place.destinationId),
    }));
    const placeCosts = estimatePlaceCosts(costPlaces, Number(trip.people));
    // Use official ticket ranges where a trustworthy price is available. For
    // places with no published price match, retain a clearly provisional
    // allowance rather than silently treating the visit as free.
    const provisionalUnpricedAllowance = placeCosts.unpricedPlaceCount * 250 * Number(trip.people);
    if (costPlaces.length) calculation.items.activities = placeCosts.total + provisionalUnpricedAllowance;

    let routeDestinationsForLocalTravel: Array<{ id: string; latitude: number; longitude: number }> = [];
    try {
      const destinationRows = await db.query(
        "SELECT id, latitude, longitude FROM trip_destinations WHERE trip_id = $1 ORDER BY order_index ASC",
        [tripId],
      );
      routeDestinationsForLocalTravel = destinationRows.rows
        .filter((row) => row.latitude != null && row.longitude != null)
        .map((row) => ({ id: String(row.id), latitude: Number(row.latitude), longitude: Number(row.longitude) }));
    } catch {
      routeDestinationsForLocalTravel = [];
    }

    // Keep local sightseeing mileage separate for each destination. Joining all
    // saved pins into one route used to count inter-city transfers as local taxi
    // travel, which double-counted distance and inflated the budget.
    const localGroups = new Map<string, CostPlace[]>();
    for (const place of costPlaces) {
      let destinationId = place.destinationId ?? "";
      if (!destinationId && routeDestinationsForLocalTravel.length && place.latitude != null && place.longitude != null) {
        const nearest = [...routeDestinationsForLocalTravel].sort((a, b) =>
          haversineKm({ latitude: Number(place.latitude), longitude: Number(place.longitude) }, a) -
          haversineKm({ latitude: Number(place.latitude), longitude: Number(place.longitude) }, b)
        )[0];
        destinationId = nearest?.id ?? "";
      }
      const key = destinationId || "single-destination";
      localGroups.set(key, [...(localGroups.get(key) ?? []), place]);
    }
    const groupDistances = await Promise.all([...localGroups.values()].map((group) => estimateSelectedRouteDistance(group)));
    const routeDistance = {
      km: Math.round(groupDistances.reduce((sum, item) => sum + item.km, 0) * 10) / 10,
      source: groupDistances.length
        ? [...new Set(groupDistances.map((item) => item.source))].join("; ")
        : "not-enough-geocoded-places",
    };
    const localTransportEstimate = estimateLocalTransportCost(
      String(trip.localTravelMethod ?? "Taxi"),
      Number(trip.days),
      Number(trip.people),
      routeDistance.km,
    );
    if (localTransportEstimate > 0) calculation.items.localTransport = localTransportEstimate;

    let accommodationSource = "roveo";
    let accommodationConfidence = "fallback";
    let liveStay: { name:string; totalPrice:number; currency:string; platform:string; url?:string } | null = null;

    if (process.env.STAYINGAPI_KEY && trip.startDate) {
      const checkIn = new Date(String(trip.startDate) + "T00:00:00Z");
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + Number(trip.days));
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      try {
        const stays = await searchStays({
          location: trip.destination,
          checkIn: iso(checkIn),
          checkOut: iso(checkOut),
          adults: Number(trip.people),
          stayPreference: trip.stayPreference,
        });
        if (stays.length) {
          const sorted = [...stays].sort((a,b)=>a.totalPrice-b.totalPrice);
          const chosen = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
          liveStay = {name:chosen.name,totalPrice:chosen.totalPrice,currency:chosen.currency,platform:chosen.platform,url:chosen.url};
          if (chosen.currency === "INR") {
            calculation.items.accommodation = Number(chosen.totalPrice);
            accommodationSource = "stayingapi";
            accommodationConfidence = "live";
          }
        }
      } catch (error) {
        console.error("Live accommodation estimate failed:", error);
      }
    }

    const subtotal =
      calculation.items.destinationTravel +
      calculation.items.accommodation +
      calculation.items.localTransport +
      calculation.items.food +
      calculation.items.activities +
      calculation.items.other;
    calculation.items.contingency = Math.round(subtotal * 0.1 * 100) / 100;
    calculation.subtotal = Math.round(subtotal * 100) / 100;
    calculation.total = Math.round((subtotal + calculation.items.contingency) * 100) / 100;
    calculation.remaining = Math.round((calculation.budget - calculation.total) * 100) / 100;

    const saved = await db.query(
      `INSERT INTO trip_cost_estimates (
        trip_id,
        destination_travel,
        accommodation,
        local_transport,
        food,
        activities,
        other,
        contingency,
        total,
        currency,
        confidence,
        source,
        generated_at
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
      RETURNING id,
        trip_id AS "tripId",
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
        generated_at AS "generatedAt"`,
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

    // Initialise the editable budget table at the same time as the estimate.
    // The Budget page reads trip_budgets, so only writing trip_cost_estimates
    // previously made the page appear uninitialised after a refresh.
    await db.query(
      `INSERT INTO trip_budgets
        (trip_id, destination_travel, accommodation, local_transport, food, activities, other, contingency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (trip_id) DO UPDATE SET
        destination_travel = EXCLUDED.destination_travel,
        accommodation = EXCLUDED.accommodation,
        local_transport = EXCLUDED.local_transport,
        food = EXCLUDED.food,
        activities = EXCLUDED.activities,
        other = EXCLUDED.other,
        contingency = EXCLUDED.contingency,
        updated_at = NOW()`,
      [
        tripId,
        calculation.items.destinationTravel,
        calculation.items.accommodation,
        calculation.items.localTransport,
        calculation.items.food,
        calculation.items.activities,
        calculation.items.other,
        calculation.items.contingency,
      ],
    );

    await db.query(
      "UPDATE trips SET updated_at = NOW() WHERE id = $1",
      [tripId],
    );

    return NextResponse.json(
      {
        estimate: saved.rows[0],
        calculation,
        liveStay,
        placeCosts: { ...placeCosts, provisionalUnpricedAllowance },
        pricing: {
          accommodationSource,
          accommodationConfidence,
          localTransportSource: routeDistance.source,
          selectedRouteDistanceKm: routeDistance.km,
          localTransportEstimateSource: "Planning estimate based on selected-place route distance and local travel mode; actual fares and traffic vary.",
          destinationTravelSource,
          destinationTravelDistanceKm,
          activityAllowanceSource: "Official venue ticket ranges where available; provisional ₹250 per person for each unpriced selected place.",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST budget estimate failed:", error);
    return NextResponse.json(
      { error: "Could not generate the trip cost estimate." },
      { status: 500 },
    );
  }
}
