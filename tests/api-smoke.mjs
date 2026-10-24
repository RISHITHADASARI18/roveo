import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "pg";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const accommodationProvider = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1:4010");
  const noResults = (url.searchParams.get("location") || "").toLowerCase().includes("noresults");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    data: noResults ? [] : [{
      name: "CI Mock Homestay",
      platform: "CI Mock Provider",
      price: { nightlyPrice: 2000, totalPrice: 4000, currency: "INR" },
      url: "https://example.test/ci-mock-homestay",
    }],
  }));
});
accommodationProvider.listen(4010, "127.0.0.1");
await new Promise((resolve) => accommodationProvider.once("listening", resolve));
accommodationProvider.unref();
async function api(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
function box(south, north, west, east) { return { south, north, west, east }; }

const created = await api("/api/trips", { method: "POST", body: JSON.stringify({
  source: { name: "Hyderabad", lat: 17.385, lon: 78.486, boundingBox: box(17.2, 17.6, 78.2, 78.8) },
  destinations: [
    { name: "Vijayawada", lat: 16.5062, lon: 80.648, boundingBox: box(16.3, 16.7, 80.4, 80.9) },
    { name: "Guntur", lat: 16.3067, lon: 80.4365, boundingBox: box(16.1, 16.5, 80.2, 80.7) },
  ],
  days: 3, people: 2, budget: 30000, travel: "Train",
  localTravel: "Public transport, Taxi", stay: "Hotel", startDate: "2026-11-15",
}) });
const trip = created.trip;
assert.ok(trip?.id, "trip creation returns a persisted trip id");
assert.deepEqual(trip.destinations.map((d) => d.name), ["Vijayawada", "Guntur"], "destination order is preserved");
assert.equal(Number(trip.people), 2);
assert.equal(Number(trip.days), 3);
assert.equal(trip.localTravel, "Public transport, Taxi");

const tripsAfterReload = await api("/api/trips");
const persistedTrip = tripsAfterReload.trips.find((item) => String(item.id) === String(trip.id));
assert.ok(persistedTrip, "created trip survives a fresh API read");
assert.deepEqual(persistedTrip.destinations.map((d) => d.name), ["Vijayawada", "Guntur"], "saved destinations survive reload in order");

const destinationId = trip.destinations[0].id;
const firstPlace = { provider: "openstreetmap", providerPlaceId: "ci-place-1", name: "CI Attraction A", latitude: 16.510, longitude: 80.620, category: "Waterfalls", destinationId };
const secondPlace = { provider: "openstreetmap", providerPlaceId: "ci-place-2", name: "CI Attraction B", latitude: 16.517, longitude: 80.630, category: "History", destinationId };
const savedFirst = await api(`/api/trips/${trip.id}/places`, { method: "POST", body: JSON.stringify(firstPlace) });
const savedSecond = await api(`/api/trips/${trip.id}/places`, { method: "POST", body: JSON.stringify(secondPlace) });
assert.ok(savedFirst.place?.id && savedSecond.place?.id, "both places return saved database ids");
let savedPlaces = await api(`/api/trips/${trip.id}/places`);
assert.equal(savedPlaces.places.length, 2, "adding places updates the saved trip");
assert.equal(savedPlaces.places.find((p) => p.providerPlaceId === "ci-place-1")?.category, "Waterfalls", "specific place categories persist for budget and itinerary use");
assert.ok(savedPlaces.places.every((p) => Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)) && Math.abs(Number(p.latitude)) <= 90 && Math.abs(Number(p.longitude)) <= 180), "saved places have valid coordinates");

await api(`/api/trips/${trip.id}/places?placeId=${savedSecond.place.id}`, { method: "DELETE" });
savedPlaces = await api(`/api/trips/${trip.id}/places`);
assert.equal(savedPlaces.places.length, 1, "removing a place persists after a fresh read");
await api(`/api/trips/${trip.id}/places`, { method: "POST", body: JSON.stringify(secondPlace) });
savedPlaces = await api(`/api/trips/${trip.id}/places`);
assert.equal(savedPlaces.places.length, 2, "re-adding a place restores it without creating a duplicate");

