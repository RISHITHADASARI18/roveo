const steps = [
  {
    number: "01",
    title: "Create your trip",
    text: "Start a trip with your destination, dates, and the people you are travelling with.",
  },
  {
    number: "02",
    title: "Plan together",
    text: "Keep places, plans, ideas, and important trip details organized in one shared space.",
  },
  {
    number: "03",
    title: "Travel with less stress",
    text: "Everyone knows the plan, so you can spend less time coordinating and more time exploring.",
  },
];

export default function Home() {
  return (
    <main>
      <nav className="navbar">
        <a className="brand" href="/" aria-label="Roveo home">
          <span className="brand-mark">R</span>
          <span>roveo</span>
        </a>

        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a className="dashboard-link" href="/dashboard">Dashboard</a>
          <a className="login-button" href="/login">Log in</a>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">TRAVEL TOGETHER</span>
          <h1>Make the trip.<br /><span>Not the chaos.</span></h1>
          <p className="hero-text">
            Roveo brings your trip plans, people, places, and ideas together
            so travelling with others feels simple.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="/dashboard">Go to Dashboard <span>→</span></a>
            <a className="secondary-button" href="#how-it-works">See how it works</a>
          </div>
        </div>

        <div className="hero-card" aria-label="Roveo trip preview">
          <div className="card-top">
            <span className="trip-label">UPCOMING TRIP</span>
            <span className="status-dot">● Planning</span>
          </div>
          <h2>Weekend in Kyoto</h2>
          <p className="trip-date">Oct 18 — Oct 22 · 4 travellers</p>

          <div className="route">
            <div className="route-point">
              <span className="pin">●</span>
              <div><strong>Tokyo</strong><small>Start</small></div>
            </div>
            <div className="route-line"><span>✦</span></div>
            <div className="route-point">
              <span className="pin">●</span>
              <div><strong>Kyoto</strong><small>Destination</small></div>
            </div>
          </div>

          <div className="mini-grid">
            <div><strong>12</strong><span>Places saved</span></div>
            <div><strong>8</strong><span>Plans added</span></div>
            <div><strong>4</strong><span>Travellers</span></div>
          </div>
        </div>
      </section>

      <section className="quote-section">
        <div className="quote-mark">“</div>
        <blockquote>Go somewhere new. Make the planning part of the adventure.</blockquote>
        <p>— The Roveo idea</p>
      </section>

      <section className="how-section" id="how-it-works">
        <div className="section-heading">
          <span className="eyebrow">HOW IT WORKS</span>
          <h2>From “where should we go?”<br />to “we&apos;re going.”</h2>
          <p>Roveo keeps the whole group on the same page, from the first idea to the final day of the trip.</p>
        </div>

        <div className="steps">
          {steps.map((step) => (
            <article className="step" key={step.number}>
              <span className="step-number">{step.number}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="cta">
        <div>
          <span className="eyebrow">READY TO ROVE?</span>
          <h2>Your next trip starts here.</h2>
        </div>
        <a className="primary-button light-button" href="/dashboard">Open Dashboard <span>→</span></a>
      </section>

      <footer>
        <div className="brand footer-brand"><span className="brand-mark">R</span><span>roveo</span></div>
        <p>Plan together. Explore freely.</p>
        <a href="https://github.com/RISHITHADASARI18/roveo" target="_blank" rel="noreferrer">Open source on GitHub ↗</a>
      </footer>
    </main>
  );
}
