export type PlaceTimingMetadata = {
  openingHours?: string;
  visitDurationMinutes?: number;
};

const MARKER = /\\n?<!--ROVEO_PLACE_META:([^>]*)-->/;

export function attachPlaceTimingMetadata(description: string | null, metadata: PlaceTimingMetadata) {
  const cleanDescription = (description ?? "").replace(MARKER, "").trim();
  const cleanMetadata: PlaceTimingMetadata = {};
  if (typeof metadata.openingHours === "string" && metadata.openingHours.trim()) {
    cleanMetadata.openingHours = metadata.openingHours.trim().slice(0, 500);
  }
  if (typeof metadata.visitDurationMinutes === "number" && Number.isFinite(metadata.visitDurationMinutes)) {
    cleanMetadata.visitDurationMinutes = Math.max(30, Math.min(720, Math.round(metadata.visitDurationMinutes)));
  }
  if (!Object.keys(cleanMetadata).length) return cleanDescription || null;
  return (cleanDescription ? cleanDescription + "\n" : "") +
    "<!--ROVEO_PLACE_META:" + encodeURIComponent(JSON.stringify(cleanMetadata)) + "-->";
}

export function readPlaceTimingMetadata(description: string | null | undefined) {
  const value = String(description ?? "");
  const match = value.match(MARKER);
  let metadata: PlaceTimingMetadata = {};
  if (match) {
    try {
      const parsed = JSON.parse(decodeURIComponent(match[1]));
      metadata = {
        openingHours: typeof parsed.openingHours === "string" ? parsed.openingHours : undefined,
        visitDurationMinutes: typeof parsed.visitDurationMinutes === "number" && Number.isFinite(parsed.visitDurationMinutes)
          ? Math.max(30, Math.min(720, Math.round(parsed.visitDurationMinutes)))
          : undefined,
      };
    } catch {
      metadata = {};
    }
  }
  return {
    description: value.replace(MARKER, "").trim() || undefined,
    ...metadata,
  };
}
