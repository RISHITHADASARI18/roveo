export type TravelMode = "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT";

export type Coordinates = { latitude: number; longitude: number };
export type RouteRequest = { origin: Coordinates; destination: Coordinates; mode: TravelMode };
export type RouteResult = { provider: "open"; distanceMeters: number; durationSeconds: number; encodedPolyline?: string };
export type PlaceSearchRequest = { textQuery: string; latitude?: number; longitude?: number; radiusMeters?: number; maxResults?: number };
export type TravelPlace = { id: string; name: string; address?: string; latitude?: number; longitude?: number; types: string[]; rating?: number; priceLevel?: string; websiteUri?: string };

export type DiscoveredPlace = {
  id: string;
  name: string;
  type: string;
  group: "Attraction" | "History" | "Nature" | "Culture" | "Activity";
  latitude: number;
  longitude: number;
  distanceKm: number;
  description?: string;
  openingHours?: string;
  website?: string;
  wikipedia?: string;
  address?: string;
};

export type PlaceDiscoveryResult = {
  center: Coordinates;
  places: DiscoveredPlace[];
  nearbyDestinations?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    distanceKm: number;
    type: string;
  }>;
  source: "google" | "openstreetmap";
  fetchedAt: string;
};

export interface TravelProvider {
  computeRoute(request: RouteRequest): Promise<RouteResult>;
  searchPlaces(request: PlaceSearchRequest): Promise<TravelPlace[]>;
}
