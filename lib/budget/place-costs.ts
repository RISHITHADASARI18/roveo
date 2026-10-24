export type PlaceForCost = {
  name: string;
  category?: string | null;
};

export type PlaceCostLine = {
  name: string;
  category: string;
  ticketCostPerPerson: number | null;
  minCostPerPerson: number | null;
  maxCostPerPerson: number | null;
  people: number;
  total: number | null;
  minTotal: number | null;
  maxTotal: number | null;
  label: string;
  confidence: "official-range" | "unknown";
  sourceUrl?: string;
  priceNote?: string;
};

type PriceRule = {
  min: number;
  max: number;
  label: string;
  sourceUrl: string;
  note: string;
};

function officialTicketPrice(place: PlaceForCost): PriceRule | null {
  const name = place.name.toLowerCase();

  // Prices are published ranges from official tourism/venue sources, not a promise
  // that the selected date/package will cost exactly this amount.
  if (/ramoji/.test(name)) {
    return {
      min: 1550,
      max: 1650,
      label: "Adult studio-tour ticket range; GST/package/date may change final price",
      sourceUrl: "https://booking.ramojifilmcity.com/daytour/packages",
      note: "Official booking page lists weekday and weekend package prices; verify the selected date and package.",
    };
  }
  if (/wonderla/.test(name)) {
    return {
      min: 815,
      max: 1260,
      label: "Adult entry-ticket range",
      sourceUrl: "https://tourism.telangana.gov.in/customized-wonderla-detailed-view",
      note: "Telangana Tourism publishes an adult-ticket range; the venue's selected-date checkout is the final price.",
    };
  }
  return null;
}

export function estimatePlaceCosts(places: PlaceForCost[], people: number) {
  const travellerCount = Math.max(1, Math.floor(Number(people) || 1));
  const lines: PlaceCostLine[] = places.map((place) => {
    const price = officialTicketPrice(place);
    const midpoint = price ? Math.round((price.min + price.max) / 2) : null;
    return {
      name: place.name,
      category: String(place.category ?? "Place"),
      ticketCostPerPerson: midpoint,
      minCostPerPerson: price?.min ?? null,
      maxCostPerPerson: price?.max ?? null,
      people: travellerCount,
      total: midpoint === null ? null : midpoint * travellerCount,
      minTotal: price ? price.min * travellerCount : null,
      maxTotal: price ? price.max * travellerCount : null,
      label: price?.label ?? "No trustworthy ticket price found for this place",
      confidence: price ? "official-range" : "unknown",
      sourceUrl: price?.sourceUrl,
      priceNote: price?.note,
    };
  });

  const pricedLines = lines.filter((line) => line.total !== null);
  const total = pricedLines.reduce((sum, line) => sum + (line.total ?? 0), 0);
  const minTotal = pricedLines.reduce((sum, line) => sum + (line.minTotal ?? 0), 0);
  const maxTotal = pricedLines.reduce((sum, line) => sum + (line.maxTotal ?? 0), 0);
  return {
    places: lines,
    pricedPlaceCount: pricedLines.length,
    unpricedPlaceCount: lines.length - pricedLines.length,
    total,
    minTotal,
    maxTotal,
    source: "Official published ranges where available; unverified places are left unpriced instead of guessed.",
    pricingMethod: "Adult ticket planning ranges only; check child/senior discounts, taxes, package, and selected date with the venue.",
  };
}
