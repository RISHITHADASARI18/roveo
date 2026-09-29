export type BudgetCalculationInput = {
  days: number;
  people: number;
  budget: number;
  travelMethod: string;
  localTravelMethod: string;
  stayPreference: string;
};

export type BudgetComponent =
  | "destinationTravel"
  | "accommodation"
  | "localTransport"
  | "food"
  | "activities"
  | "other"
  | "contingency";

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

export type BudgetComponentResult = {
  component: BudgetComponent;
  amount: number;
  currency: "INR";
  confidence: "fallback";
  source: "roveo";
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculateDestinationTravel(method: string, people: number) {
  const m = method.toLowerCase();
  const perPerson = m.includes("flight")
    ? 6500
    : m.includes("train")
      ? 1600
      : m.includes("bus")
        ? 1200
        : 2200;
  return round(perPerson * people);
}

export function calculateAccommodation(stay: string, days: number, people: number) {
  const nights = Math.max(0, days - 1);
  const s = stay.toLowerCase();
  const roomPerNight = s.includes("hostel")
    ? 700
    : s.includes("homestay")
      ? 1800
      : s.includes("other")
        ? 1500
        : 2500;

  return round(roomPerNight * Math.max(1, Math.ceil(people / 2)) * nights);
}

export function calculateLocalTransport(method: string, days: number) {
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

  return round(daily * days);
}

export function calculateFood(days: number, people: number) {
  return round(900 * days * people);
}

export function calculateActivities(days: number, people: number) {
  return round(500 * Math.max(1, Math.min(days, 5)) * people);
}

export function calculateOther() {
  return 0;
}

export function calculateContingency(subtotal: number) {
  return round(subtotal * 0.1);
}

export function calculateBudgetComponents(
  input: BudgetCalculationInput,
): BudgetComponentResult[] {
  const destinationTravel = calculateDestinationTravel(input.travelMethod, input.people);
  const accommodation = calculateAccommodation(
    input.stayPreference,
    input.days,
    input.people,
  );
  const localTransport = calculateLocalTransport(
    input.localTravelMethod,
    input.days,
  );
  const food = calculateFood(input.days, input.people);
  const activities = calculateActivities(input.days, input.people);
  const other = calculateOther();
  const subtotal = round(
    destinationTravel +
      accommodation +
      localTransport +
      food +
      activities +
      other,
  );
  const contingency = calculateContingency(subtotal);

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
  const items = {
    destinationTravel: components.find((x) => x.component === "destinationTravel")!.amount,
    accommodation: components.find((x) => x.component === "accommodation")!.amount,
    localTransport: components.find((x) => x.component === "localTransport")!.amount,
    food: components.find((x) => x.component === "food")!.amount,
    activities: components.find((x) => x.component === "activities")!.amount,
    other: components.find((x) => x.component === "other")!.amount,
    contingency: components.find((x) => x.component === "contingency")!.amount,
  };

  const subtotal = round(
    items.destinationTravel +
      items.accommodation +
      items.localTransport +
      items.food +
      items.activities +
      items.other,
  );
  const total = round(subtotal + items.contingency);

  return {
    items,
    subtotal,
    total,
    budget: round(input.budget),
    remaining: round(input.budget - total),
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
  };
}
