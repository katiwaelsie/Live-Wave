import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const base=()=>env("MPESA_ENV")==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke";
function timestamp(){const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;}
async function getToken(){const basic=btoa(`${env("MPESA_CONSUMER_KEY")}:${env("MPESA_CONSUMER_SECRET")}`);const r=await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${basic}`}});const j=await r.json();if(!r.ok||!j.access_token)throw new Error("Daraja authentication failed");return j.access_token as string;}
async function verifyWithDaraja(checkoutId:string){
 const shortcode=env("MPESA_SHORTCODE"), passkey=env("MPESA_PASSKEY"), ts=timestamp();
 const token=await getToken();
 const r=await fetch(`${base()}/mpesa/stkpushquery/v1/query`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({BusinessShortCode:shortcode,Password:btoa(`${shortcode}${passkey}${ts}`),Timestamp:ts,CheckoutRequestID:checkoutId})});
 const j=await r.json();
 return {ok:r.ok && String(j.ResultCode)==="0",data:j};
}
serve(async(req)=>{
 if(req.method!=="POST")return json(405,{ResultCode:1,ResultDesc:"POST only"});
 try{
  const body=await req.json();
  const callback=body?.Body?.stkCallback;
  if(!callback?.CheckoutRequestID)return json(200,{ResultCode:0,ResultDesc:"Callback received"});
  const admin=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"));
  const {data:tx}=await admin.from("payment_transactions").select("*").eq("checkout_request_id",callback.CheckoutRequestID).maybeSingle();
  if(!tx)return json(200,{ResultCode:0,ResultDesc:"Unknown payment ignored"});
  if(tx.status==="succeeded")return json(200,{ResultCode:0,ResultDesc:"Already processed"});
  const callbackSuccess=Number(callback.ResultCode)===0;
  if(!callbackSuccess){
    await admin.from("payment_transactions").update({status:"failed",raw_callback:body,updated_at:new Date().toISOString()}).eq("id",tx.id);
    return json(200,{ResultCode:0,ResultDesc:"Failure recorded"});
  }
  // A callback alone is not treated as proof: query Daraja using the checkout ID.
  const verified=await verifyWithDaraja(callback.CheckoutRequestID);
  if(!verified.ok){
    await admin.from("payment_transactions").update({raw_callback:{callback:body,query:verified.data},updated_at:new Date().toISOString()}).eq("id",tx.id);
    return json(200,{ResultCode:0,ResultDesc:"Awaiting provider verification"});
  }
  const items=callback.CallbackMetadata?.Item??[];
  const meta=(name:string)=>items.find((i:any)=>i.Name===name)?.Value;
  const amount=Number(meta("Amount")??tx.amount_kes);
  const receipt=String(meta("MpesaReceiptNumber")??"");
  if(amount!==Number(tx.amount_kes)||!receipt){
    await admin.from("payment_transactions").update({status:"failed",raw_callback:{callback:body,query:verified.data,validation:"amount_or_receipt_mismatch"},updated_at:new Date().toISOString()}).eq("id",tx.id);
    return json(200,{ResultCode:0,ResultDesc:"Payment details mismatch"});
  }
  // Provider query and callback metadata have been verified. Issue idempotently before marking succeeded,
  // so a transient ticket insert failure cannot leave a succeeded transaction without a ticket.
  const {error:ticketError}=await admin.from("tickets").upsert({event_id:tx.event_id,user_id:tx.user_id,paid:true,status:"active",payment_transaction_id:tx.id,issued_at:new Date().toISOString()},{onConflict:"payment_transaction_id",ignoreDuplicates:true});
  if(ticketError)throw ticketError;
  const {error:updateError}=await admin.from("payment_transactions").update({status:"succeeded",provider_receipt:receipt,raw_callback:body,verified_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",tx.id).neq("status","succeeded");
  if(updateError)throw updateError;
  await admin.from("user_notifications").insert({user_id:tx.user_id,event_id:tx.event_id,notification_type:"ticket_purchased",title:"Your ticket is ready",body:"Your M-Pesa payment was confirmed. Open My Tickets to watch the event.",action_url:`watch.html?id=${tx.event_id}`});
  return json(200,{ResultCode:0,ResultDesc:"Payment verified and ticket issued"});
 }catch(e){console.error("M-Pesa callback processing error",e);return json(200,{ResultCode:0,ResultDesc:"Callback accepted for retry/reconciliation"});}
});
