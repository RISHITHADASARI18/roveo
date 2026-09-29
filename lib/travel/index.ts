import { openTravelProvider } from "./open";
import type { TravelProvider } from "./types";

export function getTravelProvider(): TravelProvider {
  return openTravelProvider;
}

export * from "./types";
