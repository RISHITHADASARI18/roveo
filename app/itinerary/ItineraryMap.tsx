"use client";

import { useEffect } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
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

function FitMap({ points }: { points: Point[] }) {
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
}: {
  center: { lat: number; lon: number };
  places: Point[];
}) {
  const points = places.filter(
    (place) => Number.isFinite(place.lat) && Number.isFinite(place.lon)
  );

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
      </div>
    </div>
  );
}
