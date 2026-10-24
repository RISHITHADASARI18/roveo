export type RouteTravelMode = "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT";

/** Pick a routeable mode from the user's comma-separated local travel choices. */
export function modeFromLocalTravelMethod(value: string): RouteTravelMode | null {
  const choices = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const mapped = choices.map((choice) => {
    if (choice === "car" || choice === "taxi") return "DRIVE" as const;
    if (choice === "walking" || choice === "walk") return "WALK" as const;
    if (choice === "bike" || choice === "bicycle") return "BICYCLE" as const;
    if (choice === "public transport" || choice === "transit") return "TRANSIT" as const;
    return null;
  }).filter((mode): mode is RouteTravelMode => mode !== null);
  return mapped.find((mode) => mode !== "TRANSIT") ?? mapped[0] ?? null;
}
