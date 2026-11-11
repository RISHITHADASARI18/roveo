export type BudgetCalculationInput = {
  days: number;
  people: number;
  budget: number;
  destination?: string;
  travelMethod: string;
  localTravelMethod: string;
  stayPreference: string;
};
export type BudgetComponent = "destinationTravel" | "accommodation" | "localTransport" | "food" | "activities" | "other" | "contingency";
export type BudgetCalculation = {
  items: { destinationTravel: number; accommodation: number; localTransport: number; food: number; activities: number; other: number; contingency: number };
  subtotal: number; total: number; budget: number; remaining: number; currency: "INR"; confidence: "fallback"; source: "roveo";
};
export type BudgetComponentResult = { component: BudgetComponent; amount: number; currency: "INR"; confidence: "fallback"; source: "roveo" };

type DestinationCostProfile = { foodPerPersonPerDay: number; hotelRoomPerNight: number; hostelPerNight: number; homestayPerNight: number; activityPerPersonPerDay: number; };
const PREMIUM_DESTINATIONS = /mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|goa|chennai|pune|kolkata|jaipur|udaipur|shimla|manali|munnar|ooty|coorg|rishikesh/;
const LOWER_COST_DESTINATIONS = /varanasi|prayagraj|allahabad|guntur|vijayawada|warangal|tirupati|madurai|mysuru|mysore|puri|nashik|amritsar|indore|bhopal/;

function round(value: number) { return Math.round(value * 100) / 100; }
function destinationProfile(destination = ""): DestinationCostProfile {
  const name = destination.toLowerCase();
  if (PREMIUM_DESTINATIONS.test(name)) {
    return { foodPerPersonPerDay: 700, hotelRoomPerNight: 2200, hostelPerNight: 750, homestayPerNight: 1600, activityPerPersonPerDay: 400 };
  }
  if (LOWER_COST_DESTINATIONS.test(name)) {
    return { foodPerPersonPerDay: 400, hotelRoomPerNight: 1200, hostelPerNight: 450, homestayPerNight: 900, activityPerPersonPerDay: 220 };
  }
  return { foodPerPersonPerDay: 525, hotelRoomPerNight: 1650, hostelPerNight: 600, homestayPerNight: 1200, activityPerPersonPerDay: 300 };
}

export function calculateDestinationTravel(method: string, people: number) {
  const mode = method.toLowerCase();
  const perPerson = /flight|air/.test(mode) ? 6500 : /train|rail/.test(mode) ? 1200 : /bus|coach/.test(mode) ? 850 : 1600;
  return round(perPerson * people);
}
export function calculateAccommodation(stay: string, days: number, people: number, destination = "") {
  const profile = destinationProfile(destination);
  const nights = Math.max(0, Math.floor(days) - 1);
  const preference = stay.toLowerCase();
  const roomRate = /hostel|dorm/.test(preference) ? profile.hostelPerNight
    : /homestay|guesthouse/.test(preference) ? profile.homestayPerNight
    : profile.hotelRoomPerNight;
  return round(roomRate * Math.max(1, Math.ceil(people / 2)) * nights);
}
export function calculateLocalTransport(method: string, days: number, people = 1) {
  const modes = [...new Set(method.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const dailyCosts = modes.map((mode) => /walk/.test(mode) ? 80 * people
    : /public|bus|metro|train/.test(mode) ? 180 * people
    : /bike|scooter/.test(mode) ? 450
    : /taxi|cab/.test(mode) ? 700
    : /car|self.?drive/.test(mode) ? 750 : 650);
  const daily = dailyCosts.length ? dailyCosts.reduce((sum, value) => sum + value, 0) / dailyCosts.length : 650;
  return round(daily * Math.max(1, days));
}
export function calculateFood(days: number, people: number, destination = "", stayPreference = "") {
  const profile = destinationProfile(destination);
  const stay = stayPreference.toLowerCase();
  const multiplier = /hostel|budget|backpack/.test(stay) ? 0.75 : /luxury|resort|premium/.test(stay) ? 1.5 : 1;
  return round(profile.foodPerPersonPerDay * multiplier * Math.max(1, days) * Math.max(1, people));
}
export function calculateActivities(days: number, people: number, destination = "") {
  return round(destinationProfile(destination).activityPerPersonPerDay * Math.max(1, Math.min(days, 5)) * Math.max(1, people));
}
export function calculateOther() { return 0; }
export function calculateContingency(subtotal: number) { return round(subtotal * 0.08); }

export function calculateBudgetComponents(input: BudgetCalculationInput): BudgetComponentResult[] {
  const destinationTravel = calculateDestinationTravel(input.travelMethod, input.people);
  const accommodation = calculateAccommodation(input.stayPreference, input.days, input.people, input.destination);
  const localTransport = calculateLocalTransport(input.localTravelMethod, input.days, input.people);
  const food = calculateFood(input.days, input.people, input.destination, input.stayPreference);
  const activities = calculateActivities(input.days, input.people, input.destination);
  const other = calculateOther();
  const subtotal = round(destinationTravel + accommodation + localTransport + food + activities + other);
  const contingency = calculateContingency(subtotal);
  return [["destinationTravel", destinationTravel], ["accommodation", accommodation], ["localTransport", localTransport],
    ["food", food], ["activities", activities], ["other", other], ["contingency", contingency]]
    .map(([component, amount]) => ({ component: component as BudgetComponent, amount: Number(amount), currency: "INR", confidence: "fallback", source: "roveo" }));
}
export function calculateBudget(input: BudgetCalculationInput): BudgetCalculation {
  const components = calculateBudgetComponents(input);
  const items = Object.fromEntries(components.map((item) => [item.component, item.amount])) as BudgetCalculation["items"];
  const subtotal = round(items.destinationTravel + items.accommodation + items.localTransport + items.food + items.activities + items.other);
  const total = round(subtotal + items.contingency);
  return { items, subtotal, total, budget: round(input.budget), remaining: round(input.budget - total), currency: "INR", confidence: "fallback", source: "roveo" };
}
