export type BudgetCalculationInput = { days:number; people:number; budget:number; destination?:string; travelMethod:string; localTravelMethod:string; stayPreference:string; };
export type BudgetComponent = "destinationTravel"|"accommodation"|"localTransport"|"food"|"activities"|"other"|"contingency";
export type BudgetCalculation = { items:{destinationTravel:number;accommodation:number;localTransport:number;food:number;activities:number;other:number;contingency:number}; subtotal:number; total:number; budget:number; remaining:number; currency:"INR"; confidence:"fallback"; source:"roveo"; };
export type BudgetComponentResult = { component:BudgetComponent; amount:number; currency:"INR"; confidence:"fallback"; source:"roveo"; };
function round(v:number){return Math.round(v*100)/100;}

/** Average one-way group travel estimate, not a premium fare quote. */
export function calculateDestinationTravel(method:string,people:number){
  const m=method.toLowerCase();
  const perPerson=m.includes("flight")?5500:m.includes("train")?1400:m.includes("bus")?1000:1800;
  return round(perPerson*people);
}

/** Uses only the selected stay type. Unspecified stays use a moderate, mid-range average. */
export function calculateAccommodation(stay:string,days:number,people:number){
  const nights=Math.max(0,days-1);
  const s=stay.toLowerCase();
  if(!nights)return 0;
  if(s.includes("relative")||s.includes("free")||s.includes("no stay"))return 0;
  if(s.includes("hostel")||s.includes("dorm"))return round(350*people*nights);
  const nightlyRoom=s.includes("resort")?2200:s.includes("homestay")?900:s.includes("guest")?850:s.includes("lodge")?700:s.includes("budget")?850:s.includes("hotel")?1200:1000;
  return round(nightlyRoom*Math.max(1,Math.ceil(people/2))*nights);
}

export function calculateLocalTransport(method:string,days:number){
  const m=method.toLowerCase();
  const daily=m.includes("public")?250:m.includes("walking")?100:m.includes("bike")?400:m.includes("taxi")?800:650;
  return round(daily*days);
}

/** Average meal allowance per traveller/day; avoids premium-city price assumptions. */
export function calculateFood(days:number,people:number,destination=""){
  const perPersonPerDay=200; // affordable local eateries and simple meals, per person/day
  return round(perPersonPerDay*days*people);
}

export function calculateActivities(days:number,people:number){
  return round(300*Math.max(1,Math.min(days,5))*people);
}
export function calculateOther(budget:number){return round(Math.min(1000,Math.max(0,budget)*0.1));}
export function calculateContingency(subtotal:number){return round(subtotal*0.05);}

/**
 * Estimates average costs, then fits flexible local transport and activities to
 * the user's actual budget. It never scales accommodation or food using prices
 * from unrelated stay types. A ₹1,000 "Other" reserve is protected whenever
 * the total budget is at least ₹10,000.
 */
export function calculateBudgetComponents(input:BudgetCalculationInput):BudgetComponentResult[]{
  const destinationTravel=calculateDestinationTravel(input.travelMethod,input.people);
  const accommodation=calculateAccommodation(input.stayPreference,input.days,input.people);
  let localTransport=calculateLocalTransport(input.localTravelMethod,input.days);
  const food=calculateFood(input.days,input.people,input.destination);
  let activities=calculateActivities(input.days,input.people);
  const other=calculateOther(input.budget);

  const fixed=destinationTravel+accommodation+food+other;
  const flexibleBudget=Math.max(0,input.budget/1.05-fixed);
  const flexibleTotal=localTransport+activities;
  if(flexibleTotal>flexibleBudget&&flexibleTotal>0){
    const factor=flexibleBudget/flexibleTotal;
    localTransport=round(localTransport*factor);
    activities=round(activities*factor);
  }
  const subtotal=round(destinationTravel+accommodation+localTransport+food+activities+other);
  const contingency=calculateContingency(subtotal);
  return [["destinationTravel",destinationTravel],["accommodation",accommodation],["localTransport",localTransport],["food",food],["activities",activities],["other",other],["contingency",contingency]]
    .map(([component,amount])=>({component:component as BudgetComponent,amount:Number(amount),currency:"INR",confidence:"fallback",source:"roveo"}));
}
export function calculateBudget(input:BudgetCalculationInput):BudgetCalculation{
  const components=calculateBudgetComponents(input);
  const items={
    destinationTravel:components.find(x=>x.component==="destinationTravel")!.amount,
    accommodation:components.find(x=>x.component==="accommodation")!.amount,
    localTransport:components.find(x=>x.component==="localTransport")!.amount,
    food:components.find(x=>x.component==="food")!.amount,
    activities:components.find(x=>x.component==="activities")!.amount,
    other:components.find(x=>x.component==="other")!.amount,
    contingency:components.find(x=>x.component==="contingency")!.amount
  };
  const subtotal=round(items.destinationTravel+items.accommodation+items.localTransport+items.food+items.activities+items.other);
  const total=round(subtotal+items.contingency);
  return {items,subtotal,total,budget:round(input.budget),remaining:round(input.budget-total),currency:"INR",confidence:"fallback",source:"roveo"};
}
