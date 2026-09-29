import {NextResponse} from "next/server";
import {searchStays} from "@/lib/accommodation/staying";
export const runtime="nodejs";
function text(v:unknown){return typeof v==="string"?v.trim():"";}
function positive(v:unknown){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
export async function POST(request:Request){
 try{
  const b=await request.json();
  const location=text(b.location),checkIn=text(b.checkIn),checkOut=text(b.checkOut),adults=positive(b.adults);
  if(!location||!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)||!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)||!adults)return NextResponse.json({error:"location, valid check-in/check-out dates and adults are required."},{status:400});
  const stays=await searchStays({location,checkIn,checkOut,adults,stayPreference:text(b.stayPreference)});
  return NextResponse.json({stays,source:"stayingapi",live:Boolean(process.env.STAYINGAPI_KEY)});
 }catch(error){console.error("POST /api/accommodations/search failed:",error);return NextResponse.json({error:error instanceof Error?error.message:"Accommodation search failed."},{status:502});}
}
