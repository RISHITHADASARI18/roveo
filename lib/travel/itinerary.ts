import type { PlannerPlace } from "./itinerary-types";

export type PlannedPlace = PlannerPlace & {
  startTime: string;
  durationMinutes: number;
  travelTimeMinutes: number;
  routeDistanceKm?: number;
  openingHoursConflict?: boolean;
};

export type PlannedDay = {
  dayNumber: number;
  title: string;
  reason: string;
  items: PlannedPlace[];
  straightLineKm: number;
};

const DAY_START = 8 * 60;
const DAY_END = 22 * 60;
const MAX_DAY_WORK = 10 * 60;

export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
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
  return /ramoji|film city|theme park|amusement park|water park|wonderla|imagica|snow world|large safari|wildlife safari/i.test(place.name + " " + (place.category || ""));
}

function categoryDuration(place: PlannerPlace) {
  const value = (place.name + " " + (place.category || "")).toLowerCase();
  if (isFullDay(place)) return 480;
  if (/nehru zoo|zoological park|city zoo/.test(value)) return 240;
  if (/golconda fort/.test(value)) return 180;
  if (/ramoji film city/.test(value)) return 480;
  if (/hussain sagar|tank bund|necklace road/.test(value)) return 90;
  if (/charminar/.test(value)) return 75;
  if (/birla mandir/.test(value)) return 60;
  if (/qutb shahi tomb|salar jung|chowmahalla|falaknuma/.test(value)) return 120;
  if (/zoo|aquarium|large museum|science museum/.test(value)) return 240;
  if (/fort|palace|museum|heritage|historic/.test(value)) return 180;
  if (/temple|mosque|church|place of worship|shrine/.test(value)) return 75;
  if (/market|bazaar|shopping/.test(value)) return 90;
  if (/lake|viewpoint/.test(value)) return 90;
  if (/park|garden|beach|nature|waterfall|mountain/.test(value)) return 120;
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

function defaultOpeningHours(place: PlannerPlace) {
  const name = place.name.toLowerCase();
  // Prefer provider-supplied opening hours. These known-place fallbacks are
  // conservative planning windows; verify holiday/weekly closures before travel.
  if (/ramoji film city/.test(name)) return "09:00-17:30";
  if (/nehru zoo|zoological park/.test(name)) return "08:30-17:00";
  if (/golconda fort/.test(name)) return "09:00-17:00";
  if (/charminar/.test(name)) return "09:00-17:30";
  if (/hussain sagar|tank bund|necklace road/.test(name)) return "06:00-22:00";
  if (/birla mandir/.test(name)) return "07:00-12:00, 15:00-21:00";
  if (/qutb shahi tomb/.test(name)) return "09:30-17:30";
  if (/salar jung|chowmahalla palace|purani haveli/.test(name)) return "10:00-17:00";
  if (/market|bazaar|shopping/.test(name)) return "10:00-22:00";
  if (/temple|mandir|mosque|church|shrine/.test(name)) return "06:00-21:00";
  if (/lake|tank bund|viewpoint/.test(name)) return "06:00-22:00";
  if (/zoo|aquarium|park|garden|waterfall|fort|palace|museum|heritage/.test(name)) return "09:00-18:00";
  return place.openingHours || "09:00-18:00";
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

export function fitsOpeningHours(clock:number,duration:number,openingHours?:string) {
  const ranges=parseOpeningRanges(openingHours);
  return !ranges.length || ranges.some(range=>clock>=range.start&&clock+duration<=range.end);
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

function importanceScore(place: PlannerPlace) {
  const value=(place.name+" "+(place.category||"")).toLowerCase();
  if(/ramoji|wonderla|golconda|charminar|hussain sagar|hussein sagar|birla mandir|salar jung|qutb shahi|meenakshi|taj mahal|red fort|gateway of india|agra fort/.test(value)) return 100;
  if(/zoo|national park|wildlife|fort|palace|monument|major temple|heritage|lake|museum|beach/.test(value)) return 70;
  if(/viewpoint|garden|waterfall|market|shopping|cafe|mall/.test(value)) return 40;
  return 20;
}

export function buildSmartItinerary(inputPlaces: PlannerPlace[], dayCount: number): PlannedDay[] {
  const places=inputPlaces.filter((place,index,all)=>
    Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)&&place.name.trim()&&
    all.findIndex(candidate=>candidate.id===place.id)===index
  );
  const days=Math.max(1,Math.min(30,Math.floor(dayCount)||1));
  const clusters:PlannerPlace[][]=Array.from({length:days},()=>[]);
  const notable=places.filter(place=>importanceScore(place)>=40);
  const remaining=[...(notable.length?notable:places)];
  const fullDayPlaces=remaining.filter(isFullDay).sort((a,b)=>importanceScore(b)-importanceScore(a));
  for(const place of fullDayPlaces.slice(0,days)){
    const dayIndex=clusters.findIndex(day=>day.length===0);
    if(dayIndex>=0)clusters[dayIndex].push(place);
    remaining.splice(remaining.findIndex(item=>item.id===place.id),1);
  }

  for(let dayIndex=0;dayIndex<days;dayIndex++){
    if(clusters[dayIndex].length||!remaining.length)continue;
    const ranked=[...remaining].sort((a,b)=>{
      const score=(place:PlannerPlace)=>{
        const neighbours=remaining.filter(other=>other.id!==place.id)
          .map(other=>haversineKm(place,other)).sort((x,y)=>x-y).slice(0,3);
        const proximity=neighbours.length?neighbours.reduce((sum,x)=>sum+x,0)/neighbours.length:0;
        return importanceScore(place)*10-proximity;
      };
      return score(b)-score(a);
    });
    const first=ranked[0];
    clusters[dayIndex].push(first);
    remaining.splice(remaining.findIndex(item=>item.id===first.id),1);
    let clock=fitStart(DAY_START,categoryDuration(first),defaultOpeningHours(first));
    let used=Math.max(0,clock-DAY_START)+categoryDuration(first)+30;
    let current=first;

    while(remaining.length){
      const feasible=remaining.map(place=>{
        const distance=haversineKm(current,place);
        const transfer=roadEstimateMinutes(distance);
        const duration=categoryDuration(place);
        const arrival=clock+transfer+(clusters[dayIndex].length===1?30:0);
        const startAt=fitStart(arrival,duration,defaultOpeningHours(place));
        const waiting=Math.max(0,startAt-arrival);
        return {place,distance,transfer,duration,arrival,startAt,waiting};
      }).filter(candidate=>
        candidate.startAt>=candidate.arrival && candidate.startAt+candidate.duration<=DAY_END &&
        fitsOpeningHours(candidate.startAt,candidate.duration,defaultOpeningHours(candidate.place)) &&
        used+candidate.transfer+candidate.waiting+candidate.duration<=MAX_DAY_WORK
      );
      if(!feasible.length)break;
      feasible.sort((a,b)=>
        (a.distance*1.2-importanceScore(a.place)*0.015)-
        (b.distance*1.2-importanceScore(b.place)*0.015)
      );
      const next=feasible[0];
      clusters[dayIndex].push(next.place);
      used+=next.transfer+next.waiting+next.duration;
      clock=next.startAt+next.duration;
      current=next.place;
      remaining.splice(remaining.findIndex(item=>item.id===next.place.id),1);

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
      if(placeIndex===1)clock+=30;
      const durationMinutes=categoryDuration(place);
      const hours=defaultOpeningHours(place);
      clock=fitStart(clock,durationMinutes,hours);
      const openingHoursConflict=!fitsOpeningHours(clock,durationMinutes,hours)||clock+durationMinutes>DAY_END;
      items.push({...place,startTime:timeLabel(clock),durationMinutes,travelTimeMinutes:travelTime,openingHoursConflict});
      clock+=durationMinutes;
    });
    const maxKm=ordered.length?Math.max(...ordered.map(place=>haversineKm(place,ordered[0]))):0;
    const spread=maxKm>35?"wide":maxKm>15?"regional":"nearby";
    const fullDay=ordered.some(isFullDay);
    const title=fullDay?"Full-day attraction":index===0?"Start with nearby highlights":index===days-1?"Final discoveries nearby":"Explore one area at a time";
    const reason=fullDay
      ?"This attraction takes most of the day, so no other sightseeing stops are added."
      :ordered.length<=1?"A lighter day leaves enough time for travel and exploring."
      :spread==="nearby"?"Nearby stops are grouped together; opening hours, travel and breaks are included."
      :"Stops are grouped by proximity; travel, opening hours and breaks are included.";
    return {dayNumber:index+1,title,reason,items,straightLineKm:Math.round(totalDistance*10)/10};
  });
}

export function rescheduleDay(items: PlannedPlace[], travelTimes: number[]) {
  let clock = DAY_START;
  return items.map((place, index) => {
    const travelTimeMinutes = index === 0 ? 0 : Math.max(0, Math.round(travelTimes[index - 1] ?? place.travelTimeMinutes ?? 0));
    clock += travelTimeMinutes;
    clock = fitStart(clock, place.durationMinutes, defaultOpeningHours(place));
    const openingHoursConflict = !fitsOpeningHours(clock, place.durationMinutes, defaultOpeningHours(place)) || clock + place.durationMinutes > DAY_END;
    const next = { ...place, startTime: timeLabel(clock), travelTimeMinutes, openingHoursConflict };
    clock += place.durationMinutes;
    if (index === 0 && items.length > 1) clock += 30;
    return next;
  });
}