const plan = await api(`/api/trips/${trip.id}/itinerary/plan`, { method: "POST", body: JSON.stringify({ days: 3 }) });
assert.equal(plan.selectedPlaceCount, 2, "itinerary receives the two saved places");
assert.equal(plan.plannedPlaceCount, 2, "both short nearby stops fit in the three-day test trip");
const savedPlaceIds = new Set(savedPlaces.places.map((p) => String(p.id)));
const plannedIds = plan.days.flatMap((day) => day.items.map((item) => String(item.id)));
assert.equal(new Set(plannedIds).size, plannedIds.length, "a place is not scheduled twice");
assert.ok(plannedIds.every((id) => savedPlaceIds.has(id)), "itinerary contains only places saved to this trip");

const savedPlan = await api(`/api/trips/${trip.id}/itinerary`, { method: "PUT", body: JSON.stringify({ days: plan.days.map((day) => ({
  dayNumber: day.dayNumber,
  items: day.items.map((item, index) => ({ tripPlaceId: Number(item.id), position: index + 1, startTime: item.startTime ?? null, durationMinutes: item.durationMinutes ?? null, travelTimeMinutes: item.travelTimeMinutes ?? null })),
})) }) });
assert.equal(savedPlan.saved, true, "itinerary save succeeds");
const reloadedItinerary = await api(`/api/trips/${trip.id}/itinerary`);
const itineraryItems = reloadedItinerary.days.flatMap((day) => day.items);
assert.equal(itineraryItems.length, 2, "saved itinerary survives reload");
assert.ok(itineraryItems.every((item) => item.place && savedPlaceIds.has(String(item.place.id))), "itinerary pins reference the same saved places");
assert.ok(itineraryItems.every((item) => Number.isFinite(Number(item.place.latitude)) && Number.isFinite(Number(item.place.longitude))), "every planned map pin has coordinates");

const generatedRoutes = await api(`/api/trips/${trip.id}/routes`, { method: "POST", body: JSON.stringify({}) });
const expectedRouteLegs = reloadedItinerary.days.reduce((sum, day) => sum + Math.max(0, day.items.length - 1), 0);
assert.equal(generatedRoutes.routeCount, expectedRouteLegs, "route legs match consecutive stops within each planned day");
const itemIds = new Set(itineraryItems.map((item) => String(item.itemId)));
assert.ok(generatedRoutes.routes.every((route) => itemIds.has(String(route.fromItemId)) && itemIds.has(String(route.toItemId))), "route endpoints reference actual itinerary items");
assert.ok(generatedRoutes.routes.every((route) => route.mode === generatedRoutes.mode), "route lines use the active route mode");
const reloadedRoutes = await api(`/api/trips/${trip.id}/routes`);
assert.ok(reloadedRoutes.routes.every((route) => route.mode === reloadedRoutes.mode), "reloaded map routes do not mix travel modes");

