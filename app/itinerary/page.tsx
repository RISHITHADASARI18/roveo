"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function km(a:any,b:any){
  const p=Math.PI/180;
  const lat=(b.lat-a.lat)*p;
  const lon=(b.lon-a.lon)*p;
  const x=Math.sin(lat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(lon/2)**2;
  return 6371*2*Math.asin(Math.sqrt(x));
}

const ItineraryMap = dynamic(() => import("./ItineraryMap"), { ssr:false });

type PlannedPlace = {
  id:string;
  name:string;
  type?:string;
  category?:string;
  lat:number;
  lon:number;
  startTime?:string;
  durationMinutes?:number;
  travelTimeMinutes?:number;
};

function ItineraryContent(){
  const params=useSearchParams();
  const destination=params.get("destination")||"";
  const source=params.get("source")||"";
  const days=Math.max(1,Number(params.get("days"))||1);
  const people=Math.max(1,Number(params.get("people"))||1);
  const budget=Math.max(0,Number(params.get("budget"))||0);
  const travel=params.get("travel")||"Car";
  const localTravel=params.get("localTravel")||"Taxi";
  const stay=params.get("stay")||"Hotel";
  const tripId=params.get("tripId")||"";

  const [center,setCenter]=useState<any>(null);
  const [selectedPlaces,setSelectedPlaces]=useState<any[]>([]);
  const [plans,setPlans]=useState<PlannedPlace[][]>([]);
  const [loading,setLoading]=useState(true);
  const [planning,setPlanning]=useState(false);
  const [message,setMessage]=useState("Loading your selected places…");
  const [saving,setSaving]=useState(false);
  const [saveMessage,setSaveMessage]=useState("");
  const [routes,setRoutes]=useState<any[]>([]);
  const [routeMessage,setRouteMessage]=useState("");
  const [plannerReason,setPlannerReason]=useState("");
  const [selectedCount,setSelectedCount]=useState(0);

  async function loadRoutes(){
    if(!tripId)return;
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/routes",{cache:"no-store"});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not load saved routes.");
      setRoutes(Array.isArray(data.routes)?data.routes:[]);
      setRouteMessage(Array.isArray(data.routes)&&data.routes.length?"Real road routes loaded.":"");
    }catch(error){
      setRoutes([]);
      setRouteMessage(error instanceof Error?error.message:"Could not load saved routes.");
    }
  }

  async function loadSavedItinerary(){
    if(!tripId)return false;
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/itinerary",{cache:"no-store"});
      if(!res.ok)return false;
      const data=await res.json();
      if(!Array.isArray(data.days)||!data.days.length)return false;
      const restored=data.days.map((day:any)=>
        (day.items||[]).map((item:any)=>item.place?{
          id:String(item.tripPlaceId),
          name:item.place.name,
          type:item.place.category||"place",
          category:item.place.category||"",
          lat:Number(item.place.latitude),
          lon:Number(item.place.longitude),
          startTime:item.startTime||"",
          durationMinutes:Number(item.durationMinutes)||0,
          travelTimeMinutes:Number(item.travelTimeMinutes)||0
        }:null).filter(Boolean)
      );
      setPlans(restored);
      setMessage("Loaded your saved itinerary. Your manual changes are preserved.");
      return true;
    }catch{
      return false;
    }
  }

  async function buildPlan(){
    if(!tripId){
      setPlans([]);
      setLoading(false);
      setMessage("Open this page from a saved trip so Roveo can use the places you selected.");
      return;
    }

    setPlanning(true);
    setMessage("Grouping your selected places by area and building each day…");
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/itinerary/plan",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({days})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not build the smart itinerary.");

      setSelectedCount(Number(data.selectedPlaceCount)||0);
      setPlannerReason(String(data.planner?.message||""));
      const next=(data.days||[]).map((day:any)=>
        (day.items||[]).map((place:any)=>({
          id:String(place.id),
          name:String(place.name),
          type:place.category||"place",
          category:place.category||"",
          lat:Number(place.latitude),
          lon:Number(place.longitude),
          startTime:place.startTime,
          durationMinutes:Number(place.durationMinutes)||0,
          travelTimeMinutes:Number(place.travelTimeMinutes)||0
        }))
      );
      setPlans(next);
      if(!data.selectedPlaceCount){
        setMessage("No places have been selected yet. Go back to Places to Explore and add the places you want.");
      }else{
        setMessage("Smart plan ready — nearby places are grouped together and each day is ordered to reduce backtracking.");
      }
    }catch(error){
      setMessage(error instanceof Error?error.message:"Could not build the smart itinerary.");
      setPlans([]);
    }finally{
      setPlanning(false);
      setLoading(false);
    }
  }

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      if(!destination){setLoading(false);setMessage("No destination was provided.");return;}
      try{
        const geo=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(destination));
        if(!geo.ok)throw new Error("Could not locate the destination.");
        const results=await geo.json();
        if(!results[0])throw new Error("Destination was not found.");
        if(cancelled)return;
        setCenter({lat:Number(results[0].lat),lon:Number(results[0].lon)});

        if(!tripId){
          setLoading(false);
          setMessage("Open this page from a saved trip so Roveo can use your selected places.");
          return;
        }

        const saved=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/places",{cache:"no-store"});
        const savedData=await saved.json().catch(()=>({}));
        if(!saved.ok)throw new Error(savedData.error||"Could not load your selected places.");

        const mapped=(savedData.places||[]).map((place:any)=>({
          id:String(place.id),
          name:String(place.name),
          type:place.category||"place",
          category:place.category||"",
          lat:Number(place.latitude),
          lon:Number(place.longitude)
        })).filter((place:any)=>Number.isFinite(place.lat)&&Number.isFinite(place.lon));

        if(cancelled)return;
        setSelectedPlaces(mapped);
        setSelectedCount(mapped.length);

        const savedItinerary=await loadSavedItinerary();
        if(cancelled)return;

        if(!savedItinerary)await buildPlan();
        await loadRoutes();
      }catch(error){
        if(!cancelled){
          setLoading(false);
          setMessage(error instanceof Error?error.message:"Something went wrong.");
        }
      }
    }
    load();
    return()=>{cancelled=true};
  },[destination,tripId,days]);

  async function saveItinerary(){
    if(!tripId)return;
    setSaving(true);
    setSaveMessage("");
    try{
      const payloadDays=plans.map((items,dayIndex)=>({
        dayNumber:dayIndex+1,
        items:items.map((place,index)=>({
          tripPlaceId:Number(place.id),
          position:index+1,
          startTime:place.startTime||null,
          durationMinutes:place.durationMinutes||null,
          travelTimeMinutes:place.travelTimeMinutes||0
        }))
      }));

      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/itinerary",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({days:payloadDays})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not save the itinerary.");

      setSaveMessage("Itinerary saved to your trip.");
      await loadRoutes();
      if(!routes.length)await calculateRoutes();
    }catch(error){
      setSaveMessage(error instanceof Error?error.message:"Could not save the itinerary.");
    }finally{
      setSaving(false);
    }
  }

  async function calculateRoutes(){
    if(!tripId)return;
    try{
      setRouteMessage("Calculating real road routes between same-day stops…");
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/routes",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not calculate routes.");
      setRoutes(Array.isArray(data.routes)?data.routes:[]);
      setRouteMessage(data.routeCount?"Real road routes calculated and saved.":"No same-day route legs are needed yet.");
    }catch(error){
      setRouteMessage(error instanceof Error?error.message:"Could not calculate routes.");
    }
  }

  function remove(day:number,id:string){
    setPlans(current=>current.map((items,index)=>index===day?items.filter(place=>place.id!==id):items));
  }

  function move(from:number,id:string,to:number){
    if(to<0||to>=plans.length)return;
    const place=plans[from]?.find(item=>item.id===id);
    if(!place)return;
    setPlans(current=>current.map((items,index)=>{
      if(index===from)return items.filter(item=>item.id!==id);
      if(index===to)return [...items,place];
      return items;
    }));
  }

  const planned=plans.flat();
  const unplanned=selectedPlaces.filter(place=>!planned.some(item=>item.id===place.id));
  const mapPlaces=plans.flatMap((items,dayIndex)=>items.map((place,index)=>({
    id:String(place.id),
    name:place.name,
    type:place.type,
    lat:place.lat,
    lon:place.lon,
    day:dayIndex+1,
    order:index+1
  })));
  const formattedBudget=new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(budget);

  return <main className="itinerary-page">
    <nav className="dashboard-nav">
      <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
      <div className="dashboard-nav-links"><a href="/dashboard">Edit trip</a><a className="active" href={"/trip?"+params.toString()}>My plan</a><a href={"/places?"+params.toString()}>Explore places</a></div>
    </nav>

    <div className="page-navigation itinerary-navigation">
      <a className="page-nav secondary" href={"/places?"+params.toString()}>← Places to explore</a>
      <a className="page-nav primary" href={"/trip?"+params.toString()}>Back to trip →</a>
    </div>

    <section className="itinerary-hero">
      <div><span className="eyebrow">02 · SMART ITINERARY</span><h1>Where to visit <span>each day.</span></h1><p>{destination||"Your destination"} · {days} {days===1?"day":"days"} · {people} {people===1?"traveller":"travellers"}</p></div>
      <div className="itinerary-budget"><span>TRIP BUDGET</span><strong>₹{formattedBudget}</strong><small>{travel} to destination · {localTravel} locally · {stay}</small></div>
    </section>

    <section className="itinerary-layout">
      <div className="itinerary-main">
        <div className="itinerary-intro">
          <div>
            <span className="eyebrow">YOUR RECOMMENDED ITINERARY</span>
            <h2>Roveo plans the day, not just the list.</h2>
            <p>{loading||planning?message:plannerReason||message}</p>
          </div>
          <div className="itinerary-count"><strong>{planned.length}</strong><span>of {selectedCount} selected places planned</span></div>
        </div>

        {!loading&&!planning&&!tripId&&<div className="itinerary-loading">{message}</div>}
        {!loading&&!planning&&tripId&&!selectedCount&&<div className="itinerary-loading"><strong>No places selected yet.</strong><br/>Go to Places to Explore, add the places you actually want, then return here.</div>}

        <div className="itinerary-save-row">
          <button type="button" className="primary-button" onClick={buildPlan} disabled={planning||loading||!tripId||!selectedCount}>{planning?"Planning…":"↻ Rebuild smart plan"}</button>
          <button type="button" className="primary-button" onClick={saveItinerary} disabled={saving||!tripId||!planned.length}>{saving?"Saving…":"Save itinerary"}</button>
          {saveMessage&&<span>{saveMessage}</span>}
          {routeMessage&&<span>{routeMessage}</span>}
        </div>

        {unplanned.length>0&&<div className="itinerary-loading"><strong>{unplanned.length} selected {unplanned.length===1?"place is":"places are"} not in the current plan.</strong> Rebuild the smart plan to distribute all selected places again.</div>}

        <div className="itinerary-days">
          {plans.map((items,day)=>{
            const total=items.length>1?items.slice(1).reduce((sum,place,index)=>sum+km(items[index],place),0):0;
            const dayTitle=day===0?"Arrival & nearby highlights":day===days-1?"Final discoveries & return":"Explore one area at a time";
            return <article className="itinerary-day" key={day}>
              <div className="itinerary-day-head">
                <div><span className="day-number">DAY {day+1}</span><h3>{dayTitle}</h3></div>
                <div className="day-stats"><strong>{items.length} places</strong><span>~{total.toFixed(1)} km between stops</span></div>
              </div>

              <p className="planning-rule">Roveo grouped this day geographically first, then ordered the stops to reduce backtracking.</p>

              <div className="planned-place-list">
                {items.map((place,index)=><div className="planned-place" key={place.id}>
                  <div className="place-order">{index+1}</div>
                  <div>
                    <strong>{place.name}</strong>
                    <small>{place.startTime||"Flexible time"} · {place.durationMinutes||90} min · {place.type||"place"}</small>
                    {place.travelTimeMinutes? <small>Travel from previous stop: ~{place.travelTimeMinutes} min</small>:null}
                  </div>
                  <div className="place-actions">
                    <button type="button" onClick={()=>remove(day,place.id)}>Remove</button>
                    {day>0&&<button type="button" onClick={()=>move(day,place.id,day-1)}>← Day {day}</button>}
                    {day<days-1&&<button type="button" onClick={()=>move(day,place.id,day+1)}>Day {day+2} →</button>}
                  </div>
                </div>)}
              </div>

              {!items.length&&<p className="empty-day">No selected places are assigned to this day.</p>}

              <div className="day-footer">
                <span className="auto-plan-note">✓ Places are grouped by proximity to reduce wasted local travel</span>
              </div>
            </article>;
          })}
        </div>
      </div>

      <aside className="itinerary-side">
        <div className="itinerary-map-card">
          <span className="eyebrow">03 · ROUTE MAP</span><h2>See the plan spatially.</h2>
          {center?<ItineraryMap center={center} places={mapPlaces} routes={routes}/>:<div className="map-loading">Locating destination…</div>}
          {center&&<a className="map-link" href={"https://www.openstreetmap.org/?mlat="+center.lat+"&mlon="+center.lon+"#map=12/"+center.lat+"/"+center.lon} target="_blank" rel="noreferrer">Open full map ↗</a>}
        </div>

        <div className="budget-breakdown">
          <span className="eyebrow">04 · TRIP DETAILS</span><h2>Your preferences</h2>
          <div><span>Starting point</span><strong>{source||"—"}</strong></div>
          <div><span>Stay</span><strong>{stay}</strong></div>
          <div><span>Travel to destination</span><strong>{travel}</strong></div>
          <div><span>Getting around</span><strong>{localTravel}</strong></div>
          <div><span>Travellers</span><strong>{people}</strong></div>
          <div><span>Budget</span><strong>₹{formattedBudget}</strong></div>
        </div>

        <div className="budget-breakdown">
          <span className="eyebrow">05 · ROVEO LOGIC</span>
          <h2>Less travel. More exploring.</h2>
          <p className="planning-rule">Roveo first groups the places you selected into geographic areas. Then it orders each day from one stop to the next instead of randomly spreading attractions across the destination.</p>
          <p className="planning-rule">The final Save step calculates real road routes between the same-day stops, so the map reflects the actual route rather than just straight-line distance.</p>
        </div>
      </aside>
    </section>
  </main>;
}

export default function ItineraryPage(){
  return <Suspense fallback={<main className="itinerary-page"><div className="map-loading">Loading your itinerary…</div></main>}><ItineraryContent/></Suspense>;
}
