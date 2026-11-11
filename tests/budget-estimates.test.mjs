import test from "node:test";
import assert from "node:assert/strict";
import { calculateBudget, calculateAccommodation, calculateFood, calculateLocalTransport } from "../lib/budget/calculate.ts";

test("destination profiles produce different estimates for different cost levels", () => {
  const base = { days: 3, people: 2, budget: 30000, travelMethod: "Train", localTravelMethod: "Public transport", stayPreference: "Hotel" };
  const premium = calculateBudget({ ...base, destination: "Goa" });
  const lowerCost = calculateBudget({ ...base, destination: "Vijayawada" });
  assert.ok(premium.total > lowerCost.total, "premium destinations should have higher planning estimates");
  assert.ok(premium.items.food > lowerCost.items.food);
  assert.ok(premium.items.accommodation > lowerCost.items.accommodation);
});

test("stay preference and group size change accommodation estimates", () => {
  const hotel = calculateAccommodation("Hotel", 3, 2, "Vijayawada");
  const hostel = calculateAccommodation("Hostel", 3, 2, "Vijayawada");
  const fourTravellers = calculateAccommodation("Hotel", 3, 4, "Vijayawada");
  assert.ok(hotel > hostel);
  assert.ok(fourTravellers > hotel);
});

test("local transport alternatives are averaged instead of charged as separate full trips", () => {
  const single = calculateLocalTransport("Taxi", 2, 2);
  const combined = calculateLocalTransport("Taxi, Public transport", 2, 2);
  assert.ok(combined < single + 2 * 180 * 2);
  assert.ok(combined > 0);
});

test("budget total includes contingency once and remaining uses the user's entered budget", () => {
  const result = calculateBudget({
    days: 2, people: 1, budget: 15000, destination: "Vijayawada",
    travelMethod: "Train", localTravelMethod: "Walking", stayPreference: "Hostel",
  });
  assert.equal(result.total, result.subtotal + result.items.contingency);
  assert.equal(result.remaining, result.budget - result.total);
  assert.equal(result.currency, "INR");
});