const stayNoResults = await api("/api/accommodations/search", { method: "POST", body: JSON.stringify({ location: "NoResults", checkIn: "2026-11-15", checkOut: "2026-11-17", adults: 2, stayPreference: "Hotel" }) });
assert.equal(stayNoResults.providerStatus, "no_results", "a configured provider returning no results is distinguished from an estimated fallback");
assert.equal(stayNoResults.live, true);
assert.equal(stayNoResults.availabilityConfirmed, false);
assert.deepEqual(stayNoResults.stays, []);
const invalidStayResponse = await fetch(base + "/api/accommodations/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "Vijayawada", checkIn: "2026-02-30", checkOut: "2026-03-02", adults: 2 }) });
assert.equal(invalidStayResponse.status, 400, "invalid calendar dates are rejected");

// Regression test for deployments where the trip tables exist but the budget tables
// were never created. The budget endpoint must safely initialize its own schema.
const schemaClient = new Client({ connectionString: process.env.DATABASE_URL });
await schemaClient.connect();
let originalTripDestination;
try {
  const tripRow = await schemaClient.query("SELECT destination FROM trips WHERE id = $1", [trip.id]);
  originalTripDestination = tripRow.rows[0].destination;
  await schemaClient.query("UPDATE trips SET destination = '' WHERE id = $1", [trip.id]);
  await schemaClient.query("DROP TABLE IF EXISTS trip_cost_estimates");
  await schemaClient.query("DROP TABLE IF EXISTS trip_budgets");
} finally {
  await schemaClient.end();
}
const incompleteEstimateResponse = await fetch(`${base}/api/trips/${trip.id}/budget/estimate`, { method: "POST" });
assert.equal(incompleteEstimateResponse.status, 422, "an incomplete trip is rejected instead of returning misleading budget totals");
const restoreClient = new Client({ connectionString: process.env.DATABASE_URL });
await restoreClient.connect();
try {
  await restoreClient.query("UPDATE trips SET destination = $1 WHERE id = $2", [originalTripDestination, trip.id]);
} finally {
  await restoreClient.end();
}

const estimate = await api(`/api/trips/${trip.id}/budget/estimate`, { method: "POST", body: JSON.stringify({}) });
assert.ok(Number(estimate.calculation.total) >= Number(estimate.calculation.subtotal), "generated budget total includes contingency");
assert.ok(estimate.placeCosts.places.some((place) => place.name === "CI Attraction A" && place.category === "Waterfalls"), "a selected place and its category flow into the budget breakdown");
assert.ok(Number(estimate.calculation.items.activities) > 0, "selected places contribute to the activities budget allowance");
assert.equal(estimate.pricing.accommodationStatus, "provider-listed-price-not-confirmed", "a priced listing is distinguished from a fallback estimate");
assert.equal(estimate.liveStay.name, "CI Mock Homestay", "the returned property is an actual provider listing");
assert.equal(estimate.liveStay.totalPrice, 4000, "the listed price is used for the matching stay dates");
assert.equal(estimate.liveStay.nights, 2, "the provider search uses days minus one nights");
assert.equal(estimate.liveStay.checkIn, "2026-11-15");
assert.equal(estimate.liveStay.checkOut, "2026-11-17");
const estimateAfterReload = await api("/api/trips/" + trip.id + "/budget");
assert.equal(estimateAfterReload.accommodationProperty.name, "CI Mock Homestay", "provider property details persist after reloading the budget");
assert.equal(Number(estimateAfterReload.accommodationProperty.totalPrice), 4000);
assert.equal(estimateAfterReload.accommodationProperty.nights, 2);
const manualBudget = { destinationTravel: 5000, accommodation: 4321, localTransport: 900, food: 3600, activities: 1800, other: 250, contingency: 500 };
await api(`/api/trips/${trip.id}/budget`, { method: "PUT", body: JSON.stringify(manualBudget) });
const reloadedBudget = await api(`/api/trips/${trip.id}/budget`);
for (const [key, value] of Object.entries(manualBudget)) {
  const savedItem = reloadedBudget.budget.items.find((item) => item.category === key);
  assert.equal(Number(savedItem.amount), value, `budget ${key} persists after reload`);
}
assert.equal(reloadedBudget.accommodationStatus, "provider-listed-price-not-confirmed", "accommodation provenance survives reload");
const expectedManualSubtotal = manualBudget.destinationTravel + manualBudget.accommodation + manualBudget.localTransport + manualBudget.food + manualBudget.activities + manualBudget.other;
assert.equal(Number(reloadedBudget.budget.subtotal), expectedManualSubtotal, "subtotal sums all non-contingency categories exactly once");
assert.equal(Number(reloadedBudget.budget.total), expectedManualSubtotal + manualBudget.contingency, "total includes contingency exactly once");
assert.equal(Number(reloadedBudget.trip.budget), 30000, "budget page receives the canonical trip budget from the database");
assert.equal(Number(reloadedBudget.trip.people), 2, "budget page receives the canonical traveller count from the database");

await api(`/api/trips/${trip.id}/budget/estimate`, { method: "POST", body: JSON.stringify({}) });
const budgetAfterEstimateRefresh = await api(`/api/trips/${trip.id}/budget`);
for (const [key, value] of Object.entries(manualBudget)) {
  const savedItem = budgetAfterEstimateRefresh.budget.items.find((item) => item.category === key);
  assert.equal(Number(savedItem.amount), value, `manual budget ${key} is not overwritten by a regenerated estimate`);
}
assert.equal(Number(budgetAfterEstimateRefresh.budget.subtotal), expectedManualSubtotal, "manual subtotal remains consistent after estimate regeneration");
assert.equal(Number(budgetAfterEstimateRefresh.budget.total), expectedManualSubtotal + manualBudget.contingency, "manual total remains consistent after estimate regeneration");

const discoveryResponse = await fetch(base + "/api/places/discover?destination=" + encodeURIComponent("Vijayawada, Andhra Pradesh, India") + "&maxResults=50");
assert.equal(discoveryResponse.status, 200, "live destination discovery returns a usable response");
const discovery = await discoveryResponse.json();
assert.ok(Array.isArray(discovery.places) && discovery.places.length > 0, "live discovery returns places for the selected destination");
assert.ok(discovery.places.every((place) =>
  place.name && Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude)) &&
  Number(place.latitude) >= -90 && Number(place.latitude) <= 90 &&
  Number(place.longitude) >= -180 && Number(place.longitude) <= 180 &&
  Number.isFinite(Number(place.distanceKm)) && Number(place.distanceKm) <= 50
), "live discovery returns named places with valid coordinates inside the selected city radius");
const templeResponse = await fetch(base + "/api/places/discover?destination=" + encodeURIComponent("Vijayawada, Andhra Pradesh, India") + "&q=temple&maxResults=30");
assert.equal(templeResponse.status, 200, "destination-scoped category search returns a usable response");
const templeResults = await templeResponse.json();
assert.ok(templeResults.places.length > 0, "destination-scoped temple search returns relevant local results");
assert.ok(templeResults.places.every((place) => (place.name + " " + (place.description || "") + " " + place.type + " " + place.group).toLowerCase().includes("temple")), "category query does not leak unrelated results");

