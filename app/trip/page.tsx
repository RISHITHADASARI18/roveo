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

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      try{
        setLoading(true); setStatus("Locating your destination…");
        const geoRes=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(destination));
        if(!geoRes.ok) throw new Error("Could not locate destination.");
        const geoResults=await geoRes.json();
        if(!geoResults[0]) throw new Error("Destination was not found. Try a city or landmark.");
        const located={lat:Number(geoResults[0].lat),lon:Number(geoResults[0].lon),display_name:geoResults[0].display_name};
        if(cancelled)return; setGeo(located); setStatus("Finding famous places and attractions nearby…");

        const query='[out:json][timeout:25];(nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park"](around:30000,'+located.lat+','+located.lon+');nwr["historic"~"monument|castle|ruins|archaeological_site"](around:30000,'+located.lat+','+located.lon+');nwr["leisure"~"park|nature_reserve"](around:30000,'+located.lat+','+located.lon+'););out center tags;';
        const placesRes=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(query));
        if(!placesRes.ok) throw new Error("Places service is temporarily unavailable.");
        const data=await placesRes.json();
        const mapped:Place[]=(data.elements||[])
          .map((item:any)=>({id:String(item.id),name:item.tags?.name||item.tags?.["name:en"]||"",type:item.tags?.tourism||item.tags?.historic||item.tags?.leisure||"place",lat:Number(item.lat??item.center?.lat),lon:Number(item.lon??item.center?.lon)}))
          .filter((p:Place)=>p.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon))
          .filter((p:Place,i:number,a:Place[])=>a.findIndex(x=>x.name.toLowerCase()===p.name.toLowerCase())===i)
          .slice(0,80);
        if(cancelled)return;
        setPlaces(mapped);
        setDayPlans(makePlans(mapped,days));
        setStatus(mapped.length ? "Plan ready — nearby places are grouped together to reduce unnecessary travel." : "No mapped attractions were found nearby.");
      }catch(e){if(!cancelled)setStatus(e instanceof Error?e.message:"Something went wrong.");}
      finally{if(!cancelled)setLoading(false);}
    }
    if(destination)load(); else {setLoading(false);setStatus("No destination was provided.");}
    return()=>{cancelled=true};
  },[destination,days]);

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

  return <main className="trip-page">
    <nav className="dashboard-nav"><a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a><div className="dashboard-nav-links"><a href="/dashboard">← Edit trip</a><a className="active" href="/trip">My plan</a></div></nav>

    <div className="page-navigation trip-page-navigation"><button type="button" className="page-nav secondary" onClick={() => window.history.back()}>← Back</button><a className="page-nav primary" href="#places-to-explore">Next →</a></div>
    <section className="trip-hero">
      <div><span className="eyebrow">YOUR ROVEO PLAN</span><h1>{destination||"Your trip"} <span>planned around you.</span></h1><p>{source||"Your starting point"} → {destination||"Destination"} · {days} {days===1?"day":"days"} · {people} {people===1?"traveller":"travellers"} · {travel} to destination · {localTravel} locally · {stay}</p></div>
      <div className="budget-card"><span>TRIP BUDGET</span><strong>₹{money(budget)}</strong><small>≈ ₹{money(budget/days)} / day for the group</small></div>
    </section>

    <section className="trip-layout">
      <div className="trip-main">
        <div className="planner-summary"><div><span className="eyebrow">YOUR PREFERENCES</span><h2>Built around your trip</h2></div><div className="preference-pills"><span>📅 {days} days</span><span>👥 {people} people</span><span>🧳 {travel} to destination</span><span>🗺️ {localTravel} locally</span><span>🏨 {stay}</span><span>💰 ₹{money(budget)}</span></div></div>

        <div id="places-to-explore" className="trip-section-head"><div><span className="eyebrow">01 · DISCOVER</span><h2>Places to explore</h2></div><span className="live-badge">{loading?"Searching…":places.length+" places found"}</span></div>
        <p className="trip-status">{status}</p>
        <div className="place-grid">{places.slice(0,30).map(place=><article className="place-card" key={place.id}><div className="place-icon">✦</div><div className="place-copy"><span>{place.type.replaceAll("_"," ")}</span><h3>{place.name}</h3><small>{place.lat.toFixed(3)}, {place.lon.toFixed(3)}</small></div><span className="place-distance">{geo?distance({id:"g",name:"g",type:"g",lat:geo.lat,lon:geo.lon},place).toFixed(1)+" km":""}</span></article>)}</div>

        <div className="trip-section-head itinerary-head"><div><span className="eyebrow">02 · SMART ITINERARY</span><h2>Where to visit each day</h2><p className="section-note">Roveo keeps nearby places together so you spend more time exploring and less time travelling.</p></div><span className="live-badge">{maxPerDay} places/day target</span></div>

        <div className="itinerary">{dayPlans.map((day,dayIndex)=>{
          const totalKm=day.places.length>1?day.places.slice(1).reduce((sum,p,i)=>sum+distance(day.places[i],p),0):0;
          return <article className="day-card" key={dayIndex}>
            <div className="day-top"><div><div className="day-number">DAY {dayIndex+1}</div><h3>{dayIndex===0?"Arrival & nearby highlights":dayIndex===days-1?"Final discoveries & return":"Explore one area at a time"}</h3></div><div className="day-stats"><strong>{day.places.length} places</strong><span>~{totalKm.toFixed(1)} km between stops</span></div></div>
            <div className="day-places">{day.places.map((place,placeIndex)=><div className="planned-place" key={place.id}><div className="place-order">{placeIndex+1}</div><div><strong>{place.name}</strong><small>{place.type.replaceAll("_"," ")}</small></div><div className="place-actions"><button type="button" onClick={()=>removePlace(dayIndex,place.id)}>Remove</button>{dayIndex>0&&<button type="button" onClick={()=>movePlace(dayIndex,place.id,dayIndex-1)}>← Day {dayIndex}</button>}{dayIndex<days-1&&<button type="button" onClick={()=>movePlace(dayIndex,place.id,dayIndex+2)}>Day {dayIndex+2} →</button>}</div></div>)}</div>
            {!day.places.length&&<p className="empty-day">No places planned. Add one from the discovery list below.</p>}
            <div className="day-footer"><button type="button" onClick={()=>setEditingDay(editingDay===dayIndex?null:dayIndex)}>{editingDay===dayIndex?"Close":"Add places"}</button><button type="button" onClick={()=>regenerateDay(dayIndex)}>↻ Regenerate day</button></div>
            {editingDay===dayIndex&&<div className="add-place-panel">{unplanned.slice(0,12).map(place=><button type="button" key={place.id} disabled={day.places.length>=maxPerDay} onClick={()=>addPlace(dayIndex,place)}><span>+ {place.name}</span><small>{geo?distance({id:"g",name:"g",type:"g",lat:geo.lat,lon:geo.lon},place).toFixed(1)+" km away":""}</small></button>)}</div>}
          </article>
        })}</div>
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