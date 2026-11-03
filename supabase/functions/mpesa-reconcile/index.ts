import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
const base=()=>env("MPESA_ENV")==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke";
function timestamp(){const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;}
async function token(){const r=await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${btoa(`${env("MPESA_CONSUMER_KEY")}:${env("MPESA_CONSUMER_SECRET")}`)}`}});const j=await r.json();if(!r.ok||!j.access_token)throw new Error("Daraja authentication failed");return j.access_token;}
async function query(checkout:string){const sc=env("MPESA_SHORTCODE"),ts=timestamp(),t=await token();const r=await fetch(`${base()}/mpesa/stkpushquery/v1/query`,{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({BusinessShortCode:sc,Password:btoa(`${sc}${env("MPESA_PASSKEY")}${ts}`),Timestamp:ts,CheckoutRequestID:checkout})});return await r.json();}
serve(async(req)=>{
 if(req.headers.get("x-cron-secret")!==env("CRON_SECRET"))return new Response("Unauthorized",{status:401});
 try{
  const db=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"));
  const cutoff=new Date(Date.now()-30*1000).toISOString();
  const {data:pending,error}=await db.from("payment_transactions").select("*").eq("status","pending").not("checkout_request_id","is",null).not("raw_callback","is",null).lt("created_at",cutoff).limit(100);
  if(error)throw error;let completed=0;
  for(const tx of pending||[]){
   try{
    const result=await query(tx.checkout_request_id);
    if(String(result.ResultCode)!=="0")continue;
    const callback=tx.raw_callback;
    const items=callback?.Body?.stkCallback?.CallbackMetadata?.Item||[];
    const meta=(name:string)=>items.find((i:any)=>i.Name===name)?.Value;
    const amount=Number(meta("Amount")),receipt=String(meta("MpesaReceiptNumber")||"");
    if(amount!==Number(tx.amount_kes)||!receipt)continue;
    const {error:terr}=await db.from("tickets").upsert({event_id:tx.event_id,user_id:tx.user_id,paid:true,status:"active",payment_transaction_id:tx.id,issued_at:new Date().toISOString()},{onConflict:"payment_transaction_id",ignoreDuplicates:true});
    if(terr)throw terr;
    const {error:uerr}=await db.from("payment_transactions").update({status:"succeeded",provider_receipt:receipt,verified_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",tx.id).eq("status","pending");
    if(uerr)throw uerr;
    await db.from("user_notifications").insert({user_id:tx.user_id,event_id:tx.event_id,notification_type:"ticket_purchased",title:"Your ticket is ready",body:"Your M-Pesa payment was confirmed. Open My Tickets to watch the event.",action_url:`watch.html?id=${tx.event_id}`});
    completed++;
   }catch(e){console.error("Could not reconcile payment",tx.id,e);}
  }
  return new Response(JSON.stringify({ok:true,checked:pending?.length||0,completed}),{headers:{"Content-Type":"application/json"}});
 }catch(e){return new Response(JSON.stringify({error:e instanceof Error?e.message:"Reconciliation failed"}),{status:500,headers:{"Content-Type":"application/json"}});}
});
