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
  {key:"National Parks & Sanctuaries",label:"National Parks & Sanctuaries",icon:"⌖",terms:/national park|wildlife sanctuary|sanctuary|biosphere reserve/i},
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

const curatedDescriptions:Record<string,string>={
  "Munnar":"Hill station known for tea plantations, misty valleys and mountain scenery.",
  "Alappuzha":"Famous for Kerala backwaters, houseboats and relaxed waterside landscapes.",
  "Alleppey":"Famous for Kerala backwaters, houseboats and relaxed waterside landscapes.",
  "Kochi":"Historic coastal city known for Fort Kochi, heritage streets and its harbour.",
  "Fort Kochi":"Historic waterfront area with colonial-era buildings, art spaces and Chinese fishing nets.",
  "Thiruvananthapuram":"Kerala’s capital, known for heritage sites, museums and the Padmanabhaswamy Temple.",
  "Guruvayur":"Temple town best known for the Guruvayur Sri Krishna Temple.",
  "Thekkady":"Gateway to Periyar, with forest landscapes and wildlife experiences around the lake.",
  "Wayanad":"Green hill district known for forests, viewpoints, waterfalls and wildlife.",
  "Kovalam":"Coastal destination known for its beaches, lighthouse and seaside views.",
  "Varkala":"Clifftop coastal destination known for its beach, views and relaxed promenade.",
  "Kozhikode":"Historic Malabar city known for its coastline, food culture and heritage.",
  "Kumarakom":"Backwater destination on Vembanad Lake, known for waterways and birdlife.",
  "Bekal":"Coastal area known for Bekal Fort and wide Arabian Sea views.",
  "Kollam":"Historic coastal city and gateway to Kerala’s southern backwaters.",
  "Vagamon":"Quiet hill destination known for green meadows, pine forests and valley views.",
  "Malampuzha":"Popular Palakkad destination with a dam, gardens and nearby hill scenery.",
  "Ponmudi":"Hill retreat near Thiruvananthapuram known for winding roads and forested hills.",
  "Jatayu Earth's Center":"Hilltop attraction featuring the Jatayu sculpture and panoramic views.",
  "Athirappilly Falls":"Kerala’s best-known waterfall, set amid forested landscapes.",
  "Kuttanad":"Low-lying backwater region known for waterways and paddy fields.",
  "Pookode Lake":"Freshwater lake in Wayanad surrounded by forested hills.",
  "Sabarimala":"Major pilgrimage destination in the forested hills of Pathanamthitta."
};

