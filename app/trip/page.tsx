"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Place = { id: string; name: string; type: string; lat: number; lon: number };
type Geo = { lat: number; lon: number; display_name: string };

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

function TripContent() {
  const params = useSearchParams();
  const source = params.get("source") || "";
  const destination = params.get("destination") || "";
  const days = Math.max(1, Number(params.get("days")) || 1);
  const people = Math.max(1, Number(params.get("people")) || 1);
  const budget = Math.max(0, Number(params.get("budget")) || 0);
  const travel = params.get("travel") || "Car";
  const stay = params.get("stay") || "Hotel";
  const [geo, setGeo] = useState<Geo | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Locating your destination…");
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadTripData() {
      try {
        setLoading(true);
        setStatus("Locating your destination…");
        const geoResponse = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(destination));
        if (!geoResponse.ok) throw new Error("Could not locate destination.");
        const geoResults = await geoResponse.json();
        if (!geoResults[0]) throw new Error("Destination was not found. Try a city or landmark.");
        const located: Geo = { lat: Number(geoResults[0].lat), lon: Number(geoResults[0].lon), display_name: geoResults[0].display_name };
        if (cancelled) return;
        setGeo(located);
        setStatus("Finding nearby places…");

        const query = '[out:json][timeout:20];(nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park"](around:12000,' + located.lat + ',' + located.lon + ');nwr["historic"~"monument|castle|ruins|archaeological_site"](around:12000,' + located.lat + ',' + located.lon + '););out center tags;';
        const placesResponse = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(query));
        if (!placesResponse.ok) throw new Error("Places service is temporarily unavailable.");
        const data = await placesResponse.json();
        const mapped: Place[] = (data.elements || [])
          .map((item: any) => ({ id: String(item.id), name: item.tags?.name || item.tags?.["name:en"] || "", type: item.tags?.tourism || item.tags?.historic || "place", lat: Number(item.lat ?? item.center?.lat), lon: Number(item.lon ?? item.center?.lon) }))
          .filter((item: Place) => item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon))
          .filter((item: Place, index: number, array: Place[]) => array.findIndex((p) => p.name === item.name) === index)
          .slice(0, 30);
        if (cancelled) return;
        setPlaces(mapped);
        setSelected(mapped.slice(0, Math.min(mapped.length, days * 2)).map((p) => p.id));
        setStatus(mapped.length ? "Trip ideas ready." : "No mapped attractions were found nearby.");
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Something went wrong.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (destination) loadTripData();
    else { setLoading(false); setStatus("No destination was provided."); }
    return () => { cancelled = true; };
  }, [destination]);

  const selectedPlaces = useMemo(() => places.filter((p) => selected.includes(p.id)), [places, selected]);
  const mapUrl = geo ? "https://www.openstreetmap.org/export/embed.html?bbox=" + (geo.lon - 0.08) + "%2C" + (geo.lat - 0.06) + "%2C" + (geo.lon + 0.08) + "%2C" + (geo.lat + 0.06) + "&layer=mapnik&marker=" + geo.lat + "%2C" + geo.lon : "";

  function togglePlace(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <main className="trip-page">
      <nav className="dashboard-nav">
        <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
        <div className="dashboard-nav-links"><a href="/dashboard">← Edit trip</a><a className="active" href="/trip">My plan</a></div>
      </nav>
      <section className="trip-hero">
        <div><span className="eyebrow">YOUR ROVEO PLAN</span><h1>{destination || "Your trip"} <span>starts here.</span></h1><p>{source || "Your starting point"} → {destination || "Destination"} · {days} {days === 1 ? "day" : "days"} · {people} {people === 1 ? "traveller" : "travellers"} · {travel} · {stay}</p></div>
        <div className="budget-card"><span>TRIP BUDGET</span><strong>₹{money(budget)}</strong><small>≈ ₹{money(budget / days)} / day for the group</small></div>
      </section>
      <section className="trip-layout">
        <div className="trip-main">
          <div className="trip-section-head"><div><span className="eyebrow">01 · DISCOVER</span><h2>Places worth adding</h2></div><span className="live-badge">{loading ? "Searching…" : places.length + " found"}</span></div>
          <p className="trip-status">{status}</p>
          <div className="place-grid">
            {places.map((place) => (
              <article className={"place-card " + (selected.includes(place.id) ? "is-selected" : "")} key={place.id}>
                <div className="place-icon">✦</div><div className="place-copy"><span>{place.type.replaceAll("_", " ")}</span><h3>{place.name}</h3><small>{place.lat.toFixed(4)}, {place.lon.toFixed(4)}</small></div>
                <button type="button" onClick={() => togglePlace(place.id)}>{selected.includes(place.id) ? "Added ✓" : "Add +"}</button>
              </article>
            ))}
            {!loading && !places.length && <div className="empty-result"><strong>No places found yet.</strong><span>Try a nearby city or a more specific destination from the dashboard.</span></div>}
          </div>
          <div className="trip-section-head itinerary-head"><div><span className="eyebrow">02 · ITINERARY</span><h2>Your day-by-day plan</h2></div><span className="live-badge">{selectedPlaces.length} places selected</span></div>
          <div className="itinerary">
            {Array.from({ length: days }, (_, index) => {
              const dayPlaces = selectedPlaces.filter((_, placeIndex) => placeIndex % days === index);
              return <article className="day-card" key={index}><div className="day-number">DAY {index + 1}</div><div><h3>{index === 0 ? "Arrival & first discoveries" : index === days - 1 ? "Last stops & return" : "Explore nearby"}</h3>{dayPlaces.length ? <ul>{dayPlaces.map((place) => <li key={place.id}><span>•</span>{place.name}</li>)}</ul> : <p>Add places above and Roveo will group them across your days.</p>}</div></article>;
            })}
          </div>
        </div>
        <aside className="trip-side">
          <div className="map-card">
            <div className="map-heading"><div><span className="eyebrow">03 · MAP</span><h2>Locate the trip</h2></div><span className="map-pin">●</span></div>
            {geo ? <iframe title="Roveo trip map" src={mapUrl} loading="lazy" /> : <div className="map-loading">Map will appear after your destination is located.</div>}
            {geo && <a className="map-link" href={"https://www.openstreetmap.org/?mlat=" + geo.lat + "&mlon=" + geo.lon + "#map=12/" + geo.lat + "/" + geo.lon} target="_blank" rel="noreferrer">Open full map ↗</a>}
          </div>
          <div className="budget-breakdown">
            <span className="eyebrow">04 · BUDGET</span><h2>Plan the spend</h2>
            <div><span>Stay</span><strong>Set by your stay choice</strong></div><div><span>Travel</span><strong>{travel}</strong></div><div><span>Activities</span><strong>{selectedPlaces.length} selected</strong></div><div><span>Per day</span><strong>₹{money(budget / days)}</strong></div>
            <small>Roveo will add live prices once accommodation and travel providers are connected.</small>
          </div>
        </aside>
      </section>
    </main>
  );
}

export default function TripPage() {
  return (
    <Suspense fallback={<main className="trip-page"><div className="map-loading">Loading your trip planner…</div></main>}>
      <TripContent />
    </Suspense>
  );
}
