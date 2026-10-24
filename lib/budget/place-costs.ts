export type PlaceForCost = {
  name: string;
  category?: string | null;
};

export type PlaceCostLine = {
  name: string;
  category: string;
  ticketCostPerPerson: number | null;
  people: number;
  total: number | null;
  label: string;
  confidence: "planning-estimate" | "unknown";
};

function ticketPrice(place: PlaceForCost): { amount: number | null; label: string } {
  const name = place.name.toLowerCase();
  const category = String(place.category ?? "").toLowerCase();
  const text = name + " " + category;

  if (/ramoji/.test(name)) return { amount: 1600, label: "Ramoji Film City planning estimate" };
  if (/wonderla/.test(name)) return { amount: 1400, label: "Wonderla planning estimate" };
  if (/water ?park|theme park|amusement park|adventure park/.test(text)) return { amount: 1200, label: "Park entry planning estimate" };
  if (/zoo|zoological/.test(text)) return { amount: 100, label: "Zoo entry planning estimate" };
  if (/aquarium|oceanarium/.test(text)) return { amount: 300, label: "Aquarium entry planning estimate" };
  if (/museum|science centre|science center/.test(text)) return { amount: 100, label: "Museum entry planning estimate" };
  if (/fort|palace|monument|memorial/.test(text)) return { amount: 150, label: "Heritage entry planning estimate" };
  if (/boat ride|boating|ropeway|cable car|safari/.test(text)) return { amount: 400, label: "Experience planning estimate" };

  if (/waterfall|viewpoint|view point|beach|lakefront|lake view|temple|church|mosque|gurudwara|garden|nature reserve|nature trail|public park/.test(text)) {
    return { amount: 0, label: "Usually free public-access place; verify locally" };
  }

  if (/attraction|tourist|sightseeing|ticket|entry|experience|adventure/.test(text)) {
    return { amount: 250, label: "General entry planning estimate" };
  }

  return { amount: null, label: "Ticket price not available; check the official venue" };
}

export function estimatePlaceCosts(places: PlaceForCost[], people: number) {
  const travellerCount = Math.max(1, Math.floor(Number(people) || 1));
  const lines: PlaceCostLine[] = places.map((place) => {
    const price = ticketPrice(place);
    const amount = price.amount;
    return {
      name: place.name,
      category: String(place.category ?? "Place"),
      ticketCostPerPerson: amount,
      people: travellerCount,
      total: amount === null ? null : amount * travellerCount,
      label: price.label,
      confidence: amount === null ? "unknown" : "planning-estimate",
    };
  });

  const pricedLines = lines.filter((line) => line.total !== null);
  const total = pricedLines.reduce((sum, line) => sum + (line.total ?? 0), 0);
  return {
    places: lines,
    pricedPlaceCount: pricedLines.length,
    unpricedPlaceCount: lines.length - pricedLines.length,
    total,
    source: "Roveo planning estimates; venue prices and free-entry status must be verified",
  };
}