function conciseDescription(place:Place){
  const curated=curatedDescriptions[place.name.trim()];
  if(curated)return curated;
  const raw=(place.description||"").replace(/\s+/g," ").trim();
  if(!raw || /^Popular place to visit in /i.test(raw))return "";
  const first=raw.split(/(?<=[.!?])\s+/)[0];
  return first.length<=155 ? first : first.slice(0,152).replace(/\s+\S*$/,"")+"…";
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
  const description=conciseDescription(place);
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
  const destinationParam=params.get("destination")||"";
  const source=params.get("source")||"";
  const days=Number(params.get("days"))||1;
  const people=Number(params.get("people"))||1;
  type TripDestination={id:string;name:string;lat:number;lon:number;order:number;days:number|null};
  type NearbyDestination={name:string;latitude:number;longitude:number;distanceKm:number;type:string};
  type DestinationResult={destination:TripDestination;places:Place[];center:GeoPoint|null;message:string;nearbyDestinations:NearbyDestination[]};
  const [destinations,setDestinations]=useState<TripDestination[]>([]);
  const [destinationResults,setDestinationResults]=useState<DestinationResult[]>([]);
  const [activeDestinationId,setActiveDestinationId]=useState("");
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
  const [discoveryRefresh,setDiscoveryRefresh]=useState(0);

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
      if(!tripId && !destinationParam){
        setLoading(false);
        setMessage("No destination was provided.");
        return;
      }
      try{
        setLoading(true);
        setMessage("Finding places for each destination…");

        let tripDestinations:TripDestination[]=[];
        if(tripId){
          const destinationRes=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/destinations",{cache:"no-store"});
          const destinationData=await destinationRes.json().catch(()=>({}));
          if(destinationRes.ok && Array.isArray(destinationData.destinations)){
            tripDestinations=destinationData.destinations.map((item:any,index:number)=>({
              id:String(item.id),
              name:String(item.name||""),
              lat:Number(item.lat),
              lon:Number(item.lon),
              order:Number(item.order)||index+1,
              days:Number.isFinite(Number(item.days))?Number(item.days):null
            })).filter((item:TripDestination)=>item.name&&Number.isFinite(item.lat)&&Number.isFinite(item.lon));
          }
        }

        if(!tripDestinations.length && destinationParam){
          const geoRes=await fetch("/api/geocode/search?q="+encodeURIComponent(destinationParam),{cache:"no-store"});
          const geoData=await geoRes.json().catch(()=>({}));
          const location=Array.isArray(geoData.locations)?geoData.locations[0]:null;
          if(location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))){
            tripDestinations=[{
              id:"param-"+destinationParam.toLowerCase().replace(/[^a-z0-9]+/g,"-"),
              name:destinationParam,
              lat:Number(location.lat),
              lon:Number(location.lon),
              order:1,
              days
            }];
          }else{
            tripDestinations=[{
              id:"param-"+destinationParam.toLowerCase().replace(/[^a-z0-9]+/g,"-"),
              name:destinationParam,lat:0,lon:0,order:1,days
            }];
          }
        }

        if(!tripDestinations.length) throw new Error("No destinations were found for this trip.");
        if(cancelled)return;
        setDestinations(tripDestinations);
        const requestedActive=activeDestinationId && tripDestinations.some(item=>item.id===activeDestinationId)
          ? activeDestinationId : tripDestinations[0].id;
        setActiveDestinationId(requestedActive);

        const results:DestinationResult[]=[];
        for(const item of tripDestinations){
          if(cancelled) return;
          try{
            let discoveryUrl="/api/trips/"+encodeURIComponent(tripId)+"/places/discover?maxResults=1000&destinationId="+encodeURIComponent(item.id);
            if(!tripId){
              discoveryUrl="/api/places/discover?destination="+encodeURIComponent(item.name)+"&maxResults=200";
            }else{
              const geoParams=new URLSearchParams({lat:String(item.lat),lon:String(item.lon)});
              discoveryUrl+="&"+geoParams.toString();
            }
            if(liveQuery) discoveryUrl+="&q="+encodeURIComponent(liveQuery);
            const res=await fetch(discoveryUrl,{cache:"no-store"});
            const data=await res.json().catch(()=>({}));
            if(!res.ok) throw new Error(data.error||"Could not discover places.");
            const mapped:Place[]=(data.places||[])
              .map((place:any)=>({
                id:String(place.id),name:String(place.name||""),type:String(place.type||"place"),
                group:place.group as Place["group"],lat:Number(place.latitude),lon:Number(place.longitude),
                distance:Number(place.distanceKm||0),description:place.description,openingHours:place.openingHours,
                website:place.website,wikipedia:place.wikipedia,address:place.address
              }))
              .filter((place:Place)=>place.name&&Number.isFinite(place.lat)&&Number.isFinite(place.lon));
            results.push({
              destination:item,
              places:mapped,
              center:{lat:Number(data.center?.latitude),lon:Number(data.center?.longitude)},
              message:mapped.length ? mapped.length+" places found." : "No places were found nearby."
            });
          }catch(error){
            results.push({
              destination:item,places:[],center:null,
              message:error instanceof Error?error.message:"Could not discover places.",
              nearbyDestinations:[]
            });
          }
        }

        if(cancelled)return;
        setDestinationResults(results);
        const selected=results.find(item=>item.destination.id===requestedActive)||results[0];
        setPlaces(selected?.places||[]);
        setCenter(selected?.center||null);
        setMessage(results.length===1 ? (results[0]?.message||"") : "Each destination has its own independent place discovery.");
      }catch(e){
        if(!cancelled)setMessage(e instanceof Error?e.message:"Something went wrong.");
      }finally{
        if(!cancelled)setLoading(false);
      }
    }
    load();
    return()=>{cancelled=true};
  },[destinationParam,tripId,liveQuery,discoveryRefresh]);

  useEffect(()=>{
    if(!activeDestinationId)return;
    const selected=destinationResults.find(item=>item.destination.id===activeDestinationId);
    if(selected){
      setPlaces(selected.places);
      setCenter(selected.center);
      setMessage(selected.message);
    }
  },[activeDestinationId,destinationResults]);

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

  async function addNearbyDestination(nearby:NearbyDestination){
    if(!tripId)return;
    try{
      const res=await fetch("/api/trips/"+encodeURIComponent(tripId)+"/destinations",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({destination:{
          name:nearby.name,lat:nearby.latitude,lon:nearby.longitude
        }})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Could not add destination.");
      setActiveDestinationId(String(data.destination?.id||""));
      setDiscoveryRefresh(value=>value+1);
    }catch(error){
      setSaveMessage(error instanceof Error?error.message:"Could not add destination.");
    }
  }

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
        <p>Discover the places worth adding to your trip, from major destinations to smaller local spots.</p>
      </div>
      <div className="explore-summary"><strong>{days} days</strong><span>{people} travellers</span><small>{source?source+" → ":""}{destinations.length>1?"Multiple destinations":destination}</small></div>
    </section>

    <section className="places-content">
      <div className="places-toolbar">
        <div className="search-box"><span>⌕</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search the complete collection…" aria-label="Filter the places Roveo found"/><button type="button" onClick={()=>setLiveQuery(search.trim())}>Find something specific</button></div>
      </div>
      {!loading && activeDestinationId && destinationResults.find(item=>item.destination.id===activeDestinationId)?.nearbyDestinations.length>0 && <section className="nearby-destinations">
        <div className="section-heading">
          <div><span className="eyebrow">NEARBY DESTINATIONS</span><h2>Want to add another stop?</h2><p>These are nearby cities and towns found around the selected destination. They are suggestions only and are never added automatically.</p></div>
          <span className="live-badge">Suggestions</span>
        </div>
        <div className="nearby-destination-grid">
          {destinationResults.find(item=>item.destination.id===activeDestinationId)?.nearbyDestinations.map(nearby=>
            <div className="nearby-destination-card" key={nearby.name}>
              <div><strong>{nearby.name}</strong><small>{nearby.distanceKm.toFixed(0)} km · {titleCase(nearby.type)}</small></div>
              <button type="button" onClick={()=>addNearbyDestination(nearby)}>+ Add destination</button>
            </div>
          )}
        </div>
      </section>}
      {!loading && destinations.length>1 && <section className="destination-switcher">
        <div className="section-heading">
          <div><span className="eyebrow">YOUR ROUTE</span><h2>Explore each destination separately.</h2><p>Roveo discovers places independently for every destination in your trip.</p></div>
          <span className="live-badge">{destinations.length} destinations</span>
        </div>
        <div className="destination-switcher-grid">
          {destinations.map((item,index)=><button key={item.id} type="button" className={"destination-switch"+(activeDestinationId===item.id?" active":"")} onClick={()=>setActiveDestinationId(item.id)}>
            <span>{index+1}</span><strong>{item.name}</strong>{item.days&&<small>{item.days} days</small>}
          </button>)}
        </div>
      </section>}

      {!loading&&<section className="place-explorer">
        <div className="section-heading">
          <div><span className="eyebrow">EXPLORE BY TYPE</span><h2>Explore by category</h2><p>Pick a type to browse matching places. Some places appear in more than one category when they genuinely fit.</p></div>
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

      {center&&<section className="map-section"><div className="section-heading"><div><span className="eyebrow">DESTINATION MAP</span><h2>See everything on the map.</h2><p>See where your discovered places sit and which ones are close together.</p></div><span className="live-badge">{visible.length} pins</span></div><ExploreMap center={center} places={visible} selected={added} onToggle={toggleAdd}/></section>}

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
                <p>{category==="all"?"Start with the most important destinations. Use the categories above when you want a specific type of place.":"Browse the places matching your current selection."}</p>
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
