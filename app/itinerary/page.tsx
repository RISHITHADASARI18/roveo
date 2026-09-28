"use client";

export default function ItineraryPage(){
  return <main className="itinerary-page">
    <nav className="dashboard-nav">
      <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
      <div className="dashboard-nav-links">
        <a href="/dashboard">Edit trip</a>
        <a href="/trip">My plan</a>
        <a href="/places">Explore places</a>
      </div>
    </nav>
    <div className="page-navigation itinerary-navigation">
      <a className="page-nav secondary" href="/places">← Places to explore</a>
      <a className="page-nav primary" href="/trip">Back to trip →</a>
    </div>
    <section className="itinerary-hero">
      <div>
        <span className="eyebrow">02 · SMART ITINERARY</span>
        <h1>Where to visit <span>each day.</span></h1>
        <p>Your day-by-day travel plan will live here.</p>
      </div>
    </section>
    <section className="itinerary-layout">
      <div className="itinerary-main">
        <div className="itinerary-intro">
          <div><span className="eyebrow">YOUR PLAN</span><h2>One day at a time.</h2><p>Choose places from the discovery page, then organise them into your travel days.</p></div>
        </div>
        <div className="itinerary-loading">Itinerary planner is ready for your trip details.</div>
      </div>
    </section>
  </main>;
}
