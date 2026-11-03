import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toUpperCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `LC-${[...bytes].map(b => alphabet[b % alphabet.length]).join("")}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "Sign in is required." }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "Invalid or expired session." }, 401);
  const user = authData.user;
  const { data: profile } = await adminClient.from("profiles").select("account_status").eq("id", user.id).maybeSingle();
  if (profile?.account_status === "suspended") return json({ error: "This account is suspended." }, 403);

  try {
    const body = await req.json();
    const action = String(body.action || "");
    const eventId = String(body.eventId || "");
    if (!eventId) return json({ error: "eventId is required." }, 400);

    const { data: event, error: eventError } = await adminClient.from("events")
      .select("id, creator_id, title, access_mode, access_code_required")
      .eq("id", eventId).maybeSingle();
    if (eventError || !event) return json({ error: "Event not found." }, 404);

    if (action === "issue") {
      if (event.creator_id !== user.id) return json({ error: "Only the event creator can issue access codes." }, 403);
      const maxUses = body.maxUses == null || body.maxUses === "" ? null : Number(body.maxUses);
      const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
      if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000)) return json({ error: "maxUses must be a positive whole number." }, 400);
      if (body.expiresAt && (!Number.isFinite(new Date(body.expiresAt).getTime()) || new Date(body.expiresAt).getTime() <= Date.now())) return json({ error: "Expiry must be in the future." }, 400);
      const code = makeCode();
      const { error } = await adminClient.from("event_access_codes").insert({
        event_id: eventId, created_by: user.id, code_hash: await sha256(code),
        label: String(body.label || "").slice(0, 100) || null, max_uses: maxUses, expires_at: expiresAt,
      });
      if (error) throw error;
      await adminClient.from("events").update({ access_mode: "code", access_code_required: true }).eq("id", eventId);
      return json({ ok: true, code, message: "Copy this code now. The full code is not stored or shown again." });
    }

    if (action === "redeem") {
      const code = String(body.code || "").trim().toUpperCase();
      if (!/^LC-[A-HJ-NP-Z2-9]{8}$/.test(code)) return json({ ok: false, error: "Enter a valid access code." }, 400);
      const { data, error } = await adminClient.rpc("redeem_event_access_code", {
        p_event_id: eventId, p_user_id: user.id, p_code_hash: await sha256(code),
      });
      if (error) throw error;
      if (!data?.ok) {
        const messages: Record<string, string> = { invalid: "That code is not valid for this event.", revoked: "This access code has been revoked.", expired: "This access code has expired.", limit: "This access code has reached its use limit." };
        return json({ ok: false, error: messages[data?.reason] || "Access code could not be redeemed." }, 403);
      }
      return json({ ok: true, message: "Access granted for this event." });
    }

    if (action === "revoke") {
      if (event.creator_id !== user.id) return json({ error: "Only the event creator can revoke access codes." }, 403);
      const codeId = String(body.codeId || "");
      if (!codeId) return json({ error: "codeId is required." }, 400);
      const { error } = await adminClient.from("event_access_codes").update({ revoked_at: new Date().toISOString() }).eq("id", codeId).eq("event_id", eventId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "list") {
      if (event.creator_id !== user.id) return json({ error: "Only the event creator can view access codes." }, 403);
      const { data, error } = await adminClient.from("event_access_codes")
        .select("id, label, max_uses, uses_count, expires_at, revoked_at, created_at")
        .eq("event_id", eventId).order("created_at", { ascending: false });
      if (error) throw error;
      return json({ ok: true, codes: data || [] });
    }

    return json({ error: "Unknown action. Use issue, redeem, revoke, or list." }, 400);
  } catch (error) {
    console.error("access-code error", error);
    return json({ error: "The access-code request could not be completed." }, 500);
  }
});
