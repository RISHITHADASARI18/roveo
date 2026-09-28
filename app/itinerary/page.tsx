"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type Place={id:string;name:string;type:string;lat:number;lon:number};
type Geo={lat:number;lon:number};
type Day={places:Place[]};

function distance(a:Place,b:Place){
  const r=6371,p=Math.PI/180,dLat=(b.lat-a.lat)*p,dLon=(b.lon-a.lon)*p;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLon/2)**2;
  return 2*r*Math.asin(Math.sqrt(x));
}

function money(value:number){
  return new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(value);
}

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

  const [geo,setGeo]=useState<Geo|null>(null);
  const [places,setPlaces]=useState<Place[]>([]);
  const [dayPlans,setDayPlans]=useState<Day[]>([]);
  const [loading,setLoading]=useState(true);
  const [message,setMessage]=useState("Building your itinerary…");
  const [editingDay,setEditingDay]=useState<number|null>(null);

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      if(!destination){setLoading(false);setMessage("No destination was provided.");return;}
      try{
        setLoading(true);
        setMessage("Locating your destination…");
        const geoRes=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(destination));
        if(!geoRes.ok)throw new Error("Could not locate the destination.");
        const results=await geoRes.json();
        if(!results[0])throw new Error("Destination was not found. Try a city or landmark.");
        const located={lat:Number(results[0].lat),lon:Number(results[0].lon)};
        if(cancelled)return;
        setGeo(located);
        setMessage("Finding nearby places and grouping them into days…");

        const query='[out:json][timeout:45];(nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork|information"](around:30000,'+located.lat+','+located.lon+');nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|yes"](around:30000,'+located.lat+','+located.lon+');nwr["leisure"~"park|nature_reserve|garden|beach|water_park"](around:30000,'+located.lat+','+located.lon+');nwr["natural"~"waterfall|peak|cave|beach"](around:30000,'+located.lat+','+located.lon+');nwr["amenity"~"place_of_worship|arts_centre|theatre|community_centre"](around:30000,'+located.lat+','+located.lon+'););out center tags;';

        const res=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(query));
        if(!res.ok)throw new Error("Places service is temporarily unavailable. Please try again.");
        const data=await res.json();
        const mapped:Place[]=(data.elements||[])
          .map((item:any)=>({
            id:String(item.type||"x")+"-"+String(item.id),
            name:item.tags?.name||item.tags?.["name:en"]||"",
            type:item.tags?.tourism||item.tags?.historic||item.tags?.leisure||item.tags?.natural||item.tags?.amenity||"place",
            lat:Number(item.lat??item.center?.lat),
            lon:Number(item.lon??item.center?.lon)
          }))
          .filter((p:Place)=>p.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon))
          .filter((p:Place,i:number,a:Place[])=>a.findIndex(x=>x.name.toLowerCase()===p.name.toLowerCase())===i);

        if(cancelled)return;
        setPlaces(mapped);
        setDayPlans(makePlans(mapped,days,located));
        setMessage(mapped.length?"Plan ready — nearby places are grouped together to reduce unnecessary travel.":"No mapped places were found nearby.");
      }catch(e){
        if(!cancelled)setMessage(e instanceof Error?e.message:"Something went wrong.");
      }finally{
        if(!cancelled)setLoading(false);
      }
    }
    load();
    return()=>{cancelled=true};
  },[destination,days]);

  function makePlans(list:Place[],count:number,center:Geo):Day[]{
    if(!list.length)return Array.from({length:count},()=>({places:[]}));
    const sorted=[...list].sort((a,b)=>{
      const da=Math.hypot(a.lat-center.lat,a.lon-center.lon);
      const db=Math.hypot(b.lat-center.lat,b.lon-center.lon);
      return da-db;
    });
    const maxPerDay=Math.max(2,Math.min(5,Math.ceil(Math.min(sorted.length,count*4)/count)));
    const plans=Array.from({length:count},()=>({places:[] as Place[]}));
    sorted.slice(0,count*maxPerDay).forEach((place,index)=>plans[index%count].places.push(place));
    plans.forEach(day=>day.places.sort((a,b)=>a.lat-b.lat||a.lon-b.lon));
    return plans;
  }

  const maxPerDay=Math.max(2,Math.min(5,Math.ceil(Math.min(places.length,days*4)/days)));
  const allPlanned=dayPlans.flatMap(day=>day.places);
  const selectedIds=new Set(allPlanned.map(place=>place.id));
  const unplanned=places.filter(place=>!selectedIds.has(place.id));

  function removePlace(day:number,id:string){
    setDayPlans(current=>current.map((item,index)=>index===day?{places:item.places.filter(place=>place.id!==id)}:item));
  }

  function movePlace(from:number,id:string,to:number){
    if(from===to)return;
    const place=dayPlans[from]?.places.find(item=>item.id===id);
    if(!place||dayPlans[to]?.places.length>=maxPerDay)return;
    setDayPlans(current=>current.map((item,index)=>
      index===from?{places:item.places.filter(p=>p.id!==id)}:
      index===to?{places:[...item.places,place]}:item
    ));
  }

  function addPlace(day:number,place:Place){
    if(dayPlans[day].places.length>=maxPerDay)return;
    setDayPlans(current=>current.map((item,index)=>index===day?{places:[...item.places,place]}:item));
  }

  function regenerateDay(day:number){
    const available=[...unplanned,...dayPlans.flatMap((item,index)=>index===day?[]:item.places)];
    const center=geo||{lat:0,lon:0};
    const replacement=available
      .sort((a,b)=>Math.hypot(a.lat-center.lat,a.lon-center.lon)-Math.hypot(b.lat-center.lat,b.lon-center.lon))
      .slice(0,maxPerDay);
    setDayPlans(current=>current.map((item,index)=>index===day?{places:replacement}:item));
  }

  const mapUrl=geo
    ?"https://www.openstreetmap.org/export/embed.html?bbox="+(geo.lon-.12)+"%2C"+(geo.lat-.08)+"%2C"+(geo.lon+.12)+"%2C"+(geo.lat+.08)+"&layer=mapnik&marker="+geo.lat+"%2C"+geo.lon
    :"";

  const plannedCount=allPlanned.length;

  return <main className="itinerary-page">
    <nav className="dashboard-nav">
      <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
      <div className="dashboard-nav-links"><a href="/dashboard">Edit trip</a><a href={"/trip?"+params.toString()}>My plan</a><a href={"/places?"+params.toString()}>Explore places</a></div>
    </nav>

    <div className="page-navigation itinerary-navigation">
      <a className="page-nav secondary" href={"/places?"+params.toString()}>← Places to explore</a>
      <a className="page-nav primary" href={"/trip?"+params.toString()}>Back to trip →</a>
    </div>

    <section className="itinerary-hero">
      <div>
        <span className="eyebrow">02 · SMART ITINERARY</span>
        <h1>Where to visit <span>each day.</span></h1>
        <p>{destination||"Your destination"} · {days} {days===1?"day":"days"} · {people} {people===1?"traveller":"travellers"}</p>
      </div>
      <div className="itinerary-budget"><span>TRIP BUDGET</span><strong>₹{money(budget)}</strong><small>{travel} to destination · {localTravel} locally · {stay}</small></div>
    </section>

    <section className="itinerary-layout">
      <div className="itinerary-main">
        <div className="itinerary-intro">
          <div><span className="eyebrow">YOUR PLAN</span><h2>One day at a time.</h2><p>{loading?message:"Roveo keeps nearby places together so you spend more time exploring and less time travelling."}</p></div>
          <div className="itinerary-count"><strong>{plannedCount}</strong><span>places planned</span></div>
        </div>

        {loading&&<div className="itinerary-loading">{message}</div>}
        {!loading&&!dayPlans.length&&<div className="itinerary-loading">{message}</div>}

        <div className="itinerary-days">
          {dayPlans.map((day,dayIndex)=>{
            const totalKm=day.places.length>1?day.places.slice(1).reduce((sum,place,index)=>sum+distance(day.places[index],place),0):0;
            return <article className="itinerary-day" key={dayIndex}>
              <div className="itinerary-day-head">
                <div><span className="day-number">DAY {dayIndex+1}</span><h3>{dayIndex===0?"Arrival & nearby highlights":dayIndex===days-1?"Final discoveries & return":"Explore one area at a time"}</h3></div>
                <div className="day-stats"><strong>{day.places.length} places</strong><span>~{totalKm.toFixed(1)} km between stops</span></div>
              </div>

              <div className="planned-place-list">
                {day.places.map((place,index)=><div className="planned-place" key={place.id}>
                  <div className="place-order">{index+1}</div>
                  <div><strong>{place.name}</strong><small>{place.type.replaceAll("_"," ")}</small></div>
                  <div className="place-actions">
                    <button type="button" onClick={()=>removePlace(dayIndex,place.id)}>Remove</button>
                    {dayIndex>0&&<button type="button" onClick={()=>movePlace(dayIndex,place.id,dayIndex-1)}>← Day {dayIndex}</button>}
                    {dayIndex<days-1&&<button type="button" onClick={()=>movePlace(dayIndex,place.id,dayIndex+1)}>Day {dayIndex+2} →</button>}
                  </div>
                </div>)}
              </div>

              {!day.places.length&&<p className="empty-day">No places planned for this day yet.</p>}

              <div className="day-footer">
                <button type="button" onClick={()=>setEditingDay(editingDay===dayIndex?null:dayIndex)}>{editingDay===dayIndex?"Close":"Add places"}</button>
                <button type="button" onClick={()=>regenerateDay(dayIndex)}>↻ Regenerate day</button>
              </div>

              {editingDay===dayIndex&&<div className="add-place-panel">
                {unplanned.slice(0,16).map(place=><button type="button" key={place.id} disabled={day.places.length>=maxPerDay} onClick={()=>addPlace(dayIndex,place)}>
                  <span>+ {place.name}</span><small>{geo?distance({id:"center",name:"center",type:"center",lat:geo.lat,lon:geo.lon},place).toFixed(1)+" km away":""}</small>
                </button>)}
              </div>}
            </article>;
          })}
        </div>
      </div>

      <aside className="itinerary-side">
        <div className="itinerary-map-card">
          <span className="eyebrow">03 · MAP</span>
          <h2>Your trip area</h2>
          {geo?<iframe title="Roveo itinerary map" src={mapUrl} loading="lazy"/>:<div className="map-loading">Locating destination…</div>}
          {geo&&<a className="map-link" href={"https://www.openstreetmap.org/?mlat="+geo.lat+"&mlon="+geo.lon+"#map=12/"+geo.lat+"/"+geo.lon} target="_blank" rel="noreferrer">Open full map ↗</a>}
        </div>

        <div className="budget-breakdown">
          <span className="eyebrow">04 · TRIP DETAILS</span>
          <h2>Your preferences</h2>
          <div><span>Starting point</span><strong>{source||"—"}</strong></div>
          <div><span>Stay</span><strong>{stay}</strong></div>
          <div><span>Travel to destination</span><strong>{travel}</strong></div>
          <div><span>Getting around</span><strong>{localTravel}</strong></div>
          <div><span>Travellers</span><strong>{people}</strong></div>
          <div><span>Budget</span><strong>₹{money(budget)}</strong></div>
        </div>
      </aside>
    </section>
  </main>;
}

export default function ItineraryPage(){
  return <Suspense fallback={<main className="itinerary-page"><div className="map-loading">Loading your itinerary…</div></main>}><ItineraryContent/></Suspense>;
}
