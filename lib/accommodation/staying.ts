export type StaySearchInput={location:string;checkIn:string;checkOut:string;adults:number;stayPreference:string;};
export type StaySearchResult={name:string;platform:string;nightlyPrice:number;totalPrice:number;currency:string;url?:string;rating?:number;ratingScale?:number;stayType?:string;};
const BASE="https://api.stayingapi.com/v1/search";

function normalizedStayType(value:string){
 const s=value.toLowerCase();
 if(s.includes("relative")||s.includes("free"))return "free";
 if(s.includes("lodge"))return "lodge";
 if(s.includes("hostel")||s.includes("dorm"))return "hostel";
 if(s.includes("homestay"))return "homestay";
 if(s.includes("resort"))return "resort";
 if(s.includes("guest"))return "guesthouse";
 if(s.includes("budget")||s.includes("hotel"))return "hotel";
 return "";
}

function matchesStayType(raw:string,preferred:string){
 const value=raw.toLowerCase();
 if(preferred==="lodge")return /lodge|inn/.test(value)&&!/guest.?house/.test(value);
 if(preferred==="hostel")return /hostel|dorm/.test(value);
 if(preferred==="homestay")return /homestay|home stay/.test(value);
 if(preferred==="resort")return /resort/.test(value);
 if(preferred==="guesthouse")return /guest.?house|guest.?home|inn/.test(value);
 if(preferred==="hotel")return /hotel|budget stay/.test(value)&&!/resort|hostel|homestay/.test(value);
 return false;
}

export async function searchStays(input:StaySearchInput):Promise<StaySearchResult[]>{
 const key=process.env.STAYINGAPI_KEY;
 const preferred=normalizedStayType(input.stayPreference);
 // Never substitute a random hotel list when the trip has no explicit stay preference.
 if(!key||!preferred||preferred==="free")return [];
 const params=new URLSearchParams({location:input.location,checkIn:input.checkIn,checkOut:input.checkOut,adults:String(input.adults),platforms:"google",limit:"20"});
 const response=await fetch(BASE+"?"+params.toString(),{headers:{Authorization:"Bearer "+key},cache:"no-store"});
 if(!response.ok)throw new Error("Accommodation price provider returned "+response.status+".");
 const payload=await response.json();
 const rows=Array.isArray(payload.data)?payload.data:[];
 return rows.map((x:any)=>({
   name:String(x.name||"Accommodation"),
   platform:String(x.platform||"google"),
   nightlyPrice:Number(x.price?.nightlyPrice||0),
   totalPrice:Number(x.price?.totalPrice||0),
   currency:String(x.price?.currency||"INR"),
   url:x.url,
   rating:x.guestRating==null?undefined:Number(x.guestRating),
   ratingScale:x.ratingScale==null?undefined:Number(x.ratingScale),
   stayType:String(x.propertyType||x.accommodationType||x.type||x.category||"")
 })).filter((x:StaySearchResult)=>x.totalPrice>0&&x.currency==="INR"&&matchesStayType(x.stayType+" "+x.name,preferred));
}
