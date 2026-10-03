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
  {key:"Viewpoints",label:"Viewpoints",icon:"◉",terms:/viewpoint|scenic|lookout|panorama|observation/i},
  {key:"Waterfalls",label:"Waterfalls",icon:"≋",terms:/waterfall|falls/i},
  {key:"Nature & Wildlife",label:"Nature & Wildlife",icon:"✦",terms:/wildlife|wildlife sanctuary|nature reserve|forest|national park|sanctuary/i},
  {key:"Beaches",label:"Beaches",icon:"⌁",terms:/beach|coast|shore/i},
  {key:"History & Heritage",label:"History & Heritage",icon:"◈",terms:/fort|palace|museum|monument|historic|heritage|memorial|ruin|castle|archaeological/i},
  {key:"Temples & Spiritual",label:"Temples & Spiritual",icon:"◇",terms:/temple|church|mosque|shrine|worship|cathedral|basilica/i},
  {key:"Cities & Towns",label:"Cities & Towns",icon:"⌂",terms:/city|town|municipality/i},
  {key:"Lakes & Backwaters",label:"Lakes & Backwaters",icon:"≈",terms:/lake|backwater|lagoon|kuttanad/i},
  {key:"Parks & Gardens",label:"Parks & Gardens",icon:"❋",terms:/park|garden|botanical/i},
  {key:"Hills & Mountains",label:"Hills & Mountains",icon:"△",terms:/hill|mountain|peak|mount/i},
  {key:"Culture & Local",label:"Culture & Local",icon:"✧",terms:/culture|art|theatre|gallery|cultural|arts centre|information/i},
  {key:"Activities & Adventure",label:"Activities & Adventure",icon:"↗",terms:/activity|adventure|amusement|theme park|zoo|aquarium|attraction/i},
];

function placeCategories(place:Place){
  const text=(place.name+" "+place.type+" "+(place.description||"")+" "+place.group).toLowerCase();
  return categories.filter(category=>category.terms.test(text)).map(category=>category.key);
}

