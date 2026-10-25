export type BudgetComponent =
  | "destinationTravel"
  | "accommodation"
  | "localTransport"
  | "food"
  | "activities"
  | "other"
  | "contingency";

export type BudgetDestination = {
  name: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type BudgetPlace = {
  name: string;
  category?: string | null;
};

export type BudgetCalculationInput = {
  days: number;
  people: number;
  budget: number;
  source?: string;
  destination?: string;
  destinations?: BudgetDestination[];
  sourceLatitude?: number | null;
  sourceLongitude?: number | null;
  travelMethod: string;
  localTravelMethod: string;
  stayPreference: string;
  selectedPlaces?: BudgetPlace[];
};

export type BudgetCalculation = {
  items: Record<BudgetComponent, number>;
  subtotal: number;
  total: number;
  budget: number;
  remaining: number;
  currency: "INR";
  confidence: "fallback";
  source: "roveo";
  explanations: Record<BudgetComponent, string>;
  assumptions: string[];
  inputsUsed: {
    destinations: number;
    selectedPlaces: number;
    routeDistanceKm: number | null;
    nights: number;
    people: number;
    days: number;
  };
};

export type BudgetComponentResult = {
  component: BudgetComponent;
  amount: number;
  currency: "INR";
  confidence: "fallback";
  source: "roveo";
};

const round = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
const safeText = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

function validCoordinates(latitude?: number | null, longitude?: number | null) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude! >= -90 && latitude! <= 90 && longitude! >= -180 && longitude! <= 180;
}

function distanceKm(
  a: { latitude?: number | null; longitude?: number | null },
  b: { latitude?: number | null; longitude?: number | null },
): number | null {
  if (!validCoordinates(a.latitude, a.longitude) || !validCoordinates(b.latitude, b.longitude)) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude! - a.latitude!);
  const dLon = radians(b.longitude! - a.longitude!);
  const lat1 = radians(a.latitude!);
  const lat2 = radians(b.latitude!);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function getRouteDistance(input: BudgetCalculationInput): number | null {
  const destinations = (input.destinations ?? []).filter((item) =>
    validCoordinates(item.latitude, item.longitude)
  );
  if (!validCoordinates(input.sourceLatitude, input.sourceLongitude) || destinations.length === 0) return null;

  let outboundDistance = 0;
  let current = { latitude: input.sourceLatitude, longitude: input.sourceLongitude };
  for (const destination of destinations) {
    const leg = distanceKm(current, destination);
    if (leg === null) return null;
    outboundDistance += leg;
    current = { latitude: destination.latitude, longitude: destination.longitude };
  }
  const returnLeg = distanceKm(current, { latitude: input.sourceLatitude, longitude: input.sourceLongitude });
  if (returnLeg === null) return null;
  // Count the inter-destination legs once, then add the final return leg.
  // Straight-line distance is converted to a conservative road/route allowance.
  return Math.round((outboundDistance + returnLeg) * 1.25);
}

function estimateDestinationTravel(input: BudgetCalculationInput, routeDistanceKm: number | null) {
  const method = safeText(input.travelMethod);
  const people = Math.max(1, input.people);
  if (routeDistanceKm === null) {
    // Deliberate fallback when location coordinates are missing: never pretend this is route-priced.
    const perPerson = method.includes("flight") ? 6500
      : method.includes("train") ? 1600
      : method.includes("bus") ? 1200
      : method.includes("bike") ? 700
      : 2200;
    return round(perPerson * people);
  }

  if (method.includes("flight") || method.includes("plane") || method.includes("air")) {
    return round(Math.max(3500, routeDistanceKm * 5.5 / 2) * people);
  }
  if (method.includes("train") || method.includes("rail")) {
    return round(Math.max(150, routeDistanceKm * 1.35 / 2) * people);
  }
  if (method.includes("bus") || method.includes("coach")) {
    return round(Math.max(200, routeDistanceKm * 1.6 / 2) * people);
  }
  if (method.includes("bike") || method.includes("motorcycle")) {
    return round(routeDistanceKm * 3.2);
  }
  if (method.includes("car") || method.includes("drive") || method.includes("own vehicle")) {
    return round(routeDistanceKm * 11);
  }
  // Unknown modes use a conservative per-person intercity allowance.
  return round(Math.max(500, routeDistanceKm * 1.5 / 2) * people);
}

