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
  start_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lat DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS source_lon DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_lon DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_south DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_north DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_west DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination_east DOUBLE PRECISION;

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


CREATE TABLE IF NOT EXISTS trip_budgets (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  destination_travel NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (destination_travel >= 0),
  accommodation NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (accommodation >= 0),
  local_transport NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (local_transport >= 0),
  food NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (food >= 0),
  activities NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (activities >= 0),
  other NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
  contingency NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (contingency >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(trip_id)
);

CREATE INDEX IF NOT EXISTS trip_budgets_trip_id_idx ON trip_budgets(trip_id);



CREATE TABLE IF NOT EXISTS trip_cost_estimates (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  destination_travel NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (destination_travel >= 0),
  accommodation NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (accommodation >= 0),
  local_transport NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (local_transport >= 0),
  food NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (food >= 0),
  activities NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (activities >= 0),
  other NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
  contingency NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (contingency >= 0),
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  confidence TEXT NOT NULL DEFAULT 'fallback',
  source TEXT NOT NULL DEFAULT 'roveo',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trip_id)
);

CREATE INDEX IF NOT EXISTS trip_cost_estimates_trip_id_idx
  ON trip_cost_estimates (trip_id);


CREATE TABLE IF NOT EXISTS itinerary_route_legs (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_id BIGINT NOT NULL REFERENCES itinerary_days(id) ON DELETE CASCADE,
  from_item_id BIGINT NOT NULL REFERENCES itinerary_items(id) ON DELETE CASCADE,
  to_item_id BIGINT NOT NULL REFERENCES itinerary_items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DRIVE', 'WALK', 'BICYCLE')),
  provider TEXT NOT NULL DEFAULT 'open',
  distance_meters DOUBLE PRECISION NOT NULL CHECK (distance_meters >= 0),
  duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds >= 0),
  encoded_polyline TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_item_id, to_item_id, mode)
);

CREATE INDEX IF NOT EXISTS itinerary_route_legs_trip_id_idx
  ON itinerary_route_legs (trip_id);

CREATE INDEX IF NOT EXISTS itinerary_route_legs_day_id_idx
  ON itinerary_route_legs (day_id);
