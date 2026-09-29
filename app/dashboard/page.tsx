"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DashboardPage() {
  const router = useRouter();
  const [stay, setStay] = useState("Hotel");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [days, setDays] = useState("5");
  const [people, setPeople] = useState("4");
  const [budget, setBudget] = useState("");
  const [travel, setTravel] = useState("");
  const [localTravel, setLocalTravel] = useState("");
  const [error, setError] = useState("");

  function buildTrip() {
    if (!source.trim() || !destination.trim() || !days || !people || !budget || !travel || !localTravel) {
      setError("Please fill in your route, trip details and both travel preferences first.");
      return;
    }
    setError("");

    try {
      const response = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          destination: destination.trim(),
          days: Number(days),
          people: Number(people),
          budget: Number(budget),
          travel,
          localTravel,
          stay,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to save your trip.");
      }

      const params = new URLSearchParams({
        tripId: String(data.trip.id),
        source: source.trim(),
        destination: destination.trim(),
        days,
        people,
        budget,
        travel,
        localTravel,
        stay,
      });
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
              <label><span>📍 Source</span><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Starting location" /></label>
              <label><span>🎯 Destination</span><input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Where do you want to go?" /></label>
            </div>
          </div>
          <div className="form-section">
            <div className="form-title"><span>02</span><div><h2>Tell us about the trip</h2><p>These details help us plan realistically, including how you reach and move around the destination.</p></div></div>
            <div className="input-grid four">
              <label><span>📅 Days</span><input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} /></label>
              <label><span>👥 People</span><input type="number" min="1" value={people} onChange={(e) => setPeople(e.target.value)} /></label>
              <label><span>💰 Total budget</span><input type="number" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="₹ 40,000" /></label>
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
            <div><strong>Ready to build your trip?</strong><span>Roveo will find real places, locate your destination, organize nearby stops and shape a daily route.</span></div>
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
