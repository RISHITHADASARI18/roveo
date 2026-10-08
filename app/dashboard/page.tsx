"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Location = { id:string; name:string; displayName:string; lat:number; lon:number; boundingBox:{south:number;north:number;west:number;east:number}|null; type:string; importance:number };

export default function DashboardPage() {
  const router = useRouter();
  const [stay, setStay] = useState("Hotel");
  const [source, setSource] = useState("");
  const [sourceLocation, setSourceLocation] = useState<Location|null>(null);
  const [destinationLocations, setDestinationLocations] = useState<Location[]>([]);
  const [sourceSuggestions, setSourceSuggestions] = useState<Location[]>([]);
  const [destinationSuggestions, setDestinationSuggestions] = useState<Location[]>([]);
  const [activeLocation, setActiveLocation] = useState<"source"|"destination"|null>(null);
  const [destination, setDestination] = useState("");
  const [days, setDays] = useState("5");
  const [people, setPeople] = useState("4");
  const [budget, setBudget] = useState("");
  const [travel, setTravel] = useState("");
  const [localTravel, setLocalTravel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const query = activeLocation === "source" ? source.trim() : destination.trim();
    if (!activeLocation || query.length < 2) {
      if (activeLocation === "source") setSourceSuggestions([]);
      if (activeLocation === "destination") setDestinationSuggestions([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/geocode/search?q=" + encodeURIComponent(query), { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (activeLocation === "source") setSourceSuggestions(data.locations || []);
        else setDestinationSuggestions(data.locations || []);
      } catch {
        if (!cancelled) {
          if (activeLocation === "source") setSourceSuggestions([]);
          else setDestinationSuggestions([]);
        }
      }
    }, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [source, destination, activeLocation]);

  function selectLocation(kind:"source"|"destination", location:Location) {
    if (kind === "source") {
      setSource(location.name);
      setSourceLocation(location);
      setSourceSuggestions([]);
    } else {
      setDestinationLocations((current) =>
        current.some((item) => item.id === location.id || item.name.toLowerCase() === location.name.toLowerCase())
          ? current
          : [...current, location]
      );
      setDestination("");
      setDestinationSuggestions([]);
    }
    setActiveLocation(null);
  }

  function removeDestination(id:string) {
    setDestinationLocations((current) => current.filter((item) => item.id !== id));
  }

  function moveDestination(index:number, direction:-1|1) {
    setDestinationLocations((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function buildTrip() {
    if (!sourceLocation || destinationLocations.length === 0 || !days || !people || !budget || !travel || !localTravel) {
      setError("Please choose a starting location, at least one destination, trip details and both travel preferences first.");
      return;
    }
    setError("");

    try {
      const response = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: sourceLocation,
          destination: destinationLocations[0],
          destinations: destinationLocations,
          days: Number(days),
          people: Number(people),
          budget: Number(budget),
          travel,
          localTravel,
          stay,
          startDate: startDate || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to save your trip.");
      }

      const params = new URLSearchParams({
        tripId: String(data.trip.id),
        source: sourceLocation.name,
        destination: destinationLocations[0].name,
        destinations: JSON.stringify(destinationLocations.map((item) => item.name)),
        days,
        people,
        budget,
        travel,
        localTravel,
        stay,
      });
      if (startDate) params.set("startDate", startDate);
      router.push("/trip?" + params.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save your trip.");
    }
  }

  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav">
        <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
        <div className="dashboard-nav-links">
          <a className="active" href="/dashboard">Plan a trip</a>
          <a href="#trips">My trips</a>
          <a href="/">Home</a>
        </div>
      </nav>
      <section className="planner">
        <div className="planner-heading">
          <span className="eyebrow">YOUR TRIP STARTS HERE</span>
          <h1>Plan the journey.<br /><span>We’ll shape the trip.</span></h1>
          <p>Tell Roveo where you’re going, how you want to travel, and what you want to spend. We’ll use that to build an efficient day-by-day plan.</p>
        </div>
        <div className="planner-card">
          <div className="form-section">
            <div className="form-title"><span>01</span><div><h2>Where are you going?</h2><p>Start with your route.</p></div></div>
            <div className="input-grid two">
              <label><span>📍 Source</span><div className="location-picker"><input value={source} onFocus={() => setActiveLocation("source")} onChange={(e) => { setSource(e.target.value); setSourceLocation(null); }} placeholder="Starting location" autoComplete="off" />{activeLocation === "source" && sourceSuggestions.length > 0 && <div className="location-suggestions">{sourceSuggestions.map(location => <button type="button" key={location.id} onMouseDown={(e) => e.preventDefault()} onClick={() => selectLocation("source", location)}><strong>{location.name}</strong><small>{location.displayName}</small></button>)}</div>}{sourceLocation && <small className="location-confirmed">✓ Location selected</small>}</div></label>
              <label>
                <span>🎯 Destinations</span>
                <div className="location-picker">
                  <input value={destination} onFocus={() => setActiveLocation("destination")} onChange={(e) => { setDestination(e.target.value); setDestinationSuggestions([]); }} placeholder="Add a destination" autoComplete="off" />
                  {activeLocation === "destination" && destinationSuggestions.length > 0 && (
                    <div className="location-suggestions">
                      {destinationSuggestions.map(location => (
                        <button type="button" key={location.id} onMouseDown={(e) => e.preventDefault()} onClick={() => selectLocation("destination", location)}>
                          <strong>{location.name}</strong><small>{location.displayName}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {destinationLocations.length > 0 && (
                    <div className="destination-list">
                      {destinationLocations.map((location, index) => (
                        <div className="destination-chip" key={location.id}>
                          <span><b>{index + 1}.</b> {location.name}</span>
                          <div className="destination-chip-actions">
                            <button type="button" onClick={() => moveDestination(index, -1)} disabled={index === 0} aria-label={"Move " + location.name + " up"}>↑</button>
                            <button type="button" onClick={() => moveDestination(index, 1)} disabled={index === destinationLocations.length - 1} aria-label={"Move " + location.name + " down"}>↓</button>
                            <button type="button" onClick={() => removeDestination(location.id)} aria-label={"Remove " + location.name}>×</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <small className="location-hint">{destinationLocations.length === 0 ? "Choose a destination from the suggestions." : "Add another destination above. You can reorder them later."}</small>
                </div>
              </label>
            </div>
          </div>
          <div className="form-section">
            <div className="form-title"><span>02</span><div><h2>Tell us about the trip</h2><p>These details help us plan realistically, including when you travel and how you move around the destination.</p></div></div>
            <div className="input-grid four">
              <label><span>📅 Days</span><input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} /></label>
              <label><span>👥 People</span><input type="number" min="1" value={people} onChange={(e) => setPeople(e.target.value)} /></label>
              <label><span>💰 Total budget</span><input type="number" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="₹ 40,000" /></label>
              <label><span>🗓️ Start date (for live stay prices)</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
              <label><span>🧳 How are you getting there?</span><select value={travel} onChange={(e) => setTravel(e.target.value)}><option value="" disabled>Choose</option><option>Car</option><option>Bus</option><option>Train</option><option>Flight</option></select></label>
              <label><span>🗺️ How will you get around?</span><select value={localTravel} onChange={(e) => setLocalTravel(e.target.value)}><option value="" disabled>Choose</option><option>Car</option><option>Taxi</option><option>Public transport</option><option>Walking</option><option>Bike</option></select></label>
            </div>
          </div>
          <div className="form-section">
            <div className="form-title"><span>03</span><div><h2>Where will you stay?</h2><p>Pick the kind of stay that suits your trip.</p></div></div>
            <div className="choice-grid">
              {["Hotel", "Homestay", "Hostel", "Other"].map((item) => (
                <button className={stay === item ? "selected" : ""} type="button" key={item} onClick={() => setStay(item)}>
                  {item === "Hotel" ? "🏨" : item === "Homestay" ? "🏠" : item === "Hostel" ? "🛏️" : "🏕️"} {item}
                </button>
              ))}
            </div>
          </div>
          <div className="planner-action">
            <div><strong>Ready to build your trip?</strong><span>Roveo will save your destinations in order so the next steps can plan the full route.</span></div>
            <button className="plan-button" type="button" onClick={buildTrip}>Find places &amp; build my trip <span>→</span></button>
          </div>
          {error && <p className="planner-error">{error}</p>}
        </div>
      </section>
      <div className="page-navigation"><button type="button" className="page-nav secondary" onClick={() => router.push("/")}>← Back</button><button type="button" className="page-nav primary" onClick={buildTrip}>Next →</button></div>
      <section className="how-dashboard">
        <div className="section-heading left"><span className="eyebrow">WHAT ROVEO WILL DO</span><h2>From your choices to a smarter itinerary.</h2></div>
        <div className="dashboard-features">
          <article><span>01</span><h3>Find places</h3><p>Discover attractions and activities that make sense for your destination and budget.</p></article>
          <article><span>02</span><h3>Group nearby spots</h3><p>Keep places that are close together on the same day to reduce unnecessary travel.</p></article>
          <article><span>03</span><h3>Build each day</h3><p>Turn the results into a practical day-by-day route instead of a random list of places.</p></article>
          <article><span>04</span><h3>Track the budget</h3><p>Estimate travel, stay, food and activities so you can see how much of your budget remains.</p></article>
          <article><span>05</span><h3>Show it on a map</h3><p>See your route and selected places together so the whole trip is easy to understand.</p></article>
          <article><span>06</span><h3>Adjust anytime</h3><p>Add, remove or reorder places and rebuild the itinerary around your changes.</p></article>
        </div>
      </section>
      <section className="trip-preview" id="trips">
        <div><span className="eyebrow">YOUR TRIPS</span><h2>Your planned adventures will live here.</h2><p>Once you create a trip, Roveo will keep the itinerary, places, stay and budget together in one workspace.</p></div>
        <div className="empty-trip"><span>✦</span><strong>No trips yet</strong><small>Your first adventure is one plan away.</small></div>
      </section>
    </main>
  );
}