function estimateAccommodation(stayPreference: string, days: number, people: number) {
  const stay = safeText(stayPreference);
  const nights = Math.max(0, days - 1);
  const roomPerNight = stay.includes("hostel") ? 700
    : stay.includes("homestay") || stay.includes("home stay") ? 1800
    : stay.includes("luxury") || stay.includes("resort") ? 5000
    : stay.includes("budget") ? 1200
    : 2500;
  const rooms = Math.max(1, Math.ceil(people / 2));
  return round(roomPerNight * rooms * nights);
}

function estimateLocalTransport(method: string, days: number, people: number) {
  const mode = safeText(method);
  if (mode.includes("walk")) return round(days * 100);
  if (mode.includes("public") || mode.includes("metro") || mode.includes("bus")) {
    return round(days * people * 300);
  }
  if (mode.includes("bike") || mode.includes("scooter")) {
    return round(days * Math.ceil(people / 2) * 600);
  }
  if (mode.includes("taxi") || mode.includes("cab")) return round(days * 1400);
  if (mode.includes("car") || mode.includes("drive")) return round(days * 1800);
  return round(days * (700 + Math.max(0, people - 1) * 250));
}

function estimateFood(destination: string, days: number, people: number) {
  const place = safeText(destination);
  const highCost = /mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|goa|chennai|pune|kolkata|udaipur|shimla|manali/.test(place);
  const moderateCost = /jaipur|agra|kochi|cochin|mysuru|mysore|ooty|munnar|rishikesh|varanasi|pondicherry|puducherry/.test(place);
  const perPersonPerDay = highCost ? 1100 : moderateCost ? 850 : 750;
  return round(perPersonPerDay * days * people);
}

function estimateActivities(days: number, people: number, places: BudgetPlace[]) {
  const unique = new Map<string, BudgetPlace>();
  for (const place of places) {
    const key = safeText(place.name);
    if (key && !unique.has(key)) unique.set(key, place);
  }
  const list = [...unique.values()];
  if (list.length === 0) {
    return { amount: round(500 * Math.min(days, 5) * people), explanation: "No saved places yet; uses a planning allowance of ₹500 per person per sightseeing day." };
  }

  const ticketPerPerson = list.reduce((sum, place) => {
    const category = safeText(place.category);
    const name = safeText(place.name);
    if (/theme park|amusement|water park|zoo|safari|aquarium|adventure|ropeway|cable car|museum|fort|palace|monument|ticket|entry fee/.test(category + " " + name)) {
      if (/theme park|amusement|water park/.test(category + " " + name)) return sum + 1000;
      if (/safari|adventure|ropeway|cable car/.test(category + " " + name)) return sum + 700;
      if (/zoo|aquarium/.test(category + " " + name)) return sum + 350;
      return sum + 250;
    }
    if (/temple|shrine/.test(category + " " + name)) return sum + 50;
    if (/waterfall|viewpoint|beach|nature|park|lake|garden|hiking|trek/.test(category + " " + name)) return sum + 80;
    return sum + 150;
  }, 0);
  // Avoid charging a full ticket for every saved idea when there are more places than trip days.
  const visitsPerPerson = Math.min(list.length, Math.max(days * 3, 1));
  const averagePerVisit = ticketPerPerson / list.length;
  return {
    amount: round(averagePerVisit * visitsPerPerson * people),
    explanation: `Estimated entry/activity costs for ${visitsPerPerson} of ${list.length} saved unique places; free outdoor sights are assigned only a small parking/fee allowance.`,
  };
}

