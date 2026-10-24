import {NextResponse} from "next/server";
import {searchStays} from "@/lib/accommodation/staying";

function text(v:unknown){return typeof v==="string"?v.trim():"";}
function positive(v:unknown){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function validDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+"T00:00:00.000Z");return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}

export async function POST(request:Request){
 try{
  let body:any;try{body=await request.json();}catch{return NextResponse.json({error:"Invalid JSON request body."},{status:400});}
  const location=text(body.location),checkIn=text(body.checkIn),checkOut=text(body.checkOut),adults=positive(body.adults);
  const stayPreference=text(body.stayPreference)||"Hotel";
  if(!location||!validDate(checkIn)||!validDate(checkOut)||checkOut<=checkIn||!adults)return NextResponse.json({error:"A location, real check-in/check-out dates (check-out after check-in), and a positive adult count are required."},{status:400});
  if(!process.env.STAYINGAPI_KEY){
   return NextResponse.json({stays:[],source:"roveo-estimate",providerStatus:"not_configured",live:false,availabilityConfirmed:false,message:"Live accommodation search is not configured. Roveo will use a clearly labelled estimated cost instead."});
  }
  const stays=await searchStays({location,checkIn,checkOut,adults,stayPreference});
  return NextResponse.json({
   stays,
   source:"stayingapi",
   providerStatus:stays.length?"priced_results":"no_results",
   live:true,
   availabilityConfirmed:false,
   message:stays.length
    ?"Provider-listed prices were returned. Availability has not been confirmed; check the property provider before booking."
    :"The provider returned no priced properties for these dates. Use Roveo's estimated accommodation cost instead."
  });
 }catch(error){
  console.error("POST /api/accommodations/search failed:",error);
  return NextResponse.json({error:"Accommodation provider search failed.",providerStatus:"error",live:false,availabilityConfirmed:false,message:"The provider could not be reached. Roveo's estimated accommodation cost remains available."},{status:502});
 }
}
