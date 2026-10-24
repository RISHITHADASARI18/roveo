"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Place = { id:string; name:string; type:string; lat:number; lon:number };
type Geo = { lat:number; lon:number; display_name:string };
type Day = { places: Place[] };

function money(value:number){ return new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(value); }
function distance(a:Place,b:Place){ const r=6371, p=Math.PI/180, dLat=(b.lat-a.lat)*p, dLon=(b.lon-a.lon)*p; const x=Math.sin(dLat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLon/2)**2; return 2*r*Math.asin(Math.sqrt(x)); }

function TripContent(){
  const params=useSearchParams();
  const source=params.get("source")||"";
  const destination=params.get("destination")||"";
  const routeDestinations=(()=>{try{const value=JSON.parse(params.get("destinations")||"[]");return Array.isArray(value)?value.filter((item:any)=>typeof item==="string"&&item.trim()):destination?[destination]:[]}catch{return destination?[destination]:[]}})();
  const routeLabel=routeDestinations.length>1?routeDestinations.join(" → "):destination;
  const days=Math.max(1,Number(params.get("days"))||1);
  const people=Math.max(1,Number(params.get("people"))||1);
  const budget=Math.max(0,Number(params.get("budget"))||0);
  const travel=params.get("travel")||"Car";
  const localTravel=params.get("localTravel")||"Taxi";
  const stay=params.get("stay")||"Hotel";
  const [geo,setGeo]=useState<Geo|null>(null);
  const [places,setPlaces]=useState<Place[]>([]);
  const [dayPlans,setDayPlans]=useState<Day[]>([]);
  const [loading,setLoading]=useState(true);
  const [status,setStatus]=useState("Finding your destination…");
  const [editingDay,setEditingDay]=useState<number|null>(null);
  const [budgetItems,setBudgetItems]=useState({
    destinationTravel:0, accommodation:0, localTransport:0, food:0,
    activities:0, other:0, contingency:0
  });
  const [budgetLoading,setBudgetLoading]=useState(true);
  const [budgetSaving,setBudgetSaving]=useState(false);
  const [budgetMessage,setBudgetMessage]=useState("");

  useEffect(()=>{
    let cancelled=false;
    async function loadBudget(){
      const tripId=params.get("tripId");
      if(!tripId){setBudgetLoading(false);return;}
      try{
        const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/budget");
        if(!res.ok)throw new Error("Could not load budget.");
        const data=await res.json();
        if(cancelled)return;
        if(data.budget?.items){
          const next:any={...budgetItems};
          for(const item of data.budget.items)next[item.category]=Number(item.amount)||0;
          setBudgetItems(next);
        }
      }catch(error){
        if(!cancelled)setBudgetMessage(error instanceof Error?error.message:"Could not load budget.");
      }finally{if(!cancelled)setBudgetLoading(false);}
    }
    loadBudget();
    return()=>{cancelled=true};
  },[params]);

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      try{
        setLoading(true);
        setStatus("Loading your saved trip destination…");
        const tripId=params.get("tripId");
        let located:Geo|null=null;

        if(tripId){
          // Use the destination selected and saved during trip creation. Do not
          // geocode the name again or run a second, narrower Overpass search here:
          // that duplicate path could pick a different place or omit destinations.
          const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/destinations",{cache:"no-store"});
          const data=await res.json().catch(()=>({}));
          if(!res.ok)throw new Error(data.error||"Could not load your saved destinations.");
          const first=(Array.isArray(data.destinations)?data.destinations:[]).find((item:any)=>
            item && item.name && item.lat!=null && item.lon!=null &&
            Number.isFinite(Number(item.lat)) && Number(item.lat)>=-90 && Number(item.lat)<=90 &&
            Number.isFinite(Number(item.lon)) && Number(item.lon)>=-180 && Number(item.lon)<=180
          );
          if(!first)throw new Error("This trip has no destination with valid coordinates.");
          located={lat:Number(first.lat),lon:Number(first.lon),display_name:String(first.name)};
        }else if(destination){
          // Legacy destination-only links use Roveo's shared geocoding endpoint.
          const res=await fetch("/api/geocode/search?q="+encodeURIComponent(destination),{cache:"no-store"});
          const data=await res.json().catch(()=>({}));
          const first=Array.isArray(data.locations)?data.locations[0]:null;
          if(!res.ok||!first||first.lat==null||first.lon==null||
            !Number.isFinite(Number(first.lat))||!Number.isFinite(Number(first.lon))||
            Number(first.lat)<-90||Number(first.lat)>90||Number(first.lon)<-180||Number(first.lon)>180){
            throw new Error("Destination was not found. Try choosing it from the dashboard suggestions.");
          }
          located={lat:Number(first.lat),lon:Number(first.lon),display_name:String(first.displayName||first.name||destination)};
        }else{
          throw new Error("No destination was provided.");
        }

        if(cancelled)return;
        setGeo(located);
        setPlaces([]);
        setDayPlans(makePlans([],days));
        setStatus("Map centered on your saved route. Use Places to explore for destination-aware discovery.");
      }catch(error){
        if(!cancelled){
          setGeo(null);
          setStatus(error instanceof Error?error.message:"Could not load the saved destination.");
        }
      }finally{
        if(!cancelled)setLoading(false);
      }
    }
    load();
    return()=>{cancelled=true};
  },[destination,days,params]);

  function makePlans(list:Place[],count:number){
    if(!list.length)return Array.from({length:count},()=>({places:[]}));
    const remaining=[...list].sort((a,b)=>Math.hypot(a.lat-(geo?.lat||a.lat),a.lon-(geo?.lon||a.lon))-Math.hypot(b.lat-(geo?.lat||b.lat),b.lon-(geo?.lon||b.lon)));
    const plans=Array.from({length:count},()=>({places:[] as Place[]}));
    const maxPerDay=Math.max(2,Math.min(5,Math.ceil(Math.min(list.length,count*4)/count)));
    remaining.slice(0,count*maxPerDay).forEach((place,index)=>plans[index%count].places.push(place));
    for(let d=0;d<count;d++){
      plans[d].places=plans[d].places.sort((a,b)=>a.lat-b.lat||a.lon-b.lon);
    }
    return plans;
  }

  const allPlanned=dayPlans.flatMap(d=>d.places);
  const maxPerDay=Math.max(2,Math.min(5,Math.ceil(Math.min(places.length,days*4)/days)));
  const selectedIds=new Set(allPlanned.map(p=>p.id));
  const unplanned=places.filter(p=>!selectedIds.has(p.id));
  const mapUrl=geo?"https://www.openstreetmap.org/export/embed.html?bbox="+(geo.lon-.12)+"%2C"+(geo.lat-.08)+"%2C"+(geo.lon+.12)+"%2C"+(geo.lat+.08)+"&layer=mapnik&marker="+geo.lat+"%2C"+geo.lon:"";

  function removePlace(day:number,id:string){setDayPlans(current=>current.map((d,i)=>i===day?{places:d.places.filter(p=>p.id!==id)}:d));}
  function movePlace(from:number,id:string,to:number){if(from===to)return; const place=dayPlans[from].places.find(p=>p.id===id); if(!place)return; setDayPlans(current=>current.map((d,i)=>i===from?{places:d.places.filter(p=>p.id!==id)}:i===to&&d.places.length<maxPerDay?{places:[...d.places,place]}:d));}
  function addPlace(day:number,place:Place){if(dayPlans[day].places.length>=maxPerDay)return;setDayPlans(current=>current.map((d,i)=>i===day?{places:[...d.places,place]}:d));}
  function regenerateDay(day:number){
    const available=[...unplanned,...dayPlans.flatMap((d,i)=>i===day?[]:d.places)];
    const seed=available.sort((a,b)=>Math.hypot(a.lat-(geo?.lat||a.lat),a.lon-(geo?.lon||a.lon))-Math.hypot(b.lat-(geo?.lat||b.lat),b.lon-(geo?.lon||b.lon)));
    const replacement=seed.slice(0,maxPerDay);
    setDayPlans(current=>current.map((d,i)=>i===day?{places:replacement}:d));
  }

  const plannedBudget=Object.values(budgetItems).reduce((sum,value)=>sum+Number(value||0),0);
  const remainingBudget=budget-plannedBudget;
  const budgetPerPerson=people?plannedBudget/people:plannedBudget;
  const budgetPerDay=days?plannedBudget/days:plannedBudget;

  function updateBudgetItem(key:string,value:string){
    const amount=Math.max(0,Number(value)||0);
    setBudgetItems(current=>({...current,[key]:amount}));
  }

  async function saveBudget(){
    const tripId=params.get("tripId");
    if(!tripId)return;
    setBudgetSaving(true);setBudgetMessage("");
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/budget",{
        method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(budgetItems)
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not save budget.");
      setBudgetMessage("Budget saved.");
    }catch(error){setBudgetMessage(error instanceof Error?error.message:"Could not save budget.");}
    finally{setBudgetSaving(false);}
  }

  return <main className="trip-page">
    <nav className="dashboard-nav"><a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a><div className="dashboard-nav-links"><a href="/dashboard">← Edit trip</a><a className="active" href={"/trip?" + params.toString()}>Trip</a><a href={"/budget?" + params.toString()}>Budget</a><a href={"/places?" + params.toString()}>Places</a><a href={"/itinerary?" + params.toString()}>Itinerary</a></div></nav>

    <div className="page-navigation trip-page-navigation"><button type="button" className="page-nav secondary" onClick={() => window.history.back()}>← Back</button><a className="page-nav primary" href={"/places?"+params.toString()}>Next →</a></div>
    <section className="trip-hero">
      <div><span className="eyebrow">YOUR ROVEO PLAN</span><h1>{routeLabel||"Your trip"} <span>planned around you.</span></h1><p>{source||"Your starting point"} → {routeLabel||"Destination"} · {days} {days===1?"day":"days"} · {people} {people===1?"traveller":"travellers"} · {travel} to destination · {localTravel} locally · {stay}</p></div>
      <div className="budget-card"><span>TRIP BUDGET</span><strong>₹{money(budget)}</strong><small>≈ ₹{money(budget/days)} / day for the group</small></div>
    </section>

    <section className="trip-layout">
      <div className="trip-main">
        <div className="planner-summary"><div><span className="eyebrow">YOUR PREFERENCES</span><h2>Built around your trip</h2></div><div className="preference-pills"><span>📅 {days} days</span><span>👥 {people} people</span><span>🧳 {travel} to destination</span><span>🗺️ {localTravel} locally</span><span>🏨 {stay}</span><span>💰 ₹{money(budget)}</span></div></div>

        <section className="trip-budget-entry">
          <div>
            <span className="eyebrow">04 · BUDGET MANAGEMENT</span>
            <h2>Manage the money for this trip.</h2>
            <p>Break your total budget into travel, accommodation, local transport, food, activities and a contingency reserve. Your breakdown is saved with this trip.</p>
          </div>
          <a className="plan-button" href={"/budget?" + params.toString()}>Open budget management →</a>
        </section>

        <section className="trip-hub">
          <span className="eyebrow">YOUR TRIP WORKSPACE</span>
          <h2>Plan the details separately.</h2>
          <p>Keep discovery and day-by-day planning focused on their own pages. Your trip choices are carried forward automatically.</p>
          <div className="trip-hub-grid">
            <a className="trip-hub-card" href={"/places?"+params.toString()}>
              <span className="trip-hub-number">01</span>
              <div>
                <span className="eyebrow">DISCOVER</span>
                <h3>Places to explore</h3>
                <p>Find major attractions and smaller local places around your destination, with filters and an interactive map.</p>
              </div>
              <strong>Explore places →</strong>
            </a>
            <a className="trip-hub-card" href={"/itinerary?"+params.toString()}>
              <span className="trip-hub-number">02</span>
              <div>
                <span className="eyebrow">SMART ITINERARY</span>
                <h3>Where to visit each day</h3>
                <p>Build your Day 1, Day 2 and onward plan, then move, remove, add or regenerate places as your trip changes.</p>
              </div>
              <strong>Build itinerary →</strong>
            </a>
          </div>
        </section>
      </div>

      <aside className="trip-side">
        <div className="map-card"><div className="map-heading"><div><span className="eyebrow">03 · MAP</span><h2>Locate the trip</h2></div><span className="map-pin">●</span></div>{geo?<iframe title="Roveo trip map" src={mapUrl} loading="lazy"/>:<div className="map-loading">Locating destination…</div>}{geo&&<a className="map-link" href={"https://www.openstreetmap.org/?mlat="+geo.lat+"&mlon="+geo.lon+"#map=12/"+geo.lat+"/"+geo.lon} target="_blank" rel="noreferrer">Open full map ↗</a>}</div>
        <div className="budget-breakdown"><span className="eyebrow">04 · TRIP DETAILS</span><h2>Your preferences</h2><div><span>Stay</span><strong>{stay}</strong></div><div><span>Travel to destination</span><strong>{travel}</strong></div><div><span>Getting around</span><strong>{localTravel}</strong></div><div><span>Travellers</span><strong>{people}</strong></div><div><span>Budget</span><strong>₹{money(budget)}</strong></div><div><span>Daily budget</span><strong>₹{money(budget/days)}</strong></div><small>Accommodation and travel prices will be connected to live providers next, so Roveo can recommend stays and calculate the real trip cost.</small></div>
        <div className="budget-breakdown"><span className="eyebrow">05 · HOW ROVEO PLANS</span><h2>Travel less. Explore more.</h2><p className="planning-rule">Roveo separates your journey to the destination from local travel, then groups nearby attractions across your days so you spend less time moving between them.</p><p className="planning-rule">You can remove, move, add or regenerate places whenever your plan changes.</p></div>
      </aside>
    </section>
  </main>;
}

export default function TripPage(){return <Suspense fallback={<main className="trip-page"><div className="map-loading">Loading your trip planner…</div></main>}><TripContent/></Suspense>}