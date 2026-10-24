import test from "node:test";
import assert from "node:assert/strict";
import { calculateBudget, calculateAccommodation, calculateDestinationTravel, calculateLocalTransport } from "../lib/budget/calculate.ts";
import { estimateDestinationTravelCost, estimateLocalTransportCost, accommodationNights, stayDates } from "../lib/budget/route-costs.ts";
import { estimatePlaceCosts } from "../lib/budget/place-costs.ts";

test("people count updates per-person travel, food and activities; accommodation adds rooms for larger groups", () => {
  const one = calculateBudget({ days: 3, people: 1, budget: 50000, destination: "Hyderabad", travelMethod: "Train", localTravelMethod: "Public transport", stayPreference: "Hotel" });
  const three = calculateBudget({ days: 3, people: 3, budget: 50000, destination: "Hyderabad", travelMethod: "Train", localTravelMethod: "Public transport", stayPreference: "Hotel" });
  assert.ok(three.items.destinationTravel > one.items.destinationTravel);
  assert.ok(three.items.food > one.items.food);
  assert.ok(three.items.activities > one.items.activities);
  assert.ok(three.items.accommodation > one.items.accommodation);
});

test("duration charges days minus one accommodation nights", () => {
  assert.equal(calculateAccommodation("Hotel", 1, 2), 0);
  assert.equal(calculateAccommodation("Hotel", 2, 2), 2500);
  assert.equal(calculateAccommodation("Hotel", 4, 2), 7500);
  assert.equal(accommodationNights(1), 0);
  assert.equal(accommodationNights(5), 4);
  const two = calculateBudget({ days: 2, people: 2, budget: 50000, destination: "Hyderabad", travelMethod: "Bus", localTravelMethod: "Walking", stayPreference: "Hostel" });
  const four = calculateBudget({ days: 4, people: 2, budget: 50000, destination: "Hyderabad", travelMethod: "Bus", localTravelMethod: "Walking", stayPreference: "Hostel" });
  assert.equal(four.items.accommodation, 3 * two.items.accommodation);
  assert.ok(four.items.food > two.items.food);
});

test("stay date range rejects invalid dates and handles check-out correctly", () => {
  assert.deepEqual(stayDates("2026-10-24", 3), { checkIn: "2026-10-24", checkOut: "2026-10-26", nights: 2 });
  assert.equal(stayDates("2026-02-30", 3), null);
  assert.equal(stayDates("2026-10-24", 1), null);
});

test("transport mode changes estimates; per-person modes scale with people", () => {
  assert.notEqual(calculateDestinationTravel("Flight", 2), calculateDestinationTravel("Train", 2));
  assert.ok(calculateLocalTransport("Public transport", 3, 4) > calculateLocalTransport("Public transport", 3, 1));
  assert.ok(estimateDestinationTravelCost("Train", 4, 800) > estimateDestinationTravelCost("Train", 1, 800));
  assert.notEqual(estimateDestinationTravelCost("Flight", 2, 800), estimateDestinationTravelCost("Bus", 2, 800));
});

test("taxi is vehicle-priced while public transport scales with group size", () => {
  assert.equal(estimateLocalTransportCost("Taxi", 2, 1, 50), estimateLocalTransportCost("Taxi", 2, 4, 50));
  assert.ok(estimateLocalTransportCost("Public transport", 2, 4, 50) > estimateLocalTransportCost("Public transport", 2, 1, 50));
});

test("multi-select local transport is averaged instead of charging the journey multiple times", () => {
  const taxi = estimateLocalTransportCost("Taxi", 3, 2, 40);
  const car = estimateLocalTransportCost("Car", 3, 2, 40);
  const both = estimateLocalTransportCost("Car, Taxi", 3, 2, 40);
  assert.equal(both, Math.round((taxi + car) / 2));
  assert.ok(both < taxi + car);
});

test("budget total sums every category once plus contingency", () => {
  const result = calculateBudget({ days: 3, people: 2, budget: 30000, destination: "Hyderabad", travelMethod: "Bus", localTravelMethod: "Taxi, Public transport", stayPreference: "Hotel" });
  const subtotal = result.items.destinationTravel + result.items.accommodation + result.items.localTransport + result.items.food + result.items.activities + result.items.other;
  assert.equal(result.subtotal, subtotal);
  assert.equal(result.total, result.subtotal + result.items.contingency);
});

test("official ticket ranges stay distinct from unknown prices", () => {
  const costs = estimatePlaceCosts([{ name: "Wonderla Hyderabad" }, { name: "Small local viewpoint" }], 3);
  assert.equal(costs.pricedPlaceCount, 1);
  assert.equal(costs.unpricedPlaceCount, 1);
  assert.equal(costs.places[0].confidence, "official-range");
  assert.equal(costs.places[1].confidence, "unknown");
  assert.equal(costs.places[1].total, null);
});