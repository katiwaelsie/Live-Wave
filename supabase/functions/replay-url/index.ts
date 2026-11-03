import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
const json=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:{"Access-Control-Allow-Origin":"*"}});
 if(req.method!=="POST")return json(405,{error:"POST only"});
 try{
  const auth=req.headers.get("Authorization");if(!auth)return json(401,{error:"Sign in to watch this replay."});
  const userClient=createClient(env("SUPABASE_URL"),env("SUPABASE_ANON_KEY"),{global:{headers:{Authorization:auth}}});
  const {data:{user}}=await userClient.auth.getUser();if(!user)return json(401,{error:"Invalid session"});
  const {eventId}=await req.json();if(!eventId)return json(400,{error:"eventId required"});
  const db=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"));
  const {data:profile}=await db.from("profiles").select("account_status").eq("id",user.id).maybeSingle();
  if(profile?.account_status==="suspended")return json(403,{error:"This account is suspended."});
  const {data:event,error}=await db.from("events").select("id,creator_id,price_kes,access_mode,access_code_required,replay_url,replay_visibility").eq("id",eventId).maybeSingle();
  if(error||!event||!event.replay_url)return json(404,{error:"Replay not found"});
  const owner=event.creator_id===user.id;
  if(!owner){
   if(event.replay_visibility==="creator_only")return json(403,{error:"This replay is private."});
   const {data:grant}=await db.from("event_access_grants").select("id,expires_at").eq("event_id",eventId).eq("user_id",user.id).maybeSingle();
   const grantValid=!!grant&&(!grant.expires_at||new Date(grant.expires_at).getTime()>Date.now());
   const requiresCode=event.access_mode==="code"||event.access_code_required===true;
   if(requiresCode&&!grantValid)return json(403,{error:"Redeem a valid access code first."});
   if(Number(event.price_kes)>0){
    const {data:ticket}=await db.from("tickets").select("id").eq("event_id",eventId).eq("user_id",user.id).eq("paid",true).maybeSingle();
    if(!ticket)return json(403,{error:"A verified ticket is required."});
   } else if(event.replay_visibility==="ticket_holders"&&!grantValid)return json(403,{error:"This replay is limited to ticket holders."});
  }
  const url=String(event.replay_url);
  const marker="/storage/v1/object/public/replays/";
  const marker2="/storage/v1/object/sign/replays/";
  let path="";
  if(url.includes(marker))path=decodeURIComponent(url.split(marker)[1].split("?")[0]);
  else if(url.includes(marker2))path=decodeURIComponent(url.split(marker2)[1].split("?")[0]);
  else return json(400,{error:"Replay storage path is invalid. Re-upload this replay from Creator Studio."});
  const {data:signed,error:signedError}=await db.storage.from("replays").createSignedUrl(path,600);
  if(signedError||!signed?.signedUrl)throw signedError||new Error("Could not sign replay URL");
  return json(200,{ok:true,signedUrl:signed.signedUrl,expiresIn:600});
 }catch(e){console.error(e);return json(400,{error:e instanceof Error?e.message:"Could not authorize replay"});}
});
