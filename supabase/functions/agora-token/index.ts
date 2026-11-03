import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RtcTokenBuilder, RtcRole } from "https://esm.sh/agora-token@2.0.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AGORA_APP_ID = Deno.env.get("AGORA_APP_ID")!;
const AGORA_APP_CERTIFICATE = Deno.env.get("AGORA_APP_CERTIFICATE")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) return json({ error: "Agora token service is not configured." }, 500);

  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "Sign in is required." }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json({ error: "Invalid or expired session." }, 401);
    const { eventId, channelName, role } = await req.json();
    if (!eventId || !channelName || !["publisher", "audience"].includes(role)) return json({ error: "eventId, channelName, and a valid role are required." }, 400);
    if (channelName !== `event-${eventId}`) return json({ error: "Channel does not match this event." }, 400);

    const { data: event, error: eventError } = await adminClient.from("events")
      .select("id, creator_id, price_kes, is_live, access_mode, access_code_required, moderation_status")
      .eq("id", eventId).maybeSingle();
    if (eventError || !event) return json({ error: "Event not found." }, 404);
    const userId = authData.user.id;
    const { data: profile } = await adminClient.from("profiles").select("account_status").eq("id", userId).maybeSingle();
    if (profile?.account_status === "suspended") return json({ error: "This account is suspended." }, 403);
    if (["hidden", "removed"].includes(event.moderation_status || "") && event.creator_id !== userId) {
      return json({ error: "This event is unavailable." }, 403);
    }

    if (role === "publisher") {
      if (event.creator_id !== userId) return json({ error: "Only this event's creator can publish." }, 403);
    } else {
      if (event.creator_id === userId) {
        // Creator may preview their own event as an audience member.
      } else {
        const { data: grant } = await adminClient.from("event_access_grants")
          .select("id, expires_at").eq("event_id", eventId).eq("user_id", userId).maybeSingle();
        const grantValid = !!grant && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now());
        let paidTicket = false;
        if (Number(event.price_kes) > 0) {
          const { data: ticket } = await adminClient.from("tickets").select("id")
            .eq("event_id", eventId).eq("user_id", userId).eq("paid", true).maybeSingle();
          paidTicket = !!ticket;
        }
        const requiresCode = event.access_mode === "code" || event.access_code_required === true;
        if (requiresCode && !grantValid) return json({ error: "A valid event access code is required." }, 403);
        if (Number(event.price_kes) > 0 && !paidTicket) return json({ error: "A verified ticket is required for this paid event." }, 403);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = now + 60 * 60;
    const agoraRole = role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const token = RtcTokenBuilder.buildTokenWithUid(AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, 0, agoraRole, privilegeExpiredTs);
    return json({ token, expiresAt: privilegeExpiredTs });
  } catch (error) {
    console.error("agora-token error", error);
    return json({ error: "Could not issue a stream token." }, 500);
  }
});
