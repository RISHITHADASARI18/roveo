import type { PlannerPlace } from "./itinerary-types";

export type PlannedPlace = PlannerPlace & {
  startTime: string;
  durationMinutes: number;
  travelTimeMinutes: number;
  routeDistanceKm?: number;
};

export type PlannedDay = {
  dayNumber: number;
  title: string;
  reason: string;
  items: PlannedPlace[];
  straightLineKm: number;
};

const DAY_START = 8 * 60 + 30;
const DAY_CAPACITY = 9 * 60;

export function haversineKm(a: PlannerPlace, b: PlannerPlace) {
  const p = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * p;
  const dLon = (b.longitude - a.longitude) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * p) * Math.cos(b.latitude * p) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function centroid(items: PlannerPlace[]) {
  return {
    latitude: items.reduce((sum, item) => sum + item.latitude, 0) / items.length,
    longitude: items.reduce((sum, item) => sum + item.longitude, 0) / items.length,
  };
}

function isFullDay(place: PlannerPlace) {
  return /ramoji|film city|theme park|amusement park|water park|large safari|wildlife safari/i.test(place.name + " " + (place.category || ""));
}

function categoryDuration(place: PlannerPlace) {
  const value = (place.name + " " + (place.category || "")).toLowerCase();
  if (isFullDay(place)) return 480;
  if (/zoo|aquarium|large museum|science museum/.test(value)) return 210;
  if (/fort|palace|museum|heritage|historic/.test(value)) return 150;
  if (/temple|mosque|church|place of worship|shrine/.test(value)) return 75;
  if (/market|bazaar|shopping/.test(value)) return 90;
  if (/park|garden|beach|nature|waterfall|viewpoint|lake|mountain/.test(value)) return 120;
  if (/activity|adventure|ride/.test(value)) return 150;
  return 90;
}

function roadEstimateMinutes(distanceKm: number) {
  // Conservative urban road estimate: allow for indirect roads and slower city traffic.
  return distanceKm <= 0.2 ? 5 : Math.max(8, Math.round((distanceKm * 1.35 / 22) * 60));
}

export function timeLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  return (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
}

function parseOpeningRanges(value?: string) {
  if (!value) return [];
  const ranges: Array<{start:number;end:number}> = [];
  const matches = value.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g);
  for (const match of matches) {
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (start >= 0 && end > start && end <= 24 * 60) ranges.push({start,end});
  }
  if (!ranges.length) {
    const simple = value.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (simple) {
      const toMinutes = (h:string,m:string|undefined,ampm:string) => ((Number(h)%12)+(ampm.toUpperCase()==="PM"?12:0))*60+Number(m||0);
      ranges.push({start:toMinutes(simple[1],simple[2],simple[3]),end:toMinutes(simple[4],simple[5],simple[6])});
    }
  }
  return ranges.sort((a,b)=>a.start-b.start);
}

export function fitStart(clock:number,duration:number,openingHours?:string) {
  const ranges=parseOpeningRanges(openingHours);
  if (!ranges.length) return clock;
  for (const range of ranges) {
    const start=Math.max(clock,range.start);
    if (start+duration<=range.end) return start;
  }
  // Keep the suggested slot visible but make the conflict obvious to the user.
  return clock;
}

function orderCluster(items: PlannerPlace[]) {
  if (items.length <= 2) return [...items];
  const remaining = [...items];
  let current = remaining.splice(0,1)[0];
  const ordered = [current];
  while (remaining.length) {
    let nearestIndex=0,nearestDistance=Infinity;
    remaining.forEach((candidate,index)=>{
      const distance=haversineKm(current,candidate);
      if(distance<nearestDistance){nearestDistance=distance;nearestIndex=index;}
    });
    current=remaining.splice(nearestIndex,1)[0];
    ordered.push(current);
  }
  return ordered;
}

