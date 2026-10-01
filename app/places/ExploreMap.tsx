"use client";

import { useEffect } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

type Place = {
  id: string;
  name: string;
  group: string;
  lat: number;
  lon: number;
  distance: number;
};

type GeoPoint = {
  lat: number;
  lon: number;
};

function FitMap({ points }: { points: GeoPoint[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length) {
      map.fitBounds(
        points.map((point) => [point.lat, point.lon] as [number, number]),
        { padding: [35, 35], maxZoom: 13 }
      );
    }
  }, [map, points]);

  return null;
}

export default function ExploreMap({
  center,
  places,
  selected,
  onToggle,
}: {
  center: GeoPoint;
  places: Place[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="explore-map">
      <MapContainer
        center={[center.lat, center.lon]}
        zoom={12}
        scrollWheelZoom
        className="leaflet-map"
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <FitMap
          points={[
            center,
            ...places.map((place) => ({ lat: place.lat, lon: place.lon })),
          ]}
        />

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
            {center.lat.toFixed(4)}, {center.lon.toFixed(4)}
          </Popup>
        </CircleMarker>

        {places.map((place) => {
          const isSelected = selected.includes(place.id);

          return (
            <CircleMarker
              key={place.id}
              center={[place.lat, place.lon]}
              radius={isSelected ? 8 : 6}
              pathOptions={{
                color: isSelected ? "#0c5c83" : "#e38b4a",
                fillColor: isSelected ? "#0c5c83" : "#e38b4a",
                fillOpacity: 0.9,
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -8]}
                opacity={0.96}
                permanent
                sticky
              >
                <strong>{place.name}</strong>
              </Tooltip>
              <Popup>
                <strong>{place.name}</strong>
                <br />
                {place.group} · {place.distance.toFixed(1)} km away
                <br />
                <button
                  className="map-add-button"
                  onClick={() => onToggle(place.id)}
                >
                  {isSelected ? "✓ Selected" : "+ Add to trip"}
                </button>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="map-legend">
        <span>
          <i className="destination-dot" />
          Destination
        </span>
        <span>
          <i className="place-dot" />
          Places
        </span>
        <span>{places.length} pins shown</span>
      </div>
    </div>
  );
}
