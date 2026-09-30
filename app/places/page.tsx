"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";


type Place = {
  id:string;
  name:string;
  type:string;
  group:"Attraction"|"History"|"Nature"|"Culture"|"Activity";
  lat:number;
  lon:number;
  distance:number;
  description?:string;
  openingHours?:string;
  website?:string;
  wikipedia?:string;
  address?:string;
};

type GeoPoint={lat:number;lon:number};

const categories=[
  {key:"all",label:"All places"},
  {key:"Attraction",label:"Main attractions"},
  {key:"History",label:"History & landmarks"},
  {key:"Nature",label:"Nature & viewpoints"},
  {key:"Culture",label:"Culture & local spots"},
  {key:"Activity",label:"Activities"},
];

function haversine(a:GeoPoint,b:GeoPoint){
  const r=6371,p=Math.PI/180,dLat=(b.lat-a.lat)*p,dLon=(b.lon-a.lon)*p;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLon/2)**2;
  return 2*r*Math.asin(Math.sqrt(x));
}

function titleCase(value:string){
  return value.replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase());
}

function classify(tags:any):Place["group"]{
  const tourism=tags.tourism||"";
  const historic=tags.historic||"";
  const leisure=tags.leisure||"";
  const natural=tags.natural||"";
  const amenity=tags.amenity||"";
  if(["attraction","theme_park","museum","zoo","aquarium","gallery","viewpoint"].includes(tourism))return "Attraction";
  if(["monument","memorial","castle","ruins","archaeological_site","fort","yes"].includes(historic))return "History";
  if(["park","nature_reserve","garden","beach","water_park"].includes(leisure)||["waterfall","peak","cave","beach"].includes(natural))return "Nature";
  if(["place_of_worship","arts_centre","theatre","community_centre"].includes(amenity)||["artwork","information"].includes(tourism))return "Culture";
  return "Activity";
}

