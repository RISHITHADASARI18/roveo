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

function categoryDuration(category = "") {
  const value = category.toLowerCase();
  if (/museum|palace|fort|heritage|historic|religious|temple|church|monument/.test(value)) return 105;
  if (/park|garden|beach|nature|waterfall|viewpoint|lake|mountain/.test(value)) return 120;
  if (/activity|amusement|theme|water_park|zoo|aquarium/.test(value)) return 150;
  return 90;
}

function timeLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  return (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
}

function chooseSeeds(places: PlannerPlace[], days: number) {
  const seeds: PlannerPlace[] = [];
  if (!places.length) return seeds;
  const center = centroid(places);
  const centerPoint = { id: "center", name: "", latitude: center.latitude, longitude: center.longitude };
  const first = [...places].sort((a, b) => haversineKm(b, centerPoint) - haversineKm(a, centerPoint))[0];
  seeds.push(first);

  while (seeds.length < Math.min(days, places.length)) {
    let best: PlannerPlace | null = null;
    let bestScore = -1;
    for (const place of places) {
      if (seeds.includes(place)) continue;
      const score = Math.min(...seeds.map((seed) => haversineKm(place, seed)));
      if (score > bestScore) { bestScore = score; best = place; }
    }
    if (!best) break;
    seeds.push(best);
  }
  return seeds;
}

function orderCluster(items: PlannerPlace[]) {
  if (items.length <= 2) return [...items];
  const remaining = [...items];
  const center = centroid(items);
  const centerPoint = { id: "center", name: "", latitude: center.latitude, longitude: center.longitude };
  let current = [...remaining].sort((a, b) => haversineKm(a, centerPoint) - haversineKm(b, centerPoint))[0];
  const ordered = [current];
  remaining.splice(remaining.indexOf(current), 1);

  while (remaining.length) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    remaining.forEach((candidate, index) => {
      const distance = haversineKm(current, candidate);
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
        const currentDistance = haversineKm(a, b) + (d ? haversineKm(c, d) : 0);
        const swappedDistance = haversineKm(a, c) + (d ? haversineKm(b, d) : 0);
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

export function buildSmartItinerary(inputPlaces: PlannerPlace[], dayCount: number): PlannedDay[] {
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

  const seeds = chooseSeeds(places, days);
  seeds.forEach((seed, index) => clusters[index].push(seed));
  const seeded = new Set(seeds.map((place) => place.id));
  const remaining = places.filter((place) => !seeded.has(place.id));
  const target = Math.ceil(places.length / days);

  for (const place of remaining) {
    let bestDay = 0;
    let bestScore = Infinity;
    for (let day = 0; day < days; day += 1) {
      if (clusters[day].length >= target && clusters.some((items) => items.length < target)) continue;
      const center = centroid(clusters[day].length ? clusters[day] : [seeds[day] ?? place]);
      const centerPoint = { id: "centroid", name: "", latitude: center.latitude, longitude: center.longitude };
      const score = haversineKm(place, centerPoint) + clusters[day].length * 0.8;
      if (score < bestScore) { bestScore = score; bestDay = day; }
    }
    clusters[bestDay].push(place);
  }

  return clusters.map((cluster, index) => {
    const ordered = orderCluster(cluster);
    let clock = 9 * 60;
    let totalDistance = 0;

    const items = ordered.map((place, placeIndex) => {
      const previous = ordered[placeIndex - 1];
      const travelTime = previous ? Math.max(10, Math.round(haversineKm(previous, place) * 4)) : 0;
      if (previous) { totalDistance += haversineKm(previous, place); clock += travelTime; }
      const startTime = timeLabel(clock);
      const durationMinutes = categoryDuration(place.category);
      clock += durationMinutes;
      if (placeIndex === 1 && ordered.length >= 3) clock += 45;
      return { ...place, startTime, durationMinutes, travelTimeMinutes: travelTime };
    });

    const maxKm = ordered.length ? Math.max(...ordered.map((place) => haversineKm(place, ordered[0]))) : 0;
    const spread = maxKm > 35 ? "wide" : maxKm > 15 ? "regional" : "nearby";
    const title = index === 0 ? "Start with the " + spread + " highlights" : index === days - 1 ? "Final discoveries nearby" : "Explore one area at a time";
    const reason = ordered.length <= 1
      ? "A light day keeps the trip flexible."
      : spread === "nearby"
        ? "These stops are close together, so more of the day stays available for exploring."
        : spread === "regional"
          ? "These places form a practical local cluster instead of mixing distant sides of the destination."
          : "This day contains the remaining selected places; consider moving one if the area feels too spread out.";

    return { dayNumber: index + 1, title, reason, items, straightLineKm: Math.round(totalDistance * 10) / 10 };
  });
}