function isMainDestination(place:Place){
  const text=place.name.toLowerCase();
  return /munnar|alappuzha|alleppey|kochi|fort kochi|thiruvananthapuram|trivandrum|guruvayur|guruvayoor|thekkady|wayanad|kovalam|varkala|kozhikode|calicut|kumarakom|bekal|kollam|wagamon|vagamon|malampuzha|ponmudi|jatayu|jadayu|sree padmanabhaswamy|padmanabhaswamy|sabarimala|kuttanad|pookode/i.test(text);
}

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
function PlaceCard({place,destination,added,savingId,toggleAdd}:{place:Place;destination:string;added:string[];savingId:string|null;toggleAdd:(id:string)=>void}){
  const generic=place.description?.startsWith("Popular place to visit in ");
  const description=generic ? "" : place.description||"";
  return <article className={"explore-card"+(added.includes(place.id)?" selected":"")}>
    <div className="explore-visual"><span>✦</span><small>{place.group}</small></div>
    <div className="explore-body">
      <div className="explore-meta"><span>{titleCase(place.type)}</span><strong>{place.distance.toFixed(1)} km away</strong></div>
      <h3>{place.name}</h3>
      {description&&<p className="explore-description">{description}</p>}
      <div className="explore-facts">{place.address&&<span>📍 {place.address}</span>}{place.openingHours&&<span>🕒 {place.openingHours}</span>}</div>
      <div className="explore-actions">
        <button type="button" onClick={()=>toggleAdd(place.id)} disabled={savingId===place.id}>{savingId===place.id?"Saving…":added.includes(place.id)?"✓ Saved to trip":"+ Add to trip"}</button>
        <a href={place.website||("https://www.openstreetmap.org/?mlat="+place.lat+"&mlon="+place.lon+"#map=17/"+place.lat+"/"+place.lon)} target="_blank" rel="noreferrer">{place.website?"Official site ↗":"View map ↗"}</a>
        {place.wikipedia&&<a href={"https://"+place.wikipedia.replace(/^https?:\/\//,"")} target="_blank" rel="noreferrer">Wikipedia ↗</a>}
      </div>
    </div>
  </article>;
}


function PlacesContent(){
  const params=useSearchParams();
  const destination=params.get("destination")||"";
  const source=params.get("source")||"";
  const days=Number(params.get("days"))||1;
  const people=Number(params.get("people"))||1;
  const [places,setPlaces]=useState<Place[]>([]);
  const [center,setCenter]=useState<GeoPoint|null>(null);
  const [category,setCategory]=useState("all");
  const [openCategory,setOpenCategory]=useState<string|null>(null);
  const [search,setSearch]=useState("");
  const [liveQuery,setLiveQuery]=useState("");
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

        let discoveryUrl;
        if (tripId) {
          discoveryUrl="/api/trips/"+encodeURIComponent(tripId)+"/places/discover?maxResults=1000";
          const geoRes=await fetch("/api/geocode/search?q="+encodeURIComponent(destination),{cache:"no-store"});
          const geoData=await geoRes.json().catch(()=>({}));
          const location=Array.isArray(geoData.locations)?geoData.locations[0]:null;
          if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))) {
            const geoParams=new URLSearchParams({lat:String(location.lat),lon:String(location.lon)});
            if(location.boundingBox){
              geoParams.set("south",String(location.boundingBox.south));
              geoParams.set("north",String(location.boundingBox.north));
              geoParams.set("west",String(location.boundingBox.west));
              geoParams.set("east",String(location.boundingBox.east));
            }
            discoveryUrl+="&"+geoParams.toString();
          }
        } else {
          discoveryUrl="/api/places/discover?destination="+encodeURIComponent(destination)+"&maxResults=200";
        }
        const res=await fetch(discoveryUrl+(liveQuery?"&q="+encodeURIComponent(liveQuery):""),{cache:"no-store"});
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
            ? mapped.length+" live places found from "+providerLabel+(liveQuery?" for your search.":" — all discovered places are shown, ranked by importance.")
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
  },[destination,tripId,liveQuery]);

  const visible=useMemo(()=>places.filter(p=>{
    const categoryMatch=category==="all" || p.group===category || placeCategories(p).includes(category);
    return categoryMatch && p.name.toLowerCase().includes(search.toLowerCase());
  }),[places,category,search]);

  const mainPlaces=useMemo(()=>{
    const preferred=places.filter(isMainDestination);
    const fallback=places.filter(p=>!placeCategories(p).some(Boolean));
    return [...preferred,...fallback].filter((place,index,array)=>array.findIndex(item=>item.id===place.id)===index).slice(0,18);
  },[places]);

  const categoryPlaces=useMemo(()=>{
    if(!openCategory)return [];
    const selected=categories.find(item=>item.key===openCategory);
    if(!selected)return [];
    return places.filter(place=>selected.terms.test((place.name+" "+place.type+" "+(place.description||"")+" "+place.group))).filter((place,index,array)=>array.findIndex(item=>item.id===place.id)===index);
  },[places,openCategory]);

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
            provider:place.id.startsWith("google-")?"google":"openstreetmap",
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
        <p>Roveo finds a broad set of real places across your destination, ranks the most important ones first, and lets you choose any places you want for your trip.</p>
      </div>
      <div className="explore-summary"><strong>{days} days</strong><span>{people} travellers</span><small>{source?source+" → ":""}{destination}</small></div>
    </section>

    <section className="places-content">
      <div className="places-toolbar">
        <div className="search-box"><span>⌕</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search the complete collection…" aria-label="Filter the places Roveo found"/><button type="button" onClick={()=>setLiveQuery(search.trim())}>Find something specific</button></div>
      </div>

      {!loading&&<section className="place-explorer">
        <div className="section-heading">
          <div><span className="eyebrow">EXPLORE BY TYPE</span><h2>What kind of places do you want?</h2><p>Start with the important destinations, then open a category to browse all the matching places. A place can appear in more than one category when it genuinely fits.</p></div>
          <span className="live-badge">{categories.length} categories</span>
        </div>
        <div className="category-card-grid">
          {categories.map(item=>{
            const count=places.filter(place=>item.terms.test((place.name+" "+place.type+" "+(place.description||"")+" "+place.group))).filter((place,index,array)=>array.findIndex(p=>p.id===place.id)===index).length;
            return <button type="button" key={item.key} className={"category-card"+(openCategory===item.key?" active":"")} onClick={()=>{setOpenCategory(openCategory===item.key?null:item.key);setCategory("all");}}>
              <span className="category-card-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{count} places</small></span><b>→</b>
            </button>;
          })}
        </div>
        {openCategory&&<section className="category-results">
          <div className="section-heading"><div><span className="eyebrow">CATEGORY</span><h2>{categories.find(item=>item.key===openCategory)?.label}</h2><p>Browse the complete list for this type. Repeated places across different categories are intentional when they are relevant to both.</p></div><button type="button" className="category-close" onClick={()=>setOpenCategory(null)}>Close</button></div>
          {categoryPlaces.length>0
            ? <div className="places-grid">{categoryPlaces.map(place=><PlaceCard key={place.id} place={place} destination={destination} added={added} savingId={savingId} toggleAdd={toggleAdd}/>)}</div>
            : <div className="empty-result"><strong>No places are currently classified under this category.</strong><span>The category is ready; once the discovery service returns matching records, they will appear here.</span></div>}
        </section>}
      </section>}

      {center&&<section className="map-section"><div className="section-heading"><div><span className="eyebrow">DESTINATION MAP</span><h2>See everything on the map.</h2><p>Every place in the current list gets its own pin, so you can see which attractions and smaller spots are close together.</p></div><span className="live-badge">{visible.length} pins</span></div><ExploreMap center={center} places={visible} selected={added} onToggle={toggleAdd}/></section>}

      <div className="places-result-head">
        <div>
          <span className="eyebrow">{liveQuery?"LIVE SEARCH":"PLACES TO VISIT"}</span>
          <h2>{loading?"Finding places…":visible.length+" places found"}</h2>
        </div>
        <span className="live-badge">{added.length} selected</span>
      </div>
      <p className="places-message">{message}</p>
      {saveMessage&&<p className="places-message">{saveMessage}</p>}

      {!loading&&visible.length>0&&(()=>{
        const highlights=(category==="all"?mainPlaces:visible).slice(0,18);
        return <>
          <section className="places-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">START HERE</span>
                <h2>{category==="all"?"Main places to visit.":"Places in this selection."}</h2>
                <p>{category==="all"?"The main destinations and well-known places stay up front. The detailed types are organized into the category boxes above, so waterfalls and similar places do not overwhelm the main list.":"Browse the places matching your current selection."}</p>
              </div>
              <span className="live-badge">{highlights.length} places</span>
            </div>
            <div className="places-grid">
              {highlights.map(place=><PlaceCard key={place.id} place={place} destination={destination} added={added} savingId={savingId} toggleAdd={toggleAdd}/>)}
            </div>
          </section>

          {category==="all"&&visible.length>highlights.length&&<section className="places-section">
            <div className="section-heading">
              <div><span className="eyebrow">COMPLETE COLLECTION</span><h2>Everything else Roveo found.</h2><p>Use the category boxes above when you want the full waterfall, viewpoint, nature, beach, heritage, spiritual, or activity lists.</p></div>
              <span className="live-badge">{visible.length-highlights.length} more</span>
            </div>
            <div className="places-grid">
              {visible.filter(place=>!highlights.some(item=>item.id===place.id)).map(place=><PlaceCard key={place.id} place={place} destination={destination} added={added} savingId={savingId} toggleAdd={toggleAdd}/>)}
            </div>
          </section>}
        </>;
      })()}

      {!loading&&!visible.length&&<div className="empty-result"><strong>No places match these filters.</strong><span>Choose “Entire destination” or try a different category/search.</span></div>}

      <section className="explore-next">
        <div><span className="eyebrow">NEXT STEP</span><h2>Turn your picks into a better day plan.</h2><p>Your selected places can be used by the itinerary engine when we build the next planning layer.</p></div>
        <a className="primary-button" href={"/itinerary?"+params.toString()}>Build the itinerary <span>→</span></a>
      </section>
    </section>
  </main>
}

export default function PlacesPage(){return <Suspense fallback={<main className="places-page"><div className="map-loading">Loading places to explore…</div></main>}><PlacesContent/></Suspense>}
