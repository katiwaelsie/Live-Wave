import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
const json=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"}});
async function hash(s:string){const bytes=new TextEncoder().encode(s);const digest=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");}
serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:{"Access-Control-Allow-Origin":"*"}});
 if(req.method!=="POST")return json(405,{error:"POST only"});
 try{
  const {action,eventId,sessionKey,isReplay}=await req.json();
  if(!eventId||!sessionKey||!["start","stop"].includes(action))return json(400,{error:"Invalid session request"});
  const url=env("SUPABASE_URL"),key=env("SUPABASE_SERVICE_ROLE_KEY");
  const admin=createClient(url,key);
  let userId:string|null=null;const auth=req.headers.get("Authorization");
  if(auth){const client=createClient(url,env("SUPABASE_ANON_KEY"),{global:{headers:{Authorization:auth}}});const {data:{user}}=await client.auth.getUser();userId=user?.id??null;}
  const keyHash=await hash(String(sessionKey));
  if(action==="start"){
   const {data:ev}=await admin.from("events").select("id,is_live,replay_url").eq("id",eventId).maybeSingle();
   if(!ev)return json(404,{error:"Event not found"});
   const {data,error}=await admin.from("event_view_sessions").insert({event_id:eventId,user_id:userId,session_key_hash:keyHash,is_replay:Boolean(isReplay),started_at:new Date().toISOString()}).select("id").single();
   if(error)throw error;return json(200,{ok:true,sessionId:data.id});
  }
  const {data:row}=await admin.from("event_view_sessions").select("id,started_at").eq("event_id",eventId).eq("session_key_hash",keyHash).is("ended_at",null).order("started_at",{ascending:false}).limit(1).maybeSingle();
  if(!row)return json(200,{ok:true});
  const seconds=Math.max(0,Math.floor((Date.now()-new Date(row.started_at).getTime())/1000));
  const {error}=await admin.from("event_view_sessions").update({ended_at:new Date().toISOString(),duration_seconds:seconds}).eq("id",row.id);
  if(error)throw error;return json(200,{ok:true,durationSeconds:seconds});
 }catch(e){console.error(e);return json(400,{error:e instanceof Error?e.message:"Session tracking failed"});}
});
