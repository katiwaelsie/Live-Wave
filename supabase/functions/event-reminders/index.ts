import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
serve(async(req)=>{
 if(req.headers.get("x-cron-secret")!==env("CRON_SECRET"))return new Response("Unauthorized",{status:401});
 try{
  const db=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"));
  const now=Date.now(), from=new Date(now+14*60*1000).toISOString(), to=new Date(now+16*60*1000).toISOString();
  const {data:events,error}=await db.from("events").select("id,title,creator_id,scheduled_at").eq("is_live",false).gte("scheduled_at",from).lte("scheduled_at",to);
  if(error)throw error;
  let sent=0;
  for(const event of events||[]){
   const ids=new Set([event.creator_id]);
   const {data:follows}=await db.from("creator_follows").select("follower_id").eq("creator_id",event.creator_id);
   (follows||[]).forEach(x=>ids.add(x.follower_id));
   const {data:saved}=await db.from("saved_events").select("user_id").eq("event_id",event.id);
   (saved||[]).forEach(x=>ids.add(x.user_id));
   for(const userId of ids){
    const {data:inserted,error:insertError}=await db.from("event_reminder_sends").insert({event_id:event.id,user_id:userId,reminder_type:"15_minute"}).select("id").maybeSingle();
    if(insertError) { if(insertError.code==="23505")continue; throw insertError; }
    if(!inserted)continue;
    const {error:nErr}=await db.from("user_notifications").insert({user_id:userId,event_id:event.id,notification_type:"event_reminder",title:"Event starting soon",body:`${event.title||"Your saved event"} starts in about 15 minutes.`,action_url:`watch.html?id=${event.id}`});
    if(!nErr)sent++;
  }
  return new Response(JSON.stringify({ok:true,events:events?.length||0,notifications:sent}),{headers:{"Content-Type":"application/json"}});
 }catch(e){console.error(e);return new Response(JSON.stringify({error:e instanceof Error?e.message:"Reminder dispatch failed"}),{status:500,headers:{"Content-Type":"application/json"}});}
});
