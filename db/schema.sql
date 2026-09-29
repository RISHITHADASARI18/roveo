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
