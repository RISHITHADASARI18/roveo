import { googleTravelProvider } from "./google";
import type { TravelProvider } from "./types";

export function getTravelProvider(): TravelProvider {
  return googleTravelProvider;
}

export * from "./types";
