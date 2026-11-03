import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:cors});
const env=(k:string)=>Deno.env.get(k)??"";
serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply(405,{error:"POST only"});
 try{
  const auth=req.headers.get("Authorization");if(!auth)return reply(401,{error:"Authentication required"});
  const url=env("SUPABASE_URL"),anon=env("SUPABASE_ANON_KEY"),service=env("SUPABASE_SERVICE_ROLE_KEY");
  const caller=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const {data:{user}}=await caller.auth.getUser();if(!user)return reply(401,{error:"Invalid session"});
  const db=createClient(url,service);
  const {data:role}=await db.from("user_roles").select("role").eq("user_id",user.id).eq("role","admin").maybeSingle();
  if(!role)return reply(403,{error:"Administrator permission required"});
  const {action,targetId,value,details={}}=await req.json();
  let result:any=null;
  if(action==="set_event_moderation"){
   if(!["active","reviewed","hidden","removed"].includes(value))return reply(400,{error:"Invalid moderation status"});
   const {data,error}=await db.from("events").update({moderation_status:value}).eq("id",targetId).select("id,moderation_status").single();if(error)throw error;result=data;
  }else if(action==="set_account_status"){
   if(!["active","suspended"].includes(value))return reply(400,{error:"Invalid account status"});
   const {data,error}=await db.from("profiles").update({account_status:value}).eq("id",targetId).select("id,account_status").single();if(error)throw error;result=data;
  }else if(action==="review_report"){
   if(!["reviewing","resolved","dismissed"].includes(value))return reply(400,{error:"Invalid report status"});
   const {data,error}=await db.from("event_reports").update({status:value,reviewed_by:user.id,reviewed_at:new Date().toISOString()}).eq("id",targetId).select("id,status").single();if(error)throw error;result=data;
  }else if(action==="set_creator_status"){
   if(!["active","approved","suspended","rejected"].includes(value))return reply(400,{error:"Invalid creator status"});
   const {data,error}=await db.from("profiles").update({creator_status:value}).eq("id",targetId).select("id,creator_status").single();if(error)throw error;result=data;
  }else if(action==="create_category"){
   const name=String(details.name||"").trim();if(!name)return reply(400,{error:"Category name required"});
   const {data,error}=await db.from("event_categories").insert({name,created_by:user.id}).select().single();if(error)throw error;result=data;
  }else if(action==="rename_category"){
   const name=String(details.name||"").trim();if(!targetId||!name)return reply(400,{error:"Category ID and name required"});
   const {data,error}=await db.from("event_categories").update({name}).eq("id",targetId).select().single();if(error)throw error;result=data;
  }else if(action==="create_notification"){
   const {userId,eventId,title,body,actionUrl,allUsers}=details;
   if(!title)return reply(400,{error:"Notification title is required"});
   const payload={event_id:eventId||null,notification_type:"admin",title,body:body||"",action_url:actionUrl||null};
   if(allUsers){
    const {data:profiles,error:profileError}=await db.from("profiles").select("id").limit(10000);if(profileError)throw profileError;
    const rows=(profiles||[]).map(p=>({...payload,user_id:p.id}));
    for(let i=0;i<rows.length;i+=500){const {error}=await db.from("user_notifications").insert(rows.slice(i,i+500));if(error)throw error;}
    result={sent:rows.length};
   }else{
    if(!userId)return reply(400,{error:"userId is required unless allUsers is true"});
    const {data,error}=await db.from("user_notifications").insert({...payload,user_id:userId}).select().single();if(error)throw error;result=data;
   }
  }else return reply(400,{error:"Unsupported admin action"});
  await db.from("platform_audit_logs").insert({actor_id:user.id,action,target_type:action.includes("event")?"event":action.includes("account")?"profile":"admin",target_id:String(targetId||""),details:{value,details,result}});
  return reply(200,{ok:true,result});
 }catch(e){console.error(e);return reply(400,{error:e instanceof Error?e.message:"Admin action failed"});}
});
