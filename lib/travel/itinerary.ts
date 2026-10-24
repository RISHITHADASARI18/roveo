import type { PlannerPlace } from "./itinerary-types";

export type PlannedPlace = PlannerPlace & {
  startTime: string;
  durationMinutes: number;
  travelTimeMinutes: number;
};

export type PlannedDay = {
  dayNumber: number;
  title: string;
  reason: string;
  items: PlannedPlace[];
  straightLineKm: number;
};

function haversineKm(a: PlannerPlace, b: PlannerPlace) {
  const p = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * p;
  const dLon = (b.longitude - a.longitude) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * p) * Math.cos(b.latitude * p) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function centroid(items: PlannerPlace[]) {
  if (!items.length) return { latitude: 0, longitude: 0 };
  return {
    latitude: items.reduce((sum, item) => sum + item.latitude, 0) / items.length,
    longitude: items.reduce((sum, item) => sum + item.longitude, 0) / items.length,
  };
}

function categoryDuration(place: PlannerPlace) {
  if (typeof place.visitDurationMinutes === "number" && Number.isFinite(place.visitDurationMinutes)) {
    return Math.max(30, Math.min(720, Math.round(place.visitDurationMinutes)));
  }
  const name = place.name.toLowerCase();
  const value = (place.category ?? "").toLowerCase() + " " + name;
  // These attractions are destination-scale experiences, not quick stops.
  // Keep their time blocks large enough that the planner reserves a day for them.
  if (/ramoji\s*(film|film city)|ramoji film city/.test(name)) return 480;
  if (/wonderla/.test(name)) return 420;
  if (/universal studios|disneyland|disney world|imagica|adlabs/.test(name)) return 480;
  if (/full.?day|safari|national park|wildlife sanctuary/.test(value)) return 360;
  if (/museum|palace|fort|heritage|historic|religious|temple|church|monument/.test(value)) return 105;
  if (/park|garden|beach|nature|waterfall|viewpoint|lake|mountain/.test(value)) return 120;
  if (/activity|amusement|theme|water_park|water park|zoo|aquarium/.test(value)) return 180;
  return 90;
}

function isFullDayAttraction(place: PlannerPlace) {
  return categoryDuration(place) >= 360;
}

function openingWindow(place: PlannerPlace) {
  const hours = place.openingHours ?? "";
  // Supports common OSM/Google display strings such as "Mo-Su 10:00-19:00".
  // If a provider returns a more complex weekly schedule, keep the safe default.
  const match = hours.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const open = Number(match[1]) * 60 + Number(match[2]);
  const close = Number(match[3]) * 60 + Number(match[4]);
  if (open < 0 || close <= open || close > 24 * 60) return null;
  return { open, close };
}

function timeLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  return (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
}

type PlannerMetrics = {
  distanceKm: (a: PlannerPlace, b: PlannerPlace) => number;
  travelMinutes?: (a: PlannerPlace, b: PlannerPlace) => number;
};

function chooseSeeds(places: PlannerPlace[], days: number, distanceKm: PlannerMetrics["distanceKm"]) {
  const seeds: PlannerPlace[] = [];
  if (!places.length || days <= 0) return seeds;
  const center = centroid(places);
  const centerPoint = { id: "center", name: "", latitude: center.latitude, longitude: center.longitude };
  const first = [...places].sort((a, b) => distanceKm(b, centerPoint) - distanceKm(a, centerPoint))[0];
  seeds.push(first);

  while (seeds.length < Math.min(days, places.length)) {
    let best: PlannerPlace | null = null;
    let bestScore = -1;
    for (const place of places) {
      if (seeds.includes(place)) continue;
      const score = Math.min(...seeds.map((seed) => distanceKm(place, seed)));
      if (score > bestScore) { bestScore = score; best = place; }
    }
    if (!best) break;
    seeds.push(best);
  }
  return seeds;
}

