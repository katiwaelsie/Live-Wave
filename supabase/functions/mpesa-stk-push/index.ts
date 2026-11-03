import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cors });
const env = (k: string) => Deno.env.get(k) ?? "";
const darajaBase = () => env("MPESA_ENV") === "production"
  ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

async function getToken() {
  const credentials = btoa(`${env("MPESA_CONSUMER_KEY")}:${env("MPESA_CONSUMER_SECRET")}`);
  const res = await fetch(`${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("Could not authenticate with Daraja");
  return data.access_token as string;
}
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
}
function normalizePhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^07\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  throw new Error("Enter a valid Kenyan M-Pesa number, e.g. 0712345678");
}
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Sign in before purchasing a ticket." });
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json(401, { error: "Invalid session" });

    const { eventId, phone } = await req.json();
    if (!eventId || !phone) return json(400, { error: "eventId and phone are required" });
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: profile } = await admin.from("profiles").select("account_status").eq("id", user.id).maybeSingle();
    if (profile?.account_status === "suspended") return json(403, { error: "This account is suspended." });
    const { data: event, error: eventError } = await admin.from("events")
      .select("id,title,creator_id,price_kes,is_live,access_mode").eq("id", eventId).single();
    if (eventError || !event) return json(404, { error: "Event not found" });
    const amount = Math.ceil(Number(event.price_kes));
    if (!Number.isFinite(amount) || amount < 1) return json(400, { error: "This event does not require a paid ticket" });
    if (event.creator_id === user.id) return json(400, { error: "Creators cannot buy their own event ticket" });

    const { data: existing } = await admin.from("payment_transactions")
      .select("id,status,created_at").eq("event_id", eventId).eq("user_id", user.id)
      .eq("status", "pending").gte("created_at", new Date(Date.now()-10*60*1000).toISOString()).limit(1);
    if (existing?.length) return json(409, { error: "A payment is already pending. Check your phone before trying again." });

    const msisdn = normalizePhone(phone);
    const ts = timestamp();
    const shortcode = env("MPESA_SHORTCODE");
    const passkey = env("MPESA_PASSKEY");
    const callbackUrl = env("MPESA_CALLBACK_URL");
    if (!shortcode || !passkey || !callbackUrl || !env("MPESA_CONSUMER_KEY") || !env("MPESA_CONSUMER_SECRET")) {
      return json(503, { error: "M-Pesa is not configured yet. Set Daraja secrets and callback URL." });
    }

    const { data: tx, error: insertError } = await admin.from("payment_transactions").insert({
      user_id: user.id, event_id: eventId, provider: "mpesa", phone_number: msisdn,
      amount_kes: amount, currency: "KES", status: "pending"
    }).select("id").single();
    if (insertError || !tx) throw new Error("Could not create payment record");

    const token = await getToken();
    const password = btoa(`${shortcode}${passkey}${ts}`);
    const response = await fetch(`${darajaBase()}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode, Password: password, Timestamp: ts, TransactionType: env("MPESA_TRANSACTION_TYPE") || "CustomerPayBillOnline",
        Amount: amount, PartyA: msisdn, PartyB: env("MPESA_PARTY_B") || shortcode, PhoneNumber: msisdn,
        CallBackURL: callbackUrl, AccountReference: `LC-${String(tx.id).slice(0,10)}`,
        TransactionDesc: `LiveConcerts ticket: ${String(event.title).slice(0,40)}`
      })
    });
    const data = await response.json();
    if (!response.ok || data.ResponseCode !== "0" || !data.CheckoutRequestID) {
      await admin.from("payment_transactions").update({ status: "failed", raw_callback: data }).eq("id", tx.id);
      return json(502, { error: data.errorMessage || data.ResponseDescription || "M-Pesa request failed" });
    }
    await admin.from("payment_transactions").update({
      merchant_request_id: data.MerchantRequestID, checkout_request_id: data.CheckoutRequestID
    }).eq("id", tx.id);
    return json(200, { ok: true, paymentId: tx.id, message: "STK push sent. Approve the prompt on your phone; your ticket will be issued after confirmation." });
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Payment request failed" });
  }
});