export function calculateBudgetComponents(input: BudgetCalculationInput): BudgetComponentResult[] {
  const routeDistanceKm = getRouteDistance(input);
  const places = input.selectedPlaces ?? [];
  const destination = input.destinations?.[0]?.name || input.destination || "";
  const destinationTravel = estimateDestinationTravel(input, routeDistanceKm);
  const accommodation = estimateAccommodation(input.stayPreference, input.days, input.people);
  const localTransport = estimateLocalTransport(input.localTravelMethod, input.days, input.people);
  const food = estimateFood(destination, input.days, input.people);
  const activityEstimate = estimateActivities(input.days, input.people, places);
  const activities = activityEstimate.amount;
  const other = round((destinationTravel + accommodation + localTransport + food + activities) * 0.05);
  const subtotal = round(destinationTravel + accommodation + localTransport + food + activities + other);
  const contingency = round(subtotal * 0.1);

  return [
    ["destinationTravel", destinationTravel],
    ["accommodation", accommodation],
    ["localTransport", localTransport],
    ["food", food],
    ["activities", activities],
    ["other", other],
    ["contingency", contingency],
  ].map(([component, amount]) => ({
    component: component as BudgetComponent,
    amount: Number(amount),
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
  }));
}

export function calculateBudget(input: BudgetCalculationInput): BudgetCalculation {
  const components = calculateBudgetComponents(input);
  const items = Object.fromEntries(components.map((component) => [component.component, component.amount])) as Record<BudgetComponent, number>;
  const subtotal = round(items.destinationTravel + items.accommodation + items.localTransport + items.food + items.activities + items.other);
  const total = round(subtotal + items.contingency);
  const routeDistanceKm = getRouteDistance(input);
  const places = input.selectedPlaces ?? [];
  const uniquePlaces = new Map(places.filter((place) => safeText(place.name)).map((place) => [safeText(place.name), place]));
  const destinationName = input.destinations?.[0]?.name || input.destination || "the destination";
  const explanations: Record<BudgetComponent, string> = {
    destinationTravel: routeDistanceKm === null
      ? "Estimated round-trip fare based on your selected travel mode; route coordinates were unavailable, so this uses a broad fallback allowance."
      : `Estimated round-trip ${safeText(input.travelMethod) || "travel"} cost for ${input.people} traveller(s), using about ${routeDistanceKm.toLocaleString("en-IN")} km of road-adjusted route distance. This is not a live fare quote.`,
    accommodation: `${Math.max(0, input.days - 1)} night(s), ${Math.max(1, Math.ceil(input.people / 2))} room(s), using a typical nightly rate for “${input.stayPreference}”. Live accommodation pricing may replace this when available.`,
    localTransport: `Estimated local transport for ${input.days} day(s) using “${input.localTravelMethod}”, scaled for ${input.people} traveller(s) where applicable.`,
    food: `Estimated meals for ${input.people} traveller(s) across ${input.days} day(s), using a typical daily food allowance for ${destinationName}; actual restaurant choices will change this.`,
    activities: estimateActivities(input.days, input.people, [...uniquePlaces.values()]).explanation,
    other: "Includes a 5% allowance for parking, small purchases, tips and incidental costs.",
    contingency: "A 10% reserve calculated on the estimated subtotal for unexpected costs.",
  };
  const assumptions = [
    "All amounts are estimates in Indian rupees (INR), not guaranteed quotes.",
    "Intercity fares, meals, local transport and attraction tickets can change by date, season, provider and traveller age.",
    "The route distance is estimated from saved destination coordinates and adjusted upward from straight-line distance; it is not a turn-by-turn route.",
    "Accommodation is based on typical room rates unless the response identifies a live provider price.",
    uniquePlaces.size
      ? `Activities consider ${uniquePlaces.size} unique saved place(s); only a trip-day-limited number of visits are budgeted.`
      : "No saved places were found, so activities use a per-day planning allowance until places are selected.",
  ];
  return {
    items,
    subtotal,
    total,
    budget: round(input.budget),
    remaining: round(input.budget - total),
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
    explanations,
    assumptions,
    inputsUsed: {
      destinations: input.destinations?.length || 1,
      selectedPlaces: uniquePlaces.size,
      routeDistanceKm,
      nights: Math.max(0, input.days - 1),
      people: input.people,
      days: input.days,
    },
  };
}
