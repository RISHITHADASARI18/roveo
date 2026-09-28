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
  const [radius,setRadius]=useState("30");
  const [loading,setLoading]=useState(true);
  const [message,setMessage]=useState("Finding places around your destination…");
  const [added,setAdded]=useState<string[]>([]);

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      if(!destination){setLoading(false);setMessage("No destination was provided.");return;}
      try{
        setLoading(true);setMessage("Locating your destination…");
        const geoRes=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(destination));
        if(!geoRes.ok)throw new Error("Could not locate the destination.");
        const geoResults=await geoRes.json();
        if(!geoResults[0])throw new Error("Destination was not found. Try a city or landmark.");
        const lat=Number(geoResults[0].lat),lon=Number(geoResults[0].lon);
        if(cancelled)return;
        setCenter({lat,lon});
        setMessage("Finding major attractions and smaller local places nearby…");

        const query='[out:json][timeout:45];(nwr["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork|information"](around:30000,'+lat+','+lon+');nwr["historic"~"monument|memorial|castle|ruins|archaeological_site|fort|yes"](around:30000,'+lat+','+lon+');nwr["leisure"~"park|nature_reserve|garden|beach|water_park"](around:30000,'+lat+','+lon+');nwr["natural"~"waterfall|peak|cave|beach"](around:30000,'+lat+','+lon+');nwr["amenity"~"place_of_worship|arts_centre|theatre|community_centre"](around:30000,'+lat+','+lon+'););out center tags;';
        const res=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(query));
        if(!res.ok)throw new Error("Places service is temporarily unavailable. Please try again.");
        const data=await res.json();
        const mapped:Place[]=(data.elements||[])
          .map((item:any)=>{
            const pLat=Number(item.lat??item.center?.lat),pLon=Number(item.lon??item.center?.lon);
            const tags=item.tags||{};
            const type=tags.tourism||tags.historic||tags.leisure||tags.natural||tags.amenity||"place";
            return {id:String(item.type||"x")+"-"+String(item.id),name:tags.name||tags["name:en"]||"",type,group:classify(tags),lat:pLat,lon:pLon,distance:haversine({lat,lon},{lat:pLat,lon:pLon})};
          })
          .filter((p:Place)=>p.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.distance<=30)
          .filter((p:Place,i:number,a:Place[])=>a.findIndex(x=>x.name.toLowerCase()===p.name.toLowerCase())===i)
          .sort((a:Place,b:Place)=>a.distance-b.distance)
          .slice(0,250);
        if(cancelled)return;
        setPlaces(mapped);
        setMessage(mapped.length?mapped.length+" mapped places found — major attractions and smaller nearby spots are included.":"No mapped places were found nearby.");
      }catch(e){if(!cancelled)setMessage(e instanceof Error?e.message:"Something went wrong.");}
      finally{if(!cancelled)setLoading(false);}
    }
    load();
    return()=>{cancelled=true};
  },[destination]);

  const visible=useMemo(()=>places.filter(p=>
    (category==="all"||p.group===category)&&
    p.distance<=Number(radius)&&
    p.name.toLowerCase().includes(search.toLowerCase())
  ),[places,category,radius,search]);

  function toggleAdd(id:string){
    setAdded(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);
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
        <p>Explore the destination properly — from the main attractions everyone knows to smaller mapped places nearby.</p>
      </div>
      <div className="explore-summary"><strong>{days} days</strong><span>{people} travellers</span><small>{source?source+" → ":""}{destination}</small></div>
    </section>

    <section className="places-content">
      <div className="places-toolbar">
        <div className="search-box"><span>⌕</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search places…" aria-label="Search places"/></div>
        <div className="filter-row">
          {categories.map(item=><button key={item.key} className={category===item.key?"filter active":"filter"} onClick={()=>setCategory(item.key)}>{item.label}</button>)}
          <label className="radius-filter">Within<select value={radius} onChange={e=>setRadius(e.target.value)}><option value="5">5 km</option><option value="10">10 km</option><option value="20">20 km</option><option value="30">30 km</option></select></label>
        </div>
      </div>

      {center&&<section className="map-section"><div className="section-heading"><div><span className="eyebrow">DESTINATION MAP</span><h2>See everything on the map.</h2><p>Every place in the current list gets its own pin, so you can see which attractions and smaller spots are close together.</p></div><span className="live-badge">{visible.length} pins</span></div><ExploreMap center={center} places={visible} selected={added} onToggle={toggleAdd}/></section>}

      <div className="places-result-head"><div><span className="eyebrow">DISCOVERY LIST</span><h2>{loading?"Searching…":visible.length+" places to explore"}</h2></div><span className="live-badge">{added.length} selected</span></div>
      <p className="places-message">{message}</p>

      <div className="places-grid">
        {!loading&&!visible.length&&<div className="empty-result"><strong>No places match these filters.</strong><span>Try a wider radius or a different category/search.</span></div>}
        {visible.map(place=><article className={"explore-card"+(added.includes(place.id)?" selected":"")} key={place.id}>
          <div className="explore-visual"><span>✦</span><small>{place.group}</small></div>
          <div className="explore-body"><div className="explore-meta"><span>{titleCase(place.type)}</span><strong>{place.distance.toFixed(1)} km away</strong></div><h3>{place.name}</h3><p>{place.group} · mapped location · {place.lat.toFixed(3)}, {place.lon.toFixed(3)}</p><div className="explore-actions"><button type="button" onClick={()=>toggleAdd(place.id)}>{added.includes(place.id)?"✓ Added to selection":"+ Add to trip"}</button><a href={"https://www.openstreetmap.org/?mlat="+place.lat+"&mlon="+place.lon+"#map=17/"+place.lat+"/"+place.lon} target="_blank" rel="noreferrer">View map ↗</a></div></div>
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
