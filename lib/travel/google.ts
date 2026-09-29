import type {
  PlaceSearchRequest,
  RouteRequest,
  RouteResult,
  TravelPlace,
  TravelProvider,
} from "./types";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

function apiKey() {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_MAPS_SERVER_API_KEY is not configured.");
  }
  return key;
}

async function googleFetch(
  url: string,
  init: RequestInit,
  fieldMask: string,
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": fieldMask,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google travel API failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  return response.json();
}

export const googleTravelProvider: TravelProvider = {
  async computeRoute(request: RouteRequest): Promise<RouteResult> {
    const routeRequest: Record<string, unknown> = {
      origin: { location: { latLng: request.origin } },
      destination: { location: { latLng: request.destination } },
      travelMode: request.mode,
      computeAlternativeRoutes: false,
      units: "METRIC",
    };

    // Google Routes only supports routingPreference for driving-style
    // routes. Keeping it out of walking, cycling and transit requests
    // prevents invalid requests for those travel modes.
    if (request.mode === "DRIVE") {
      routeRequest.routingPreference = "TRAFFIC_AWARE";
    }

    const data = await googleFetch(
      ROUTES_URL,
      {
        method: "POST",
        body: JSON.stringify(routeRequest),
      },
      "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    );

    const route = data.routes?.[0];
    if (!route) {
      throw new Error("Google Routes returned no route.");
    }

    return {
      provider: "google",
      distanceMeters: Number(route.distanceMeters ?? 0),
      durationSeconds: Number.parseFloat(
        String(route.duration ?? "0s").replace("s", ""),
      ),
      encodedPolyline: route.polyline?.encodedPolyline,
    };
  },

  async searchPlaces(request: PlaceSearchRequest): Promise<TravelPlace[]> {
    const body: Record<string, unknown> = {
      textQuery: request.textQuery,
      pageSize: Math.min(Math.max(request.maxResults ?? 10, 1), 20),
    };

    if (
      typeof request.latitude === "number" &&
      typeof request.longitude === "number"
    ) {
      body.locationBias = {
        circle: {
          center: {
            latitude: request.latitude,
            longitude: request.longitude,
          },
          radius: request.radiusMeters ?? 5000,
        },
      };
    }

    const data = await googleFetch(
      PLACES_URL,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.priceLevel,places.websiteUri",
    );

    return (data.places ?? []).map((place: any) => ({
      id: place.id,
      name: place.displayName?.text ?? "Unnamed place",
      address: place.formattedAddress,
      latitude: place.location?.latitude,
      longitude: place.location?.longitude,
      types: Array.isArray(place.types) ? place.types : [],
      rating: typeof place.rating === "number" ? place.rating : undefined,
      priceLevel: place.priceLevel,
      websiteUri: place.websiteUri,
    }));
  },
};
