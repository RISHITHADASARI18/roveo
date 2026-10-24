export type PlaceCategory = "Waterfalls" | "Viewpoints" | "Beaches" | "Temples" | "Nature" | "Adventure" | "Theme Parks" | "History" | "Culture" | "Attractions";
export type PlaceCategoryInput = { name: string; type?: string; group?: string; description?: string };

export function normalizePlaceName(value: string) {
  const normalized = value.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const aliases: Record<string, string> = {
    "alleppey": "alappuzha",
    "alleppey beach": "alappuzha beach",
    "trivandrum": "thiruvananthapuram",
    "cochin": "kochi",
    "udhagamandalam": "ooty",
  };
  return aliases[normalized] ?? normalized;
}

/** Only widen discovery to a whole state when the user explicitly selected that state. */
export function isKeralaStateDestination(destination: string) {
  const normalized = normalizePlaceName(destination);
  return normalized === "kerala" || normalized === "kerala india";
}

export function categoryForPlace(place: PlaceCategoryInput): PlaceCategory {
  const value = normalizePlaceName([place.name, place.type ?? "", place.group ?? "", place.description ?? ""].join(" "));
  if (/waterfall|falls\b|cascade/.test(value)) return "Waterfalls";
  if (/viewpoint|lookout|observation deck|panorama|scenic point|\bpeak\b/.test(value)) return "Viewpoints";
  if (/beach|coastline|seaside|shoreline/.test(value)) return "Beaches";
  if (/temple|mandir|place of worship|hindu temple/.test(value)) return "Temples";
  if (/theme park|theme park|water park|amusement|wonderla|ramoji film city|disneyland|universal studios/.test(value)) return "Theme Parks";
  if (/fort|palace|historic|historical|heritage|monument|memorial|museum|archaeolog|ruins|castle/.test(value) || place.group === "History") return "History";
  if (/adventure|trek|hiking|zipline|rafting|kayak|camping|rock climbing|paragliding|skiing|safari|wildlife|zoo|aquarium|climbing|canoe/.test(value)) return "Adventure";
  if (/forest|nature|reserve|national park|garden|lake|mountain|hill|cave|cliff|hot spring|backwater|island|river|dam|sanctuary|water body/.test(value) || place.group === "Nature") return "Nature";
  if (/culture|art gallery|arts centre|theatre|artwork|craft|cultural/.test(value) || place.group === "Culture") return "Culture";
  return "Attractions";
}
