import { test, expect } from "@playwright/test";

test("landing page to persisted trip carries every selected setting into the next screen", async ({ page }) => {
  const hyderabad = {
    id: "ci-hyderabad", name: "Hyderabad", displayName: "Hyderabad, Telangana, India",
    lat: 17.385, lon: 78.486, boundingBox: { south: 17.2, north: 17.6, west: 78.2, east: 78.8 },
    type: "city", importance: 0.9,
  };
  const vijayawada = {
    id: "ci-vijayawada", name: "Vijayawada", displayName: "Vijayawada, Andhra Pradesh, India",
    lat: 16.5062, lon: 80.648, boundingBox: { south: 16.3, north: 16.7, west: 80.4, east: 80.9 },
    type: "city", importance: 0.9,
  };
  const geocodeQueries: string[] = [];
  await page.route(/\/api\/geocode\/search/, async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q")?.toLowerCase() || "";
    geocodeQueries.push(query);
    console.log("[e2e] mocked geocode query:", query);
    const location = query.includes("vijay") ? vijayawada : hyderabad;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [location] }) });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Make the trip/i })).toBeVisible();
  await page.getByRole("link", { name: /Go to Dashboard/i }).click();

  await page.getByPlaceholder("Starting location").fill("Hyderabad");
  await expect(page.locator(".location-suggestions button")).toHaveCount(1, { timeout: 10000 });
  expect(geocodeQueries).toContain("hyderabad");
  await page.locator(".location-suggestions button").first().click();
  await page.getByPlaceholder("Add a destination").fill("Vijayawada");
  await expect(page.locator(".location-suggestions button")).toHaveCount(1, { timeout: 10000 });
  expect(geocodeQueries).toContain("vijayawada");
  await page.locator(".location-suggestions button").first().click();

  const numericInputs = page.locator('input[type="number"]');
  await numericInputs.nth(0).fill("3");
  await numericInputs.nth(1).fill("2");
  await numericInputs.nth(2).fill("30000");
  await page.locator('input[type="date"]').fill("2026-11-15");
  await page.locator("select").selectOption({ label: "Train" });
  await page.getByRole("button", { name: /Taxi/ }).click();
  await page.getByRole("button", { name: /Homestay/ }).click();

  const createResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/trips") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: /Find places & build my trip/ }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON();
  const body = await response.json();

  expect(payload.source.name).toBe("Hyderabad");
  expect(payload.destinations.map((item: { name: string }) => item.name)).toEqual(["Vijayawada"]);
  expect(payload.days).toBe(3);
  expect(payload.people).toBe(2);
  expect(payload.budget).toBe(30000);
  expect(payload.travel).toBe("Train");
  expect(payload.localTravel).toBe("Taxi");
  expect(payload.stay).toBe("Homestay");
  expect(payload.startDate).toBe("2026-11-15");
  expect(body.trip.id).toBeTruthy();
  expect(body.trip.destinations.map((item: { name: string }) => item.name)).toEqual(["Vijayawada"]);

  await page.waitForURL(/\/trip\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get("tripId")).toBe(String(body.trip.id));
  expect(url.searchParams.get("source")).toBe("Hyderabad");
  expect(url.searchParams.get("destination")).toBe("Vijayawada");
  expect(url.searchParams.get("days")).toBe("3");
  expect(url.searchParams.get("people")).toBe("2");
  expect(url.searchParams.get("budget")).toBe("30000");
  expect(url.searchParams.get("travel")).toBe("Train");
  expect(url.searchParams.get("localTravel")).toBe("Taxi");
  expect(url.searchParams.get("stay")).toBe("Homestay");
  expect(url.searchParams.get("startDate")).toBe("2026-11-15");
  await expect(page.locator("main")).toBeVisible();
});
