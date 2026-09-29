-- Roveo PostgreSQL schema
-- Run this once against the PostgreSQL database configured by DATABASE_URL.

CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  destination TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days > 0),
  people INTEGER NOT NULL CHECK (people > 0),
  budget NUMERIC(12, 2) NOT NULL CHECK (budget >= 0),
  travel_method TEXT NOT NULL,
  local_travel_method TEXT NOT NULL,
  stay_preference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trips_created_at_idx ON trips (created_at DESC);


CREATE TABLE IF NOT EXISTS trip_places (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openstreetmap',
  provider_place_id TEXT,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  category TEXT,
  description TEXT,
  photo_url TEXT,
  website_url TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trip_id, provider_place_id)
);

CREATE INDEX IF NOT EXISTS trip_places_trip_id_idx
  ON trip_places (trip_id);

CREATE TABLE IF NOT EXISTS itinerary_days (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL CHECK (day_number > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trip_id, day_number)
);

CREATE TABLE IF NOT EXISTS itinerary_items (
  id BIGSERIAL PRIMARY KEY,
  day_id BIGINT NOT NULL REFERENCES itinerary_days(id) ON DELETE CASCADE,
  trip_place_id BIGINT REFERENCES trip_places(id) ON DELETE SET NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  start_time TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  travel_time_minutes INTEGER CHECK (travel_time_minutes IS NULL OR travel_time_minutes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day_id, position)
);

CREATE INDEX IF NOT EXISTS itinerary_days_trip_id_idx
  ON itinerary_days (trip_id);

CREATE INDEX IF NOT EXISTS itinerary_items_day_id_idx
  ON itinerary_items (day_id);
