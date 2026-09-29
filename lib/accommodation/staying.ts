export type StaySearchInput={location:string;checkIn:string;checkOut:string;adults:number;stayPreference:string;};
export type StaySearchResult={name:string;platform:string;nightlyPrice:number;totalPrice:number;currency:string;url?:string;rating?:number;ratingScale?:number;};
const BASE="https://api.stayingapi.com/v1/search";
export async function searchStays(input:StaySearchInput):Promise<StaySearchResult[]>{
 const key=process.env.STAYINGAPI_KEY;
 if(!key) return [];
 const params=new URLSearchParams({location:input.location,checkIn:input.checkIn,checkOut:input.checkOut,adults:String(input.adults),platforms:"google",limit:"5"});
 const response=await fetch(BASE+"?"+params.toString(),{headers:{Authorization:"Bearer "+key},cache:"no-store"});
 if(!response.ok) throw new Error("Accommodation price provider returned "+response.status+".");
 const payload=await response.json();
 return (payload.data||[]).map((x:any)=>({name:String(x.name||"Accommodation"),platform:String(x.platform||"google"),nightlyPrice:Number(x.price?.nightlyPrice||0),totalPrice:Number(x.price?.totalPrice||0),currency:String(x.price?.currency||"INR"),url:x.url,rating:x.guestRating==null?undefined:Number(x.guestRating),ratingScale:x.ratingScale==null?undefined:Number(x.ratingScale)})).filter((x:StaySearchResult)=>x.totalPrice>0);
}