const ExploreMap = dynamic(() => import("./ExploreMap"), { ssr: false });
function PlacesContent(){
  const params=useSearchParams();
  const destination=params.get("destination")||"";
  const source=params.get("source")||"";
  const days=Number(params.get("days"))||1;
  const people=Number(params.get("people"))||1;
  const [places,setPlaces]=useState<Place[]>([]);
  const [center,setCenter]=useState<GeoPoint|null>(null);
  const [category,setCategory]=useState("all");
  const [search,setSearch]=useState("");
  const [liveQuery,setLiveQuery]=useState("");
  const [radius,setRadius]=useState("30");
  const [loading,setLoading]=useState(true);
  const [message,setMessage]=useState("Finding places around your destination…");
  const tripId=params.get("tripId")||"";
  const [added,setAdded]=useState<string[]>([]);
  const [savedPlaceIds,setSavedPlaceIds]=useState<Record<string,string>>({});
  const [saveMessage,setSaveMessage]=useState("");
  const [savingId,setSavingId]=useState<string|null>(null);

  useEffect(()=>{
    let cancelled=false;
    async function loadSaved(){
      if(!tripId)return;
      try{
        const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/places");
        if(!res.ok)throw new Error("Could not load saved places.");
        const data=await res.json();
        if(cancelled)return;
        const next:Record<string,string>={};
        const selected:string[]=[];
        for(const place of data.places||[]){
          const key=place.providerPlaceId||place.name;
          next[key]=String(place.id);
          selected.push(key);
        }
        setSavedPlaceIds(next);
        setAdded(selected);
      }catch(error){
        if(!cancelled)setSaveMessage(error instanceof Error?error.message:"Could not load saved places.");
      }
    }
    loadSaved();
    return()=>{cancelled=true};
  },[tripId]);

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      if(!destination){setLoading(false);setMessage("No destination was provided.");return;}
      try{
        setLoading(true);
        setMessage("Finding live places around your destination…");

        const res=await fetch(
          "/api/trips/"+encodeURIComponent(tripId)+"/places/discover?radiusKm="+encodeURIComponent(radius)+"&maxResults=200"+(liveQuery?"&q="+encodeURIComponent(liveQuery):""),
          {cache:"no-store"}
        );
        const data=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(data.error||"Could not discover places.");

        if(cancelled)return;

        setCenter({
          lat:Number(data.center?.latitude),
          lon:Number(data.center?.longitude)
        });

        const mapped:Place[]=(data.places||[])
          .map((place:any)=>({
            id:String(place.id),
            name:String(place.name||""),
            type:String(place.type||"place"),
            group:place.group as Place["group"],
            lat:Number(place.latitude),
            lon:Number(place.longitude),
            distance:Number(place.distanceKm||0),
            description:place.description,
            openingHours:place.openingHours,
            website:place.website,
            wikipedia:place.wikipedia,
            address:place.address
          }))
          .filter((place:Place)=>place.name&&Number.isFinite(place.lat)&&Number.isFinite(place.lon));

        setPlaces(mapped);
        const providerLabel=data.source==="google"?"Google Places":"OpenStreetMap";
        setMessage(
          mapped.length
            ? mapped.length+" live places found from "+providerLabel+(liveQuery?" for your search.":" — showing popular places to visit in this region.")
            : "No places were found nearby."
        );
      }catch(e){
        if(!cancelled)setMessage(e instanceof Error?e.message:"Something went wrong.");
      }finally{
        if(!cancelled)setLoading(false);
      }
    }
    load();
    return()=>{cancelled=true};
  },[destination,tripId,radius,liveQuery]);

  const visible=useMemo(()=>places.filter(p=>
    (category==="all"||p.group===category)&&
    p.distance<=Number(radius)&&
    p.name.toLowerCase().includes(search.toLowerCase())
  ),[places,category,radius,search]);

  async function toggleAdd(id:string){
    if(!tripId){
      setSaveMessage("This trip has no saved trip ID yet. Please start from the dashboard.");
      return;
    }
    const place=places.find(item=>item.id===id);
    if(!place)return;
    const existingId=savedPlaceIds[id];
    setSavingId(id);
    setSaveMessage("");
    try{
      if(existingId){
        const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/places?placeId="+encodeURIComponent(existingId),{method:"DELETE"});
        if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||"Could not remove the place.");
        setSavedPlaceIds(current=>{const next={...current};delete next[id];return next;});
        setAdded(current=>current.filter(item=>item!==id));
      }else{
        const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/places",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            provider:"openstreetmap",
            providerPlaceId:id,
            name:place.name,
            latitude:place.lat,
            longitude:place.lon,
            category:place.group,
            description:place.description||null,
            websiteUrl:place.website||null,
            address:place.address||null
          })
        });
        const data=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(data.error||"Could not save the place.");
        setSavedPlaceIds(current=>({...current,[id]:String(data.place.id)}));
        setAdded(current=>current.includes(id)?current:[...current,id]);
      }
    }catch(error){
      setSaveMessage(error instanceof Error?error.message:"Could not save the place.");
    }finally{
      setSavingId(null);
    }
  }

  return <main className="places-page">
    <nav className="dashboard-nav">
      <a className="brand" href="/"><span className="brand-mark">R</span><span>roveo</span></a>
      <div className="dashboard-nav-links"><a href="/dashboard">Edit trip</a><a href="/trip">My plan</a><a className="active" href="/places">Explore</a></div>
    </nav>

    <div className="page-navigation places-navigation">
      <a className="page-nav secondary" href={"/trip?"+params.toString()}>← Back to plan</a>
      <a className="page-nav primary" href={"/itinerary?"+params.toString()}>Next: itinerary →</a>
    </div>

    <section className="places-hero">
      <div>
        <span className="eyebrow">ROVEO · DISCOVER</span>
        <h1>Places to <span>Explore.</span></h1>
        <p>Explore the destination properly — popular must-see places are loaded from live place data, and you can search for exactly what you want to visit.</p>
      </div>
      <div className="explore-summary"><strong>{days} days</strong><span>{people} travellers</span><small>{source?source+" → ":""}{destination}</small></div>
    </section>

    <section className="places-content">
      <div className="places-toolbar">
        <div className="search-box"><span>⌕</span><input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")setLiveQuery(search.trim())}} placeholder="Search what you want to visit…" aria-label="Search what you want to visit"/><button type="button" onClick={()=>setLiveQuery(search.trim())}>Search live</button></div>
        <div className="filter-row">
          {categories.map(item=><button key={item.key} className={category===item.key?"filter active":"filter"} onClick={()=>setCategory(item.key)}>{item.label}</button>)}
          <label className="radius-filter">Within<select value={radius} onChange={e=>setRadius(e.target.value)}><option value="5">5 km</option><option value="10">10 km</option><option value="20">20 km</option><option value="30">30 km</option></select></label>
        </div>
      </div>

      {center&&<section className="map-section"><div className="section-heading"><div><span className="eyebrow">DESTINATION MAP</span><h2>See everything on the map.</h2><p>Every place in the current list gets its own pin, so you can see which attractions and smaller spots are close together.</p></div><span className="live-badge">{visible.length} pins</span></div><ExploreMap center={center} places={visible} selected={added} onToggle={toggleAdd}/></section>}

      <div className="places-result-head"><div><span className="eyebrow">{liveQuery?"LIVE SEARCH":"MUST-SEE PLACES"}</span><h2>{loading?"Searching…":visible.length+" places to explore"}</h2></div><span className="live-badge">{added.length} selected</span></div>
      <p className="places-message">{message}</p>{saveMessage&&<p className="places-message">{saveMessage}</p>}<p className="places-detail-note">Each place card shows the available real-world details from the mapped place record, such as a description, address, opening hours and official or reference links. Details vary by place.</p>

      <div className="places-grid">
        {!loading&&!visible.length&&<div className="empty-result"><strong>No places match these filters.</strong><span>Try a wider radius or a different category/search.</span></div>}
        {visible.map(place=><article className={"explore-card"+(added.includes(place.id)?" selected":"")} key={place.id}>
          <div className="explore-visual"><span>✦</span><small>{place.group}</small></div>
          <div className="explore-body"><div className="explore-meta"><span>{titleCase(place.type)}</span><strong>{place.distance.toFixed(1)} km away</strong></div><h3>{place.name}</h3><p className="explore-description">{place.description||("A "+place.group.toLowerCase()+" location mapped near "+destination+".")}</p><div className="explore-facts">{place.address&&<span>📍 {place.address}</span>}{place.openingHours&&<span>🕒 {place.openingHours}</span>}</div><div className="explore-actions"><button type="button" onClick={()=>toggleAdd(place.id)} disabled={savingId===place.id}>{savingId===place.id?"Saving…":added.includes(place.id)?"✓ Saved to trip":"+ Add to trip"}</button><a href={place.website||("https://www.openstreetmap.org/?mlat="+place.lat+"&mlon="+place.lon+"#map=17/"+place.lat+"/"+place.lon)} target="_blank" rel="noreferrer">{place.website?"Official site ↗":"View map ↗"}</a>{place.wikipedia&&<a href={"https://"+place.wikipedia.replace(/^https?:\/\//,"")} target="_blank" rel="noreferrer">Wikipedia ↗</a>}</div></div>
        </article>)}
      </div>

      <section className="explore-next">
        <div><span className="eyebrow">NEXT STEP</span><h2>Turn your picks into a better day plan.</h2><p>Your selected places can be used by the itinerary engine when we build the next planning layer.</p></div>
        <a className="primary-button" href={"/itinerary?"+params.toString()}>Build the itinerary <span>→</span></a>
      </section>
    </section>
  </main>
}

export default function PlacesPage(){return <Suspense fallback={<main className="places-page"><div className="map-loading">Loading places to explore…</div></main>}><PlacesContent/></Suspense>}