function orderCluster(items: PlannerPlace[], distanceKm: PlannerMetrics["distanceKm"]) {
  if (items.length <= 2) return [...items];
  const remaining = [...items];
  const center = centroid(items);
  const centerPoint = { id: "center", name: "", latitude: center.latitude, longitude: center.longitude };
  let current = [...remaining].sort((a, b) => distanceKm(a, centerPoint) - distanceKm(b, centerPoint))[0];
  const ordered = [current];
  remaining.splice(remaining.indexOf(current), 1);

  while (remaining.length) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    remaining.forEach((candidate, index) => {
      const distance = distanceKm(current, candidate);
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
    });
    current = remaining.splice(nearestIndex, 1)[0];
    ordered.push(current);
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ordered.length - 2; i += 1) {
      for (let j = i + 2; j < ordered.length; j += 1) {
        const a = ordered[i], b = ordered[i + 1], c = ordered[j], d = ordered[j + 1];
        const currentDistance = distanceKm(a, b) + (d ? distanceKm(c, d) : 0);
        const swappedDistance = distanceKm(a, c) + (d ? distanceKm(b, d) : 0);
        if (swappedDistance + 0.05 < currentDistance) {
          const reversed = ordered.slice(i + 1, j + 1).reverse();
          ordered.splice(i + 1, reversed.length, ...reversed);
          improved = true;
        }
      }
    }
  }
  return ordered;
}

