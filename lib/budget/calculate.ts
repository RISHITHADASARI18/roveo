export type BudgetCalculationInput = {
  days: number;
  people: number;
  budget: number;
  travelMethod: string;
  localTravelMethod: string;
  stayPreference: string;
};

export type BudgetCalculation = {
  items: {
    destinationTravel: number;
    accommodation: number;
    localTransport: number;
    food: number;
    activities: number;
    other: number;
    contingency: number;
  };
  subtotal: number;
  total: number;
  budget: number;
  remaining: number;
  currency: "INR";
  confidence: "fallback";
  source: "roveo";
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function estimateDestinationTravel(method: string, people: number) {
  const m = method.toLowerCase();
  const perPerson = m.includes("flight")
    ? 6500
    : m.includes("train")
      ? 1600
      : m.includes("bus")
        ? 1200
        : 2200;
  return perPerson * people;
}

function estimateAccommodation(stay: string, days: number, people: number) {
  const nights = Math.max(0, days - 1);
  const s = stay.toLowerCase();
  const roomPerNight = s.includes("hostel")
    ? 700
    : s.includes("homestay")
      ? 1800
      : s.includes("other")
        ? 1500
        : 2500;

  return roomPerNight * Math.max(1, Math.ceil(people / 2)) * nights;
}

function estimateLocalTransport(method: string, days: number) {
  const m = method.toLowerCase();
  const daily = m.includes("walking")
    ? 100
    : m.includes("public")
      ? 350
      : m.includes("bike")
        ? 600
        : m.includes("taxi")
          ? 1200
          : 900;

  return daily * days;
}

export function calculateBudget(input: BudgetCalculationInput): BudgetCalculation {
  const destinationTravel = estimateDestinationTravel(input.travelMethod, input.people);
  const accommodation = estimateAccommodation(
    input.stayPreference,
    input.days,
    input.people,
  );
  const localTransport = estimateLocalTransport(
    input.localTravelMethod,
    input.days,
  );
  const food = 900 * input.days * input.people;
  const activities = 500 * Math.max(1, Math.min(input.days, 5)) * input.people;
  const other = 0;

  const subtotal = round(
    destinationTravel +
      accommodation +
      localTransport +
      food +
      activities +
      other,
  );
  const contingency = round(subtotal * 0.1);
  const total = round(subtotal + contingency);

  return {
    items: {
      destinationTravel: round(destinationTravel),
      accommodation: round(accommodation),
      localTransport: round(localTransport),
      food: round(food),
      activities: round(activities),
      other,
      contingency,
    },
    subtotal,
    total,
    budget: round(input.budget),
    remaining: round(input.budget - total),
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
  };
}
