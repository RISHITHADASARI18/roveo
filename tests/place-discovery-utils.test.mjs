import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryForPlace, isKeralaStateDestination, normalizePlaceName } from "../lib/travel/place-discovery-utils.ts";

test("state-wide discovery is enabled only for an explicit Kerala destination", () => {
  assert.equal(isKeralaStateDestination("Kerala"), true);
  assert.equal(isKeralaStateDestination("Kerala, India"), true);
  assert.equal(isKeralaStateDestination("Kochi, Kerala"), false);
  assert.equal(isKeralaStateDestination("Munnar"), false);
});

test("common destination aliases normalize to the same deduplication key", () => {
  assert.equal(normalizePlaceName("Alleppey"), normalizePlaceName("Alappuzha"));
  assert.equal(normalizePlaceName("Alleppey Beach"), normalizePlaceName("Alappuzha Beach"));
  assert.equal(normalizePlaceName("Trivandrum"), normalizePlaceName("Thiruvananthapuram"));
  assert.equal(normalizePlaceName("Cochin"), normalizePlaceName("Kochi"));
});

test("places are assigned to dedicated categories before broad fallback groups", () => {
  assert.equal(categoryForPlace({ name: "Athirappilly Falls", type: "waterfall" }), "Waterfalls");
  assert.equal(categoryForPlace({ name: "Doddabetta Peak", type: "peak" }), "Viewpoints");
  assert.equal(categoryForPlace({ name: "Varkala Beach", type: "beach" }), "Beaches");
  assert.equal(categoryForPlace({ name: "Padmanabhaswamy Temple", type: "hindu_temple", group: "Culture" }), "Temples");
  assert.equal(categoryForPlace({ name: "Periyar National Park", type: "national_park", group: "Nature" }), "Nature");
  assert.equal(categoryForPlace({ name: "White Water Rafting", type: "rafting" }), "Adventure");
});