export function buildSmartItinerary(inputPlaces: PlannerPlace[], dayCount: number, metrics?: PlannerMetrics): PlannedDay[] {
  const distanceKm = metrics?.distanceKm ?? haversineKm;
  const travelMinutes = metrics?.travelMinutes ?? ((a: PlannerPlace, b: PlannerPlace) => Math.max(10, Math.round(distanceKm(a, b) * 4)));
  const places = inputPlaces.filter((place, index, all) =>
    Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude) &&
    place.name.trim() &&
    all.findIndex((candidate) => candidate.id === place.id) === index
  );

  const days = Math.max(1, Math.min(30, Math.floor(dayCount) || 1));
  const clusters: PlannerPlace[][] = Array.from({ length: days }, () => []);

  if (!places.length) {
    return clusters.map((_, index) => ({
      dayNumber: index + 1,
      title: index === 0 ? "Arrival & local discovery" : "Free day",
      reason: "No places have been selected for this day yet.",
      items: [],
      straightLineKm: 0,
    }));
  }

  // A full-day attraction (for example Ramoji Film City or Wonderla) reserves
  // its own day whenever the trip has enough days. Never put it at 2 PM after
  // several short stops simply because it is geographically close to them.
  const fullDayPlaces = places.filter(isFullDayAttraction);
  const reservedFullDay = fullDayPlaces.slice(0, days);
  reservedFullDay.forEach((place, index) => clusters[index].push(place));
  const fullDayIds = new Set(fullDayPlaces.map((place) => place.id));
  const regularPlaces = places.filter((place) => !fullDayIds.has(place.id));
  const freeDayIndexes = clusters.map((cluster, index) => cluster.length ? -1 : index).filter((index) => index >= 0);
  const seeds = chooseSeeds(regularPlaces, freeDayIndexes.length, distanceKm);
  seeds.forEach((seed, index) => clusters[freeDayIndexes[index]].push(seed));
  const seeded = new Set([...reservedFullDay.map((place) => place.id), ...seeds.map((place) => place.id)]);
  // If there are more full-day attractions than trip days, keep every selected
  // attraction rather than silently dropping one; the day reason flags the conflict.
  const remaining = places.filter((place) => !seeded.has(place.id));
  // Balance sightseeing workload as well as geographic proximity. A day with
  // several long activities should not receive the same number of stops as a
  // day containing short viewpoints. Keep every selected place, but penalize
  // days that would become impractically long.
  const estimatedDuration = (place: PlannerPlace) => categoryDuration(place);
  const dayWorkload = (items: PlannerPlace[]) => items.reduce((sum, place, index) =>
    sum + estimatedDuration(place) + (index > 0 ? travelMinutes(items[index - 1], place) : 0), 0
  );

  for (const place of remaining) {
    let bestDay = 0;
    let bestScore = Infinity;
    for (let day = 0; day < days; day += 1) {
      const current = clusters[day];
      // Avoid assigning ordinary stops to a day already reserved for a full-day attraction.
      if (current.some(isFullDayAttraction) && !isFullDayAttraction(place)) continue;
      const center = centroid(current.length ? current : [seeds[day] ?? place]);
      const centerPoint = { id: "centroid", name: "", latitude: center.latitude, longitude: center.longitude };
      const proximity = distanceKm(place, centerPoint);
      const workload = dayWorkload(current);
      const addedTravel = current.length
        ? Math.min(...current.map((existing) => travelMinutes(place, existing)))
        : 0;
      const projectedMinutes = workload + estimatedDuration(place) + addedTravel;
      const overloadPenalty = Math.max(0, projectedMinutes - 480) * 0.12;
      const countPenalty = current.length * 1.5;
      const score = proximity + countPenalty + overloadPenalty;
      if (score < bestScore) { bestScore = score; bestDay = day; }
    }
    clusters[bestDay].push(place);
  }

  return clusters.map((cluster, index) => {
    const ordered = orderCluster(cluster, distanceKm);
    let clock = 9 * 60;
    let totalDistance = 0;

    const items = ordered.map((place, placeIndex) => {
      const previous = ordered[placeIndex - 1];
      const travelTime = previous ? travelMinutes(previous, place) : 0;
      if (previous) { totalDistance += distanceKm(previous, place); clock += travelTime; }
      const durationMinutes = categoryDuration(place);
      const window = openingWindow(place);
      if (window && clock < window.open) clock = window.open;
      const startTime = timeLabel(clock);
      clock += durationMinutes;
      if (placeIndex === 1 && ordered.length >= 3) clock += 45;
      return { ...place, startTime, durationMinutes, travelTimeMinutes: travelTime };
    });

    const maxKm = ordered.length ? Math.max(...ordered.map((place) => distanceKm(place, ordered[0]))) : 0;
    const spread = maxKm > 35 ? "wide" : maxKm > 15 ? "regional" : "nearby";
    const title = index === 0 ? "Start with the " + spread + " highlights" : index === days - 1 ? "Final discoveries nearby" : "Explore one area at a time";
    const estimatedMinutes = items.reduce((sum, place) => sum + place.durationMinutes + place.travelTimeMinutes, 0);
    const hasFullDay = ordered.some(isFullDayAttraction);
    const fullDayConflict = ordered.filter(isFullDayAttraction).length > 1;
    const outsideOpeningHours = items.some((place) => {
      const window = openingWindow(place);
      if (!window) return false;
      const start = (() => { const match = place.startTime.match(/^(\d+):(\d{2}) (AM|PM)$/); if (!match) return 0; let hour = Number(match[1]) % 12; if (match[3] === "PM") hour += 12; return hour * 60 + Number(match[2]); })();
      return start + place.durationMinutes > window.close;
    });
    const reason = fullDayConflict
      ? "Multiple full-day attractions were selected for one day, but each normally needs its own day. Add trip days or move an attraction."
      : hasFullDay && ordered.length > 1
        ? "A full-day attraction is grouped with other stops because the trip has too few free days. Give it a dedicated day for a realistic schedule."
        : outsideOpeningHours
          ? "At least one visit may extend beyond its listed opening hours. Check the venue's current schedule before travelling."
          : estimatedMinutes > 600
            ? "This is a packed day (about " + Math.round(estimatedMinutes / 60) + " hours of visits and estimated transfers). Consider moving a place to another day."
      : ordered.length <= 1
        ? "A light day keeps the trip flexible."
        : spread === "nearby"
          ? "These stops are close together, so more of the day stays available for exploring."
          : spread === "regional"
            ? "These places form a practical local cluster instead of mixing distant sides of the destination."
            : "This day contains the remaining selected places; consider moving one if the area feels too spread out.";

    return { dayNumber: index + 1, title, reason, items, straightLineKm: Math.round(totalDistance * 10) / 10 };
  });
}
