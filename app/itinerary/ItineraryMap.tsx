"use client";

import { useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

type Point = {
  id: string;
  name: string;
  type?: string;
  lat: number;
  lon: number;
  day?: number;
  order?: number;
};

type RouteLeg = {
  id?: number;
  dayId: number;
  fromItemId: number;
  toItemId: number;
  mode: "DRIVE" | "WALK" | "BICYCLE";
  distanceKm: number;
  durationMinutes: number;
  encodedPolyline?: string;
};

function decodePolyline(encoded: string, precision = 6): Array<[number, number]> {
  const factor = Math.pow(10, precision);
  const coordinates: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;

    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;

    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coordinates.push([lat / factor, lon / factor]);
  }

  return coordinates;
}

function FitMap({ points }: { points: Array<{ lat: number; lon: number }> }) {
  const map = useMap();

  useEffect(() => {
    if (!points.length) return;
    map.fitBounds(
      points.map((point) => [point.lat, point.lon] as [number, number]),
      { padding: [40, 40], maxZoom: 14 }
    );
  }, [map, points]);

  return null;
}

export default function ItineraryMap({
  center,
  places,
  routes,
}: {
  center: { lat: number; lon: number };
  places: Point[];
  routes: RouteLeg[];
}) {
  const points = places.filter(
    (place) => Number.isFinite(place.lat) && Number.isFinite(place.lon)
  );

  const routeLines = routes
    .filter((route) => typeof route.encodedPolyline === "string" && route.encodedPolyline)
    .map((route) => ({
      ...route,
      positions: decodePolyline(route.encodedPolyline as string),
    }))
    .filter((route) => route.positions.length > 1);

  return (
    <div className="explore-map itinerary-leaflet-map">
      <MapContainer
        center={[center.lat, center.lon]}
        zoom={12}
        scrollWheelZoom
        className="leaflet-map"
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <FitMap points={[center, ...points]} />

        {routeLines.map((route) => (
          <Polyline
            key={String(route.id ?? route.fromItemId + "-" + route.toItemId + "-" + route.mode)}
            positions={route.positions}
            pathOptions={{ weight: 5, opacity: 0.75 }}
          >
            <Popup>
              <strong>Travel between stops</strong>
              <br />
              {route.distanceKm.toFixed(1)} km · {route.durationMinutes} min
              <br />
              {route.mode === "DRIVE"
                ? "Driving"
                : route.mode === "WALK"
                  ? "Walking"
                  : "Bicycle"}
            </Popup>
          </Polyline>
        ))}

        <CircleMarker
          center={[center.lat, center.lon]}
          radius={9}
          pathOptions={{
            color: "#1676a5",
            fillColor: "#1676a5",
            fillOpacity: 0.95,
          }}
        >
          <Popup>
            <strong>Destination</strong>
            <br />
            Trip starting area
          </Popup>
        </CircleMarker>

        {points.map((place) => (
          <CircleMarker
            key={place.id}
            center={[place.lat, place.lon]}
            radius={8}
            pathOptions={{
              color: "#0c5c83",
              fillColor: "#e38b4a",
              fillOpacity: 0.95,
              weight: 2,
            }}
          >
            <Popup>
              <strong>
                {place.order ? String(place.order) + ". " : ""}
                {place.name}
              </strong>
              {place.day ? (
                <>
                  <br />
                  Day {place.day}
                </>
              ) : null}
              {place.type ? (
                <>
                  <br />
                  {String(place.type).replaceAll("_", " ")}
                </>
              ) : null}
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>

      <div className="map-legend">
        <span>
          <i className="destination-dot" />
          Destination
        </span>
        <span>
          <i className="place-dot" />
          Planned places
        </span>
        <span>{points.length} places pinned</span>
        {routes.length ? <span>{routes.length} route legs</span> : null}
      </div>
    </div>
  );
}
