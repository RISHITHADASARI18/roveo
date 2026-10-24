import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calculateBudget } from "@/lib/budget/calculate";
import { searchStays } from "@/lib/accommodation/staying";
import { estimatePlaceCosts } from "@/lib/budget/place-costs";
import { estimateDestinationTravelCost, estimateLocalTransportCost, accommodationNights, stayDates, normalizeDateOnly } from "@/lib/budget/route-costs";

export const runtime = "nodejs";

function tripIdFromParams(params: { id: string }) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type CostPlace = { name: string; category?: string | null; latitude?: number | null; longitude?: number | null; destinationId?: string | null };
type RoutePoint = { latitude: number; longitude: number };

let accommodationPropertyColumnReady: Promise<void> | null = null;
async function ensureAccommodationPropertyColumn() {
  if (!accommodationPropertyColumnReady) {
    accommodationPropertyColumnReady = Promise.all([
      db.query("ALTER TABLE trip_cost_estimates ADD COLUMN IF NOT EXISTS accommodation_property JSONB"),
      db.query("ALTER TABLE trip_budgets ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE"),
    ]).then(() => undefined).catch((error) => {
      accommodationPropertyColumnReady = null;
      throw error;
    });
  }
  return accommodationPropertyColumnReady;
}

function validRoutePoint(latitude: unknown, longitude: unknown): boolean {
  const lat = Number(latitude), lon = Number(longitude);
  return latitude != null && longitude != null && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

async function estimateSelectedRouteDistance(places: CostPlace[]) {
  const points = places.filter((place) =>
    validRoutePoint(place.latitude, place.longitude)
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tripId = tripIdFromParams(await params);
  if (!tripId) {
    return NextResponse.json({ error: "Invalid trip id." }, { status: 400 });
  }

  try {
    await ensureAccommodationPropertyColumn();
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
        accommodation_property AS "accommodationProperty",
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
    await ensureAccommodationPropertyColumn();
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

    const days = Number(trip.days);
    const people = Number(trip.people);
    const tripBudget = Number(trip.budget);
    if (!Number.isInteger(days) || days < 1 || !Number.isInteger(people) || people < 1 ||
        !Number.isFinite(tripBudget) || tripBudget < 0 || !String(trip.destination ?? "").trim()) {
      return NextResponse.json(
        { error: "This trip is missing valid destination, duration, traveller count, or budget details. Update the trip details before generating a budget." },
        { status: 422 },
      );
    }

    // Capture the estimate version before slower route/provider lookups. A manual
    // edit made while generation is running must not be overwritten by this estimate.
    // If no previous estimate exists, preserve any pre-existing editable budget.
    const previousEstimateResult = await db.query(
      'SELECT generated_at AS "generatedAt" FROM trip_cost_estimates WHERE trip_id = $1',
      [tripId],
    );
    const previousEstimateGeneratedAt = previousEstimateResult.rows[0]?.generatedAt ?? null;

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
      const allSavedDestinationsHaveCoordinates = destinationResult.rows.length > 0 && destinationResult.rows.every((row) => validRoutePoint(row.latitude, row.longitude));
      const routeDestinations: RoutePoint[] = allSavedDestinationsHaveCoordinates
        ? destinationResult.rows.map((row) => ({ latitude: Number(row.latitude), longitude: Number(row.longitude) }))
        : [];
      const sourcePoint = validRoutePoint(trip.sourceLat, trip.sourceLon)
        ? { latitude: Number(trip.sourceLat), longitude: Number(trip.sourceLon) }
        : null;
      const fallbackDestination = validRoutePoint(trip.destinationLat, trip.destinationLon)
        ? { latitude: Number(trip.destinationLat), longitude: Number(trip.destinationLon) }
        : null;
      // Never calculate a partial multi-destination journey: omitting one destination
      // silently shortens the route and underestimates the travel budget.
      const orderedDestinations = destinationResult.rows.length
        ? (allSavedDestinationsHaveCoordinates ? routeDestinations : [])
        : fallbackDestination ? [fallbackDestination] : [];
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
    let liveStay: { name:string; totalPrice:number; currency:string; platform:string; url?:string; checkIn:string; checkOut:string; nights:number; adults:number } | null = null;
    let unsupportedCurrencyStay = false;

    const nights = accommodationNights(Number(trip.days));
    const normalizedStartDate = normalizeDateOnly(trip.startDate);
    const dates = normalizedStartDate ? stayDates(normalizedStartDate, Number(trip.days)) : null;
    if (process.env.STAYINGAPI_KEY && dates && nights > 0) {
      try {
        const stays = await searchStays({
          location: trip.destination,
          checkIn: dates.checkIn,
          checkOut: dates.checkOut,
          adults: Number(trip.people),
          stayPreference: trip.stayPreference,
        });
        if (stays.length) {
          const sorted = [...stays].sort((a,b)=>a.totalPrice-b.totalPrice);
          const chosen = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
          if (chosen.currency === "INR") {
            liveStay = {name:chosen.name,totalPrice:chosen.totalPrice,currency:chosen.currency,platform:chosen.platform,url:chosen.url,checkIn:dates.checkIn,checkOut:dates.checkOut,nights:dates.nights,adults:Number(trip.people)};
            calculation.items.accommodation = Number(chosen.totalPrice);
            accommodationSource = "stayingapi";
            accommodationConfidence = "live";
          } else {
            unsupportedCurrencyStay = true;
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

    const persistedAccommodationConfidence = liveStay
      ? "provider-listed-price-not-confirmed"
      : unsupportedCurrencyStay
        ? "estimate-unsupported-currency"
        : nights < 1
          ? "estimate-no-overnight-stay"
          : !dates
            ? "estimate-invalid-stay-dates"
            : process.env.STAYINGAPI_KEY
              ? "estimate-no-priced-results"
              : "estimate-provider-not-configured";

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
        accommodation_property,
        generated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW())
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
        accommodation_property = EXCLUDED.accommodation_property,
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
        accommodation_property AS "accommodationProperty",
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
        persistedAccommodationConfidence,
        calculation.source,
        liveStay ? JSON.stringify(liveStay) : null,
      ],
    );

    // Initialize or refresh the editable budget only if it has not been manually
    // changed since the estimate version captured above. The timestamp predicate
    // also protects edits made while route/provider lookups were still running.
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
        updated_at = NOW(),
        is_manual = FALSE
       WHERE $9::timestamptz IS NOT NULL
         AND trip_budgets.updated_at <= $9::timestamptz` ,
      [
        tripId,
        calculation.items.destinationTravel,
        calculation.items.accommodation,
        calculation.items.localTransport,
        calculation.items.food,
        calculation.items.activities,
        calculation.items.other,
        calculation.items.contingency,
        previousEstimateGeneratedAt,
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
          accommodationAvailability: liveStay ? "not-confirmed-by-provider" : "not-available",
          accommodationStatus: persistedAccommodationConfidence,
          accommodationNote: liveStay
            ? "A provider-listed property price was returned; this is not a booking or confirmed availability."
            : unsupportedCurrencyStay
              ? "The provider returned a price in a currency Roveo cannot safely convert, so the accommodation amount remains a Roveo estimate."
              : nights < 1
                ? "This trip has no overnight stays, so accommodation is estimated at zero."
                : !dates
                  ? "The saved trip date or stay length is invalid, so accommodation remains a Roveo estimate."
                  : process.env.STAYINGAPI_KEY
                    ? "No priced property was returned for these dates; the accommodation amount remains a Roveo estimate."
                    : "Live accommodation provider is not configured; the accommodation amount is a Roveo estimate.",
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