export function buildSmartItinerary(inputPlaces: PlannerPlace[], dayCount: number): PlannedDay[] {
  const places=inputPlaces.filter((place,index,all)=>
    Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)&&place.name.trim()&&
    all.findIndex(candidate=>candidate.id===place.id)===index
  );
  const days=Math.max(1,Math.min(30,Math.floor(dayCount)||1));
  const clusters:PlannerPlace[][]=Array.from({length:days},()=>[]);
  const loads=Array.from({length:days},()=>0);

  // Schedule full-day attractions first and isolate them from other stops.
  const fullDayPlaces=places.filter(isFullDay);
  const regularPlaces=places.filter(place=>!isFullDay(place));
  for(const place of fullDayPlaces.slice(0,days)){
    const dayIndex=loads.indexOf(Math.min(...loads));
    clusters[dayIndex].push(place);
    loads[dayIndex]=DAY_CAPACITY;
  }

  // Add remaining places to the closest feasible day, considering visit time,
  // realistic road-transfer allowance, and the current day's total workload.
  const orderedByImportance=[...regularPlaces].sort((a,b)=>categoryDuration(b)-categoryDuration(a));
  for(const place of orderedByImportance){
    let bestDay=-1,bestScore=Infinity;
    for(let day=0;day<days;day++){
      if(clusters[day].some(isFullDay))continue;
      const transfer=clusters[day].length
        ?Math.min(...clusters[day].map(existing=>roadEstimateMinutes(haversineKm(existing,place))))
        :0;
      const proposed=loads[day]+categoryDuration(place)+transfer;
      if(proposed>DAY_CAPACITY)continue;
      const distance=clusters[day].length
        ?haversineKm(place,centroid(clusters[day]))
        :0;
      const score=distance*1.8+proposed/DAY_CAPACITY*2;
      if(score<bestScore){bestScore=score;bestDay=day;}
    }
    if(bestDay>=0){
      const transfer=clusters[bestDay].length
        ?Math.min(...clusters[bestDay].map(existing=>roadEstimateMinutes(haversineKm(existing,place))))
        :0;
      clusters[bestDay].push(place);
      loads[bestDay]+=categoryDuration(place)+transfer;
    }
  }

  return clusters.map((cluster,index)=>{
    const ordered=orderCluster(cluster);
    let clock=DAY_START,totalDistance=0;
    const items:PlannedPlace[]=[];
    ordered.forEach((place,placeIndex)=>{
      const previous=ordered[placeIndex-1];
      const distance=previous?haversineKm(previous,place):0;
      const travelTime=previous?roadEstimateMinutes(distance):0;
      if(previous){totalDistance+=distance;clock+=travelTime;}
      const durationMinutes=categoryDuration(place);
      clock=fitStart(clock,durationMinutes,place.openingHours);
      items.push({...place,startTime:timeLabel(clock),durationMinutes,travelTimeMinutes:travelTime});
      clock+=durationMinutes;
      if(placeIndex===0&&ordered.length>1)clock+=30;
    });
    const maxKm=ordered.length?Math.max(...ordered.map(place=>haversineKm(place,ordered[0]))):0;
    const spread=maxKm>35?"wide":maxKm>15?"regional":"nearby";
    const fullDay=ordered.some(isFullDay);
    const title=fullDay?"Full-day attraction":index===0?"Start with nearby highlights":index===days-1?"Final discoveries nearby":"Explore one area at a time";
    const reason=fullDay
      ?"This attraction is treated as a full-day visit. Other stops are not crowded into the same day."
      :ordered.length<=1?"A lighter day leaves enough time for travel and exploring."
      :spread==="nearby"?"Nearby stops are grouped together, with transfer time included between visits."
      : "The selected places are grouped geographically and transfer time is included in the daily workload.";
    return {dayNumber:index+1,title,reason,items,straightLineKm:Math.round(totalDistance*10)/10};
  });
}

export function rescheduleDay(items: PlannedPlace[], travelTimes: number[]) {
  let clock = DAY_START;
  return items.map((place, index) => {
    const travelTimeMinutes = index === 0 ? 0 : Math.max(0, Math.round(travelTimes[index - 1] ?? place.travelTimeMinutes ?? 0));
    clock += travelTimeMinutes;
    clock = fitStart(clock, place.durationMinutes, place.openingHours);
    const next = { ...place, startTime: timeLabel(clock), travelTimeMinutes };
    clock += place.durationMinutes;
    if (index === 0 && items.length > 1) clock += 30;
    return next;
  });
}