const oneDayTrip = await api("/api/trips", { method: "POST", body: JSON.stringify({
  source: { name: "Hyderabad", lat: 17.385, lon: 78.486 },
  destinations: [{ name: "Vijayawada", lat: 16.5062, lon: 80.648 }],
  days: 1, people: 1, budget: 10000, travel: "Train",
  localTravel: "Walking", stay: "Hotel", startDate: "2026-11-15",
}) });
const oneDayEstimate = await api("/api/trips/" + oneDayTrip.trip.id + "/budget/estimate", { method: "POST", body: JSON.stringify({}) });
assert.equal(Number(oneDayEstimate.calculation.items.accommodation), 0, "a one-day trip has zero accommodation nights");
assert.equal(oneDayEstimate.pricing.accommodationStatus, "estimate-no-overnight-stay");
const oneDayReload = await api("/api/trips/" + oneDayTrip.trip.id + "/budget");
assert.equal(oneDayReload.accommodationStatus, "estimate-no-overnight-stay", "the no-overnight status survives reload");

console.log("API smoke passed: live destination-scoped discovery, trip persistence, place add/remove, itinerary/map pin consistency, route-to-stop consistency, budget persistence, no-result accommodation fallback, and provider listing persistence.");
await new Promise((resolve, reject) => accommodationProvider.close((error) => error ? reject(error) : resolve()));