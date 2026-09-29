"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type BudgetItem = {
  key: string;
  label: string;
  description: string;
};

const CATEGORIES: BudgetItem[] = [
  { key: "destinationTravel", label: "Travel to destination", description: "Bus, train, flight or fuel for reaching the destination." },
  { key: "accommodation", label: "Accommodation", description: "Hotel, homestay, hostel or other stay costs." },
  { key: "localTransport", label: "Local transport", description: "Taxi, public transport, rental, fuel or transfers." },
  { key: "food", label: "Food", description: "Meals, drinks and everyday food expenses." },
  { key: "activities", label: "Activities & tickets", description: "Entry fees, tours, experiences and activities." },
  { key: "other", label: "Other", description: "Shopping, parking, tips and anything else." },
  { key: "contingency", label: "Emergency / contingency", description: "A reserve for unexpected expenses." },
];

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.max(0, value));
}

function BudgetContent() {
  const params = useSearchParams();
  const tripId = params.get("tripId") || "";
  const source = params.get("source") || "";
  const destination = params.get("destination") || "Your trip";
  const days = Math.max(1, Number(params.get("days")) || 1);
  const people = Math.max(1, Number(params.get("people")) || 1);
  const totalBudget = Math.max(0, Number(params.get("budget")) || 0);
  const travel = params.get("travel") || "";
  const localTravel = params.get("localTravel") || "";
  const stay = params.get("stay") || "";

  const [items, setItems] = useState<Record<string, number>>(
    Object.fromEntries(CATEGORIES.map((category) => [category.key, 0]))
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [estimateSource, setEstimateSource] = useState("");
  const [estimating, setEstimating] = useState(false);

  useEffect(() => {
    if (!tripId) {
      setLoading(false);
      setMessage("This budget needs a trip ID. Open Budget from a saved trip.");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/trips/" + encodeURIComponent(tripId) + "/budget");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not load the budget.");

        if (!cancelled && data.budget?.items) {
          const next = { ...items };
          for (const item of data.budget.items) next[item.category] = Number(item.amount) || 0;
          setItems(next);
        } else if (!cancelled) {
          await generateEstimate();
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Could not load the budget.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [tripId]);

  const planned = useMemo(
    () => Object.values(items).reduce((sum, value) => sum + Number(value || 0), 0),
    [items]
  );
  const remaining = totalBudget - planned;
  const perPerson = planned / people;
  const perDay = planned / days;
  const progress = totalBudget > 0 ? Math.min(100, (planned / totalBudget) * 100) : planned > 0 ? 100 : 0;

  function updateItem(key: string, value: string) {
    const amount = Math.max(0, Number(value) || 0);
    setItems((current) => ({ ...current, [key]: amount }));
    setMessage("");
  }

  async function generateEstimate() {
    if (!tripId) return;
    setEstimating(true);
    setMessage("");
    try {
      const response = await fetch("/api/trips/" + encodeURIComponent(tripId) + "/budget/estimate", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not generate the estimate.");
      if (data.calculation?.items) setItems(data.calculation.items);
      const source = data.pricing?.accommodationSource === "stayingapi"
        ? "Live accommodation price + Roveo planning estimates"
        : "Roveo planning estimates";
      setEstimateSource(source);
      setMessage("Estimate refreshed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not generate the estimate.");
    } finally {
      setEstimating(false);
    }
  }

  async function saveBudget() {
    if (!tripId) return;
    setSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/trips/" + encodeURIComponent(tripId) + "/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save the budget.");
      setMessage("Budget saved successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the budget.");
    } finally {
      setSaving(false);
    }
  }

  const query = params.toString();

  return (
    <main className="budget-page">
      <nav className="dashboard-nav">
        <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
        <div className="dashboard-nav-links">
          <a href={"/trip?" + query}>Trip</a>
          <a className="active" href={"/budget?" + query}>Budget</a>
          <a href={"/places?" + query}>Places</a>
          <a href={"/itinerary?" + query}>Itinerary</a>
        </div>
      </nav>

      <div className="page-navigation budget-page-navigation">
        <a className="page-nav secondary" href={"/trip?" + query}>← Back to trip</a>
        <a className="page-nav primary" href={"/places?" + query}>Places →</a>
      </div>

      <section className="budget-hero">
        <div>
          <span className="eyebrow">TRIP BUDGET MANAGEMENT</span>
          <h1>Make every rupee <span>count.</span></h1>
          <p>{source || "Your starting point"} → {destination} · {days} {days === 1 ? "day" : "days"} · {people} {people === 1 ? "traveller" : "travellers"}</p>
        </div>
        <div className="budget-total-card">
          <span>TOTAL TRIP BUDGET</span>
          <strong>₹{money(totalBudget)}</strong>
          <small>₹{money(totalBudget / days)} per day for the group</small>
        </div>
      </section>

      <section className="budget-management-layout">
        <div className="budget-main">
          <div className="budget-overview-card">
            <div className="budget-overview-heading">
              <div>
                <span className="eyebrow">LIVE OVERVIEW</span>
                <h2>Your budget at a glance</h2>
              </div>
              <strong className={remaining < 0 ? "budget-danger-text" : "budget-safe-text"}>
                {remaining < 0 ? "Over budget" : "Within budget"}
              </strong>
            </div>

            <div className="budget-progress">
              <div><span style={{ width: progress + "%" }} /></div>
              <small>{Math.round(progress)}% of your total budget planned</small>
            </div>

            <div className="budget-stat-grid">
              <div><span>Total budget</span><strong>₹{money(totalBudget)}</strong></div>
              <div><span>Planned</span><strong>₹{money(planned)}</strong></div>
              <div><span>Remaining</span><strong className={remaining < 0 ? "budget-danger-text" : ""}>₹{money(Math.abs(remaining))}</strong></div>
              <div><span>Per person</span><strong>₹{money(perPerson)}</strong></div>
              <div><span>Per day</span><strong>₹{money(perDay)}</strong></div>
            </div>
          </div>

          <div className="budget-editor-card">
            <div className="section-heading left">
              <span className="eyebrow">BUDGET BREAKDOWN</span>
              <h2>Plan where the money goes.</h2>
              <p>Set an amount for each part of the trip. Roveo keeps the breakdown saved with this trip.</p>
            </div>

            <div className="budget-category-list">
              {CATEGORIES.map((category) => (
                <label className="budget-category-row" key={category.key}>
                  <div>
                    <strong>{category.label}</strong>
                    <small>{category.description}</small>
                  </div>
                  <div className="budget-category-input">
                    <b>₹</b>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={items[category.key]}
                      onChange={(event) => updateItem(category.key, event.target.value)}
                      disabled={loading || saving}
                    />
                  </div>
                </label>
              ))}
            </div>

            <div className="budget-estimate-toolbar"><div><strong>{estimateSource || "Roveo estimate"}</strong><span>Live hotel pricing is used when a start date and provider key are available.</span></div><button className="page-nav secondary" type="button" onClick={generateEstimate} disabled={estimating}>{estimating ? "Refreshing…" : "Refresh estimate"}</button></div>

            <div className="budget-editor-footer">
              <div>
                <strong>Planned total: ₹{money(planned)}</strong>
                <span>{remaining >= 0 ? "₹" + money(remaining) + " still available" : "₹" + money(Math.abs(remaining)) + " over your budget"}</span>
              </div>
              <button className="plan-button" type="button" onClick={saveBudget} disabled={loading || saving}>
                {saving ? "Saving…" : "Save budget"}
              </button>
            </div>

            {message && <p className="budget-message">{message}</p>}
          </div>
        </div>

        <aside className="budget-side">
          <div className="budget-side-card">
            <span className="eyebrow">TRIP SETTINGS</span>
            <h2>What Roveo is using</h2>
            <div><span>Stay</span><strong>{stay || "Not set"}</strong></div>
            <div><span>Destination travel</span><strong>{travel || "Not set"}</strong></div>
            <div><span>Local travel</span><strong>{localTravel || "Not set"}</strong></div>
            <div><span>Travellers</span><strong>{people}</strong></div>
            <div><span>Days</span><strong>{days}</strong></div>
          </div>

          <div className="budget-side-card budget-next-card">
            <span className="eyebrow">NEXT</span>
            <h2>Turn the budget into real options.</h2>
            <p>Once live travel and accommodation prices are connected, Roveo can use this budget to filter stays, activities and travel choices.</p>
            <a href={"/places?" + query}>Explore places →</a>
          </div>
        </aside>
      </section>
    </main>
  );
}

export default function BudgetPage() {
  return (
    <Suspense fallback={<main className="budget-page"><div className="map-loading">Loading your budget…</div></main>}>
      <BudgetContent />
    </Suspense>
  );
}
