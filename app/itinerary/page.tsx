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

const ItineraryMap = dynamic(() => import("./ItineraryMap"), { ssr: false });

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

  const [center,setCenter]=useState<any>(null);
  const [places,setPlaces]=useState<any[]>([]);
  const [plans,setPlans]=useState<any[][]>([]);
  const [loading,setLoading]=useState(true);
  const tripId=params.get("tripId")||"";
  const [message,setMessage]=useState("Building your itinerary…");
  const [saving,setSaving]=useState(false);
  const [saveMessage,setSaveMessage]=useState("");
  const [routes,setRoutes]=useState<any[]>([]);
  const [routeMessage,setRouteMessage]=useState("");

  useEffect(()=>{
    let stopped=false;
    async function load(){
      if(!destination){setLoading(false);setMessage("No destination was provided.");return;}
      try{
        setLoading(true);
        const geo=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(destination));
        if(!geo.ok)throw new Error("Could not locate the destination.");
        const results=await geo.json();
        if(!results[0])throw new Error("Destination was not found.");
        const point={lat:Number(results[0].lat),lon:Number(results[0].lon)};
        if(stopped)return;
        setCenter(point);
        setMessage("Finding nearby places…");

        const q='[out:json][timeout:45];(nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork"](around:30000,'+point.lat+','+point.lon+');nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|yes"](around:30000,'+point.lat+','+point.lon+');nwr["leisure"~"park|nature_reserve|garden|beach|water_park"](around:30000,'+point.lat+','+point.lon+');nwr["natural"~"waterfall|peak|cave|beach"](around:30000,'+point.lat+','+point.lon+');nwr["amenity"~"place_of_worship|arts_centre|theatre"](around:30000,'+point.lat+','+point.lon+'););out center tags;';
        const res=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(q));
        if(!res.ok)throw new Error("Places service is temporarily unavailable.");
        const data=await res.json();

        const found=(data.elements||[])
          .map((item:any)=>({
            id:String(item.type||"x")+"-"+String(item.id),
            name:item.tags?.name||item.tags?.["name:en"]||"",
            type:item.tags?.tourism||item.tags?.historic||item.tags?.leisure||item.tags?.natural||item.tags?.amenity||"place",
            lat:Number(item.lat??item.center?.lat),
            lon:Number(item.lon??item.center?.lon)
          }))
          .filter((p:any)=>p.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon))
          .filter((p:any,i:number,a:any[])=>a.findIndex((x:any)=>x.name.toLowerCase()===p.name.toLowerCase())===i)
          .sort((a:any,b:any)=>km(point,a)-km(point,b));

        if(stopped)return;
        setPlaces(found);
        const per=Math.max(2,Math.min(5,Math.ceil(Math.min(found.length,days*4)/days)));
        const next=Array.from({length:days},()=>[] as any[]);
        found.slice(0,days*per).forEach((place:any,index:number)=>next[index%days].push(place));
        setPlans(next);
        await loadSavedItinerary();
        await loadRoutes();
        setMessage(found.length?"Nearby places have been grouped across your days.":"No mapped places were found nearby.");
      }catch(error){
        if(!stopped)setMessage(error instanceof Error?error.message:"Something went wrong.");
      }finally{
        if(!stopped)setLoading(false);
      }
    }
    load();
    return()=>{stopped=true};
  },[destination,days]);

  const maxPerDay=Math.max(2,Math.min(5,Math.ceil(Math.min(places.length,days*4)/days)));

  async function loadRoutes(){
    if(!tripId)return;
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/routes");
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not load saved routes.");
      setRoutes(Array.isArray(data.routes)?data.routes:[]);
      setRouteMessage(Array.isArray(data.routes)&&data.routes.length?"Saved route details loaded.":"");
    }catch(error){
      setRoutes([]);
      setRouteMessage(error instanceof Error?error.message:"Could not load saved routes.");
    }
  }

  async function calculateRoutes(){
    if(!tripId)return;
    try{
      setRouteMessage("Calculating routes between stops…");
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/routes",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({}),
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not calculate routes.");
      setRoutes(Array.isArray(data.routes)?data.routes:[]);
      setRouteMessage(data.routeCount?"Real routes calculated and saved.":"No same-day route legs are needed yet.");
    }catch(error){
      setRoutes([]);
      setRouteMessage(error instanceof Error?error.message:"Could not calculate routes.");
    }
  }

  async function saveItinerary(){
    if(!tripId){
      setSaveMessage("This trip has no saved trip ID yet. Please start from the dashboard.");
      return;
    }
    setSaving(true);
    setSaveMessage("");
    try{
      const savedPlaces=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/places");
      if(!savedPlaces.ok)throw new Error("Could not load saved places for this trip.");
      const placeData=await savedPlaces.json();
      const byProviderId=new Map<string,any>();
      const byName=new Map<string,any>();
      for(const place of placeData.places||[]){
        if(place.providerPlaceId)byProviderId.set(String(place.providerPlaceId),place);
        byName.set(String(place.name).toLowerCase(),place);
      }
      const payloadDays=plans.map((items,dayIndex)=>({
        dayNumber:dayIndex+1,
        items:items.map((place:any,index:number)=>{
          const saved=byProviderId.get(String(place.id))||byName.get(String(place.name).toLowerCase());
          if(!saved)throw new Error("Save the places from the Explore page before saving this itinerary.");
          return {
            tripPlaceId:Number(saved.id),
            position:index+1
          };
        })
      }));
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/itinerary",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({days:payloadDays})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not save the itinerary.");
      setSaveMessage("Itinerary saved to your trip.");
      await calculateRoutes();
    }catch(error){
      setSaveMessage(error instanceof Error?error.message:"Could not save the itinerary.");
    }finally{
      setSaving(false);
    }
  }

  async function loadSavedItinerary(){
    if(!tripId)return;
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/itinerary");
      if(!res.ok)return;
      const data=await res.json();
      if(!Array.isArray(data.days)||!data.days.length)return;
      const restored=data.days.map((day:any)=>({
        ...day,
        items:(day.items||[]).map((item:any)=>item.place?{
          id:String(item.tripPlaceId),
          name:item.place.name,
          type:item.place.category||"place",
          lat:Number(item.place.latitude),
          lon:Number(item.place.longitude)
        }:null).filter(Boolean)
      }));
      setPlans(restored.map((day:any)=>day.items));
      setMessage("Loaded your saved itinerary.");
    }catch{
      // Keep the generated itinerary if the saved version cannot be loaded.
    }
  }
  const planned=plans.flat();

  function remove(day:number,id:string){
    setPlans(current=>current.map((items,index)=>index===day?items.filter((p:any)=>p.id!==id):items));
  }

  function move(from:number,id:string,to:number){
    const place=plans[from]?.find((p:any)=>p.id===id);
    if(!place||plans[to]?.length>=maxPerDay)return;
    setPlans(current=>current.map((items,index)=>index===from?items.filter((p:any)=>p.id!==id):index===to?[...items,place]:items));
  }

  function regenerate(day:number){
    const replacement=places.filter((p:any)=>!plans.flatMap((items,index)=>index===day?[]:items).some((x:any)=>x.id===p.id)).slice(0,maxPerDay);
    setPlans(current=>current.map((items,index)=>index===day?replacement:items));
  }

  const mapPlaces=plans.flatMap((items,dayIndex)=>items.map((place:any,index:number)=>({
    id:String(place.id),
    name:place.name,
    type:place.type,
    lat:Number(place.lat),
    lon:Number(place.lon),
    day:dayIndex+1,
    order:index+1,
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
          <div><span className="eyebrow">YOUR RECOMMENDED ITINERARY</span><h2>We planned the places for you.</h2><p>{loading?message:"Roveo automatically selects nearby places and groups them into each day to reduce unnecessary travel."}</p></div>
          <div className="itinerary-count"><strong>{planned.length}</strong><span>places planned</span></div>
        </div>

        {loading&&<div className="itinerary-loading">{message}</div>}
        {!loading&&!plans.length&&<div className="itinerary-loading">{message}</div>}

        <div className="itinerary-save-row"><button type="button" className="primary-button" onClick={saveItinerary} disabled={saving}>{saving?"Saving…":"Save itinerary"}</button>{saveMessage&&<span>{saveMessage}</span>}{routeMessage&&<span>{routeMessage}</span>}</div>

        <div className="itinerary-days">
          {plans.map((items,day)=>{
            const total=items.length>1?items.slice(1).reduce((sum:number,p:any,index:number)=>sum+km(items[index],p),0):0;
            return <article className="itinerary-day" key={day}>
              <div className="itinerary-day-head">
                <div><span className="day-number">DAY {day+1}</span><h3>{day===0?"Arrival & nearby highlights":day===days-1?"Final discoveries & return":"Explore one area at a time"}</h3></div>
                <div className="day-stats"><strong>{items.length} places</strong><span>~{total.toFixed(1)} km between stops</span></div>
              </div>

              <div className="planned-place-list">
                {items.map((place:any,index:number)=><div className="planned-place" key={place.id}>
                  <div className="place-order">{index+1}</div>
                  <div><strong>{place.name}</strong><small>{String(place.type).replaceAll("_"," ")}</small></div>
                  <div className="place-actions">
                    <button type="button" onClick={()=>remove(day,place.id)}>Remove</button>
                    {day>0&&<button type="button" onClick={()=>move(day,place.id,day-1)}>← Day {day}</button>}
                    {day<days-1&&<button type="button" onClick={()=>move(day,place.id,day+1)}>Day {day+2} →</button>}
                  </div>
                </div>)}
              </div>

              {!items.length&&<p className="empty-day">No places planned for this day yet.</p>}

              <div className="day-footer">
                <span className="auto-plan-note">✓ Roveo selected these places automatically</span>
                <button type="button" onClick={()=>regenerate(day)}>↻ Regenerate day</button>
              </div>
            </article>;
          })}
        </div>
      </div>

      <aside className="itinerary-side">
        <div className="itinerary-map-card">
          <span className="eyebrow">03 · MAP</span><h2>Your trip area</h2>
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
      </aside>
    </section>
  </main>;
}

export default function ItineraryPage(){
  return <Suspense fallback={<main className="itinerary-page"><div className="map-loading">Loading your itinerary…</div></main>}><ItineraryContent/></Suspense>;
}
