import type {
  PlaceSearchRequest,
  RouteRequest,
  RouteResult,
  TravelPlace,
  TravelProvider,
} from "./types";

const OSRM_URL = "https://router.project-osrm.org";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

function profileForMode(mode: RouteRequest["mode"]) {
  switch (mode) {
    case "WALK": return "foot";
    case "BICYCLE": return "bike";
    case "DRIVE": return "driving";
    case "TRANSIT":
      throw new Error("Public-transit routing is not available in the open routing provider.");
  }
}

async function osrmFetch(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner)" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error("Open routing service failed (" + response.status + "): " + body.slice(0, 300));
  }
  return response.json();
}

export const openTravelProvider: TravelProvider = {
  async computeRoute(request: RouteRequest): Promise<RouteResult> {
    const profile = profileForMode(request.mode);
    const coordinates = [
      request.origin.longitude + "," + request.origin.latitude,
      request.destination.longitude + "," + request.destination.latitude,
    ].join(";");
    const url = OSRM_URL + "/route/v1/" + profile + "/" + coordinates + "?overview=false&alternatives=false";
    const data = await osrmFetch(url);
    if (data.code !== "Ok" || !data.routes?.[0]) {
      throw new Error(data.message || "Open routing service returned no route.");
    }
    const route = data.routes[0];
    return { provider: "open", distanceMeters: Number(route.distance ?? 0), durationSeconds: Number(route.duration ?? 0) };
  },

  async searchPlaces(request: PlaceSearchRequest): Promise<TravelPlace[]> {
    const params = new URLSearchParams({
      q: request.textQuery,
      format: "jsonv2",
      limit: String(Math.min(Math.max(request.maxResults ?? 10, 1), 20)),
      addressdetails: "1",
    });
    if (typeof request.latitude === "number" && typeof request.longitude === "number") {
      params.set("lat", String(request.latitude));
      params.set("lon", String(request.longitude));
    }
    const response = await fetch(NOMINATIM_URL + "?" + params.toString(), {
      headers: { Accept: "application/json", "User-Agent": "Roveo/1.0 (travel planner)" },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error("Open places service failed (" + response.status + "): " + body.slice(0, 300));
    }
    const data = await response.json();
    return (Array.isArray(data) ? data : []).map((place: any, index: number) => ({
      id: String(place.osm_type ?? "place") + "-" + String(place.osm_id ?? index),
      name: place.display_name?.split(",")[0] ?? "Unnamed place",
      address: place.display_name,
      latitude: Number(place.lat),
      longitude: Number(place.lon),
      types: [place.type].filter(Boolean),
    }));
  },
};