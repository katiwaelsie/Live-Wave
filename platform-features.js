/* LiveConcerts shared product features. Requires config.js (supabaseClient) and Supabase migrations/functions. */
(() => {
  const $ = (s, root=document) => root.querySelector(s);
  const esc = (v) => String(v ?? "");
  const params = new URLSearchParams(location.search);
  const eventId = params.get("id");
  let currentUser = null;
  let currentEvent = null;

  async function init() {
    if (!window.supabaseClient) return;
    try {
      const { data } = await supabaseClient.auth.getUser();
      currentUser = data?.user || null;
      if (currentUser) {
        const { data: profile } = await supabaseClient.from("profiles").select("account_status").eq("id", currentUser.id).maybeSingle();
        if (profile?.account_status === "suspended") {
          await supabaseClient.auth.signOut();
          alert("This account is suspended. Please contact LiveConcerts support.");
          location.href = "login.html";
          return;
        }
        buildNotificationCenter();
      }
      if (eventId && document.body) await initEventTools();
    } catch (e) { console.warn("LiveConcerts feature tools:", e); }
  }

  async function loadCreatorEarnings() {
    const view=$("#view-earnings");
    if(!view||$("#lc-earnings-live"))return;
    const panel=document.createElement("section");panel.id="lc-earnings-live";panel.style.cssText="margin:18px 0;padding:18px;border:1px solid #334155;border-radius:14px;background:#0f172a;color:#f8fafc";
    const h=document.createElement("h2");h.textContent="Verified ticket revenue";
    const note=document.createElement("p");note.textContent="Only payment_transactions marked succeeded are counted. This is gross ticket revenue, not a payout balance.";
    note.style.color="#94a3b8";
    const body=document.createElement("div");body.textContent="Loading verified transactions…";panel.append(h,note,body);view.prepend(panel);
    const {data:events,error}=await supabaseClient.from("events").select("id,title").eq("creator_id",currentUser.id);
    if(error){body.textContent="Could not load events: "+error.message;return;}
    const ids=(events||[]).map(e=>e.id);
    if(!ids.length){body.textContent="No event revenue yet.";return;}
    const {data:payments,error:paymentError}=await supabaseClient.from("payment_transactions").select("event_id,amount_kes,status,provider_receipt,created_at").in("event_id",ids).eq("status","succeeded").order("created_at",{ascending:false});
    if(paymentError){body.textContent="Revenue is unavailable until the migration and RLS policies are applied: "+paymentError.message;return;}
    const total=(payments||[]).reduce((sum,p)=>sum+Number(p.amount_kes||0),0);
    const totalLine=document.createElement("h3");totalLine.textContent=`Gross verified revenue: KSh ${total.toLocaleString()}`;body.appendChild(totalLine);
    const eventMap=new Map(events.map(e=>[e.id,e.title]));
    if(!payments?.length){const empty=document.createElement("p");empty.textContent="No verified ticket payments yet.";body.appendChild(empty);}
    (payments||[]).forEach(p=>{const row=document.createElement("div");row.style.cssText="padding:10px 0;border-top:1px solid #334155";const line=document.createElement("div");line.textContent=`${eventMap.get(p.event_id)||"Event"} · KSh ${Number(p.amount_kes).toLocaleString()}`;const meta=document.createElement("small");meta.style.color="#94a3b8";meta.textContent=`${p.provider_receipt||"Verified payment"} · ${new Date(p.created_at).toLocaleString()}`;row.append(line,meta);body.appendChild(row);});
  }

  async function loadCreatorAnalytics() {
    const view = $("#view-analytics");
    if (!view || $("#lc-analytics-live")) return;
    const panel = document.createElement("section");
    panel.id = "lc-analytics-live";
    panel.style.cssText = "margin:18px 0;padding:18px;border:1px solid #334155;border-radius:14px;background:#0f172a;color:#f8fafc";
    const heading = document.createElement("h2"); heading.textContent = "Live database analytics";
    const note = document.createElement("p"); note.textContent = "Counts below are calculated from saved event, ticket, payment and view-session records; views represent sessions, not unique people.";
    note.style.color = "#94a3b8";
    const content = document.createElement("div"); content.textContent = "Loading event analytics…";
    panel.append(heading,note,content); view.prepend(panel);
    const {data:events,error}=await supabaseClient.from("events").select("id,title,is_live,scheduled_at").eq("creator_id",currentUser.id).order("scheduled_at",{ascending:false}).limit(30);
    if(error){content.textContent="Analytics could not load: "+error.message;return;}
    content.replaceChildren();
    if(!events?.length){content.textContent="Create an event to start collecting analytics.";return;}
    for(const event of events){
      const {data, error:rpcError}=await supabaseClient.rpc("creator_event_analytics",{p_event_id:event.id});
      const row=document.createElement("div"); row.style.cssText="padding:12px 0;border-bottom:1px solid #334155";
      const title=document.createElement("strong");title.textContent=event.title||"Untitled event";
      const details=document.createElement("p");details.style.color="#cbd5e1";
      details.textContent=rpcError?"Analytics not available until migrations/policies are applied.":`View sessions: ${data.view_sessions} · Peak concurrent: ${data.peak_concurrent_viewers} · Paid tickets: ${data.paid_tickets} · Gross revenue: KSh ${Number(data.gross_revenue_kes||0).toLocaleString()}`;
      row.append(title,details);content.appendChild(row);
    }
  }

  function buildNotificationCenter() {
    if ($("#lc-notification-root")) return;
    const root = document.createElement("div");
    root.id = "lc-notification-root";
    root.innerHTML = `
      <style>
       #lc-notification-root{position:fixed;right:18px;bottom:18px;z-index:9998;font:14px/1.45 system-ui,sans-serif;color:#f8fafc}
       #lc-notification-root button{cursor:pointer;border:1px solid #475569;border-radius:10px;padding:10px 13px;background:#111827;color:#f8fafc}
       #lc-notification-root .lc-panel{display:none;position:absolute;right:0;bottom:48px;width:min(360px,calc(100vw - 36px));max-height:55vh;overflow:auto;background:#0f172a;border:1px solid #334155;border-radius:14px;padding:12px;box-shadow:0 15px 45px #0008}
       #lc-notification-root .lc-item{padding:10px 2px;border-bottom:1px solid #334155}
       #lc-notification-root .lc-muted{color:#94a3b8;font-size:12px}
      </style>
      <div class="lc-panel" id="lc-notification-panel"><strong>Notifications</strong><div id="lc-notification-list" class="lc-muted" style="padding:12px 0">Loading…</div></div>
      <div style="display:flex;gap:6px;justify-content:flex-end"><a href="account.html" style="border:1px solid #475569;border-radius:10px;padding:10px 13px;background:#111827;color:#f8fafc;text-decoration:none">My Account</a><button id="lc-notification-toggle" type="button" aria-label="Open notifications">🔔 Notifications <span id="lc-unread-count"></span></button></div>`;
    document.body.appendChild(root);
    $("#lc-notification-toggle").addEventListener("click", async () => {
      const panel = $("#lc-notification-panel");
      panel.style.display = panel.style.display === "block" ? "none" : "block";
      if (panel.style.display === "block") await loadNotifications();
    });
    loadNotifications();
  }

  async function loadNotifications() {
    const list = $("#lc-notification-list");
    if (!list || !currentUser) return;
    const { data, error } = await supabaseClient.from("user_notifications")
      .select("id,title,body,action_url,read_at,created_at")
      .eq("user_id", currentUser.id).order("created_at", {ascending:false}).limit(20);
    if (error) { list.textContent = "Notifications are not available yet. Check the database migration and RLS policies."; return; }
    const rows = data || [];
    const unread = rows.filter(n => !n.read_at).length;
    $("#lc-unread-count").textContent = unread ? `(${unread})` : "";
    list.replaceChildren();
    if (!rows.length) { list.textContent = "You're all caught up."; return; }
    rows.forEach(n => {
      const item = document.createElement("div"); item.className = "lc-item";
      const title = document.createElement("strong"); title.textContent = n.title || "Notification";
      const body = document.createElement("div"); body.textContent = n.body || "";
      const date = document.createElement("div"); date.className = "lc-muted"; date.textContent = n.created_at ? new Date(n.created_at).toLocaleString() : "";
      item.append(title, body, date);
      if (n.action_url) {
        const a = document.createElement("a"); a.href = n.action_url; a.textContent = "Open"; a.style.color = "#a5b4fc"; item.appendChild(a);
      }
      if (!n.read_at) item.style.borderLeft = "3px solid #818cf8";
      item.addEventListener("click", async () => {
        if (!n.read_at) await supabaseClient.from("user_notifications").update({read_at:new Date().toISOString()}).eq("id",n.id).eq("user_id",currentUser.id);
      });
      list.appendChild(item);
    });
  }

  async function initEventTools() {
    const { data: event, error } = await supabaseClient.from("events")
      .select("id,title,creator_id,price_kes,is_live,replay_url,access_mode")
      .eq("id", eventId).maybeSingle();
    if (error || !event) return;
    currentEvent = event;
    startViewSession(event);
    const target = document.querySelector(".player-container, .video-container, #video-container, .watch-container, main") || document.body;
    if ($("#lc-event-tools")) return;
    const box = document.createElement("div");
    box.id = "lc-event-tools";
    box.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0;padding:10px;border:1px solid #334155;border-radius:12px;background:#0f172a;color:#f8fafc";
    const makeBtn = (label, fn) => { const b=document.createElement("button"); b.type="button"; b.textContent=label; b.style.cssText="border:1px solid #475569;border-radius:8px;padding:8px 11px;background:#1e293b;color:white;cursor:pointer"; b.addEventListener("click",fn); return b; };
    if (currentUser && event.creator_id !== currentUser.id) {
      box.append(makeBtn("＋ Follow creator", toggleFollow), makeBtn("☆ Save event", toggleSave));
    }
    if (event.access_mode === "code" && currentUser && event.creator_id !== currentUser.id) {
      box.append(makeBtn("🔐 Enter access code", redeemAccessCode));
    }
    box.append(makeBtn("⚑ Report event", reportEvent));
    if (Number(event.price_kes)>0 && currentUser && event.creator_id !== currentUser.id) {
      box.append(makeBtn(`Buy ticket · KSh ${Math.ceil(Number(event.price_kes))}`, buyTicket));
    }
    if (!currentUser && Number(event.price_kes)>0) {
      box.append(makeBtn("Sign in to buy ticket", () => location.href=`login.html?next=${encodeURIComponent(location.href)}`));
    }
    if (box.children.length) target.prepend(box);
  }

  let viewSessionKey = null;
  function startViewSession(event) {
    if (!eventId || viewSessionKey) return;
    viewSessionKey = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    const isReplay = !event.is_live && Boolean(event.replay_url);
    const send = async (action) => {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const headers = { "Content-Type":"application/json", "apikey":window.SUPABASE_ANON_KEY };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        await fetch(`${window.SUPABASE_URL}/functions/v1/view-session`, {
          method:"POST", headers, keepalive:true,
          body:JSON.stringify({action,eventId,sessionKey:viewSessionKey,isReplay})
        });
      } catch (e) { console.warn("View tracking unavailable", e); }
    };
    send("start");
    let ended = false;
    const stop = () => { if (ended) return; ended=true; send("stop"); };
    window.addEventListener("pagehide", stop, {once:true});
    document.addEventListener("visibilitychange", () => { if(document.visibilityState==="hidden") stop(); }, {once:true});
  }

  async function redeemAccessCode() {
    if (!currentUser || !currentEvent) return alert("Please sign in first.");
    const code = prompt("Enter the invitation code for this event:");
    if (!code) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return alert("Your session expired. Please sign in again.");
    const response = await fetch(`${window.SUPABASE_URL}/functions/v1/access-code`, {
      method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${session.access_token}`,"apikey":window.SUPABASE_ANON_KEY},
      body:JSON.stringify({action:"redeem",eventId:currentEvent.id,code})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.ok) return alert(data.error||"Access code was not accepted.");
    alert("Access granted. Reloading the event now.");
    location.reload();
  }

  async function toggleFollow() {
    if (!currentUser || !currentEvent) return alert("Please sign in first.");
    const { data: row } = await supabaseClient.from("creator_follows").select("id").eq("follower_id",currentUser.id).eq("creator_id",currentEvent.creator_id).maybeSingle();
    const result = row
      ? await supabaseClient.from("creator_follows").delete().eq("id",row.id)
      : await supabaseClient.from("creator_follows").insert({follower_id:currentUser.id,creator_id:currentEvent.creator_id});
    if (result.error) return alert("Follow action failed. Check that the database migration has been applied.");
    alert(row ? "Creator unfollowed." : "You're now following this creator.");
  }
  async function toggleSave() {
    if (!currentUser || !currentEvent) return alert("Please sign in first.");
    const { data: row } = await supabaseClient.from("saved_events").select("id").eq("user_id",currentUser.id).eq("event_id",currentEvent.id).maybeSingle();
    const result = row ? await supabaseClient.from("saved_events").delete().eq("id",row.id) : await supabaseClient.from("saved_events").insert({user_id:currentUser.id,event_id:currentEvent.id});
    if (result.error) return alert("Save action failed. Check the database migration.");
    alert(row ? "Event removed from saved events." : "Event saved to your account.");
  }
  async function reportEvent() {
    if (!currentEvent) return;
    if (!currentUser) return alert("Please sign in to report an event.");
    const reason = prompt("Why are you reporting this event? (e.g. harmful content, impersonation, scam)");
    if (!reason || !reason.trim()) return;
    const details = prompt("Additional details (optional):") || "";
    const { error } = await supabaseClient.from("event_reports").insert({event_id:currentEvent.id,reporter_id:currentUser.id,reason:reason.trim(),details,status:"open"});
    if (error) return alert("Report could not be submitted. Check database migration and policies.");
    alert("Thank you. Your report has been submitted for review.");
  }
  async function buyTicket() {
    if (!currentUser || !currentEvent) return alert("Please sign in first.");
    const phone = prompt("Enter the Kenyan M-Pesa number to receive the payment prompt (e.g. 0712345678):");
    if (!phone) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return alert("Your session expired. Please sign in again.");
    const response = await fetch(`${window.SUPABASE_URL}/functions/v1/mpesa-stk-push`, {
      method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${session.access_token}`, "apikey":window.SUPABASE_ANON_KEY },
      body:JSON.stringify({eventId:currentEvent.id,phone})
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok || !data.ok) return alert(data.error || "Could not start M-Pesa payment.");
    alert(data.message || "Payment request sent. Approve the prompt on your phone. Ticket access is granted only after provider verification.");
  }
  window.LiveConcertsPlatform = { loadNotifications, buyTicket, reportEvent, toggleFollow, toggleSave };
  document.addEventListener("DOMContentLoaded", init);
})();
