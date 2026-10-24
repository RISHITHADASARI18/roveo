export type StayDates = { checkIn: string; checkOut: string; nights: number } | null;

export function normalizeDateOnly(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\\d{4}-\\d{2}-\\d{2})(?:T.*)?$/);
  return match ? match[1] : null;
}

export function accommodationNights(days: number): number {
  const parsed = Number(days);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed) - 1);
}

export function stayDates(startDate: string, days: number): StayDates {
  const nights = accommodationNights(days);
  if (nights < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const checkInDate = new Date(startDate + "T00:00:00.000Z");
  if (!Number.isFinite(checkInDate.getTime()) || checkInDate.toISOString().slice(0, 10) !== startDate) return null;
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setUTCDate(checkOutDate.getUTCDate() + nights);
  return { checkIn: startDate, checkOut: checkOutDate.toISOString().slice(0, 10), nights };
}

export function estimateDestinationTravelCost(method: string, people: number, roundTripKm: number): number | null {
  if (!(roundTripKm > 0)) return null;
  const travellers = Math.max(1, Math.floor(Number(people) || 1));
  const mode = method.toLowerCase();
  if (/flight|air/.test(mode)) return Math.round(Math.max(3000, roundTripKm * 2.7 + 2000) * travellers);
  if (/train|rail/.test(mode)) return Math.round(Math.max(300, roundTripKm * 0.7 + 250) * travellers);
  if (/bus|coach/.test(mode)) return Math.round(Math.max(250, roundTripKm * 1.05 + 200) * travellers);
  if (/public transport|public transit/.test(mode)) return Math.round(Math.max(250, roundTripKm * 0.8 + 200) * travellers);
  if (/taxi|cab/.test(mode)) return Math.round(roundTripKm * 22 + 500);
  if (/car|self.?drive/.test(mode)) return Math.round(roundTripKm * 12 + 300);
  return null;
}

function localModeCost(mode: string, days: number, people: number, routeKm: number): number | null {
  if (/taxi|cab/.test(mode)) return routeKm > 0 ? Math.round(routeKm * 22 + days * 200) : Math.round(1200 * days);
  if (/car|self.?drive/.test(mode)) return routeKm > 0 ? Math.round(routeKm * 11 + days * 150) : Math.round(900 * days);
  if (/bike|scooter/.test(mode)) return routeKm > 0 ? Math.round(routeKm * 5 + days * 100) : Math.round(600 * days);
  if (/public|bus|metro|train/.test(mode)) return Math.round(350 * people * days);
  if (/walk/.test(mode)) return Math.round(100 * people * days);
  return null;
}

/** Multiple local modes are alternatives, not separate journeys to charge in full. */
export function estimateLocalTransportCost(method: string, days: number, people: number, routeKm: number): number {
  const safeDays = Math.max(1, Math.floor(Number(days) || 1));
  const safePeople = Math.max(1, Math.floor(Number(people) || 1));
  const modes = [...new Set(method.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const costs = modes.map((mode) => localModeCost(mode, safeDays, safePeople, Math.max(0, routeKm))).filter((cost): cost is number => cost !== null);
  if (!costs.length) return routeKm > 0 ? Math.round(routeKm * 22 + safeDays * 200) : Math.round(900 * safeDays);
  return Math.round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length);
}