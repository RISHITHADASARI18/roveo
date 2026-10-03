import { db } from "@/lib/db";
import type { DiscoveredPlace } from "./types";

let tableReady: Promise<void> | null = null;

function destinationKey(destination: string) {
  return destination.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function ensureCatalog() {
  if (!tableReady) {
    tableReady = db.query(`
      CREATE TABLE IF NOT EXISTS places_catalog (
        id BIGSERIAL PRIMARY KEY,
        destination_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_place_id TEXT NOT NULL,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        type TEXT NOT NULL DEFAULT 'place',
        place_group TEXT NOT NULL DEFAULT 'Activity',
        description TEXT,
        website_url TEXT,
        wikipedia_url TEXT,
        address TEXT,
        opening_hours TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (destination_key, provider, provider_place_id)
      );
      CREATE INDEX IF NOT EXISTS places_catalog_destination_idx
        ON places_catalog (destination_key);
      CREATE INDEX IF NOT EXISTS places_catalog_name_idx
        ON places_catalog (name);
    `).then(() => undefined);
  }
  return tableReady;
}

function rowToPlace(row: any): DiscoveredPlace {
  return {
    id: String(row.provider) + "-" + String(row.provider_place_id),
    name: String(row.name),
    type: String(row.type || "place"),
    group: String(row.place_group || "Activity") as DiscoveredPlace["group"],
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    distanceKm: 0,
    description: row.description || undefined,
    website: row.website_url || undefined,
    wikipedia: row.wikipedia_url || undefined,
    address: row.address || undefined,
    openingHours: row.opening_hours || undefined,
  };
}

export async function readPlaceCatalog(destination: string): Promise<DiscoveredPlace[]> {
  await ensureCatalog();
  const key = destinationKey(destination);
  const result = await db.query(
    `SELECT provider, provider_place_id, name, latitude, longitude, type,
            place_group, description, website_url, wikipedia_url, address, opening_hours
       FROM places_catalog
      WHERE destination_key = $1
      ORDER BY id ASC`,
    [key],
  );
  return result.rows.map(rowToPlace);
}

export async function savePlaceCatalog(destination: string, places: DiscoveredPlace[]) {
  if (!places.length) return;
  await ensureCatalog();
  const key = destinationKey(destination);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const place of places) {
      const rawId = String(place.id || place.name);
      const provider = rawId.startsWith("wikipedia") ? "wikipedia" : rawId.startsWith("google") ? "google" : "openstreetmap";
      const providerPlaceId = rawId.slice(provider === "wikipedia" ? rawId.indexOf("-") + 1 : provider === "google" ? 7 : rawId.startsWith("overpass-") ? 9 : 0) || rawId;

      await client.query(
        `INSERT INTO places_catalog (
           destination_key, provider, provider_place_id, name,
           latitude, longitude, type, place_group, description,
           website_url, wikipedia_url, address, opening_hours
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (destination_key, provider, provider_place_id)
         DO UPDATE SET
           name = EXCLUDED.name,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           type = EXCLUDED.type,
           place_group = EXCLUDED.place_group,
           description = EXCLUDED.description,
           website_url = EXCLUDED.website_url,
           wikipedia_url = EXCLUDED.wikipedia_url,
           address = EXCLUDED.address,
           opening_hours = EXCLUDED.opening_hours,
           updated_at = NOW()`,
        [
          key, provider, providerPlaceId, place.name,
          place.latitude, place.longitude, place.type, place.group,
          place.description || null, place.website || null,
          place.wikipedia || null, place.address || null,
          place.openingHours || null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePlaceCatalogTable() {
  await ensureCatalog();
}
