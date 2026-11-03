(() => {
  const html = (tag, text) => { const e=document.createElement(tag); e.textContent=text ?? ""; return e; };
  const makeTable = (headers, rows) => {
    const table=document.createElement("table"); table.className="admin-table";
    const thead=document.createElement("thead"), tr=document.createElement("tr");
    headers.forEach(h=>tr.appendChild(html("th",h))); thead.appendChild(tr); table.appendChild(thead);
    const tbody=document.createElement("tbody");
    if (!rows.length) { const r=document.createElement("tr"), c=html("td","No records found."); c.colSpan=headers.length;r.appendChild(c);tbody.appendChild(r); }
    rows.forEach(row=>tbody.appendChild(row)); table.appendChild(tbody); return table;
  };
  const td=(v)=>html("td",v==null?"—":String(v));
  async function adminAction(action,targetId,value,details={}) {
    const {data:{session}}=await supabaseClient.auth.getSession();
    const r=await fetch(`${SUPABASE_URL}/functions/v1/admin-action`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${session.access_token}`,"apikey":SUPABASE_ANON_KEY},body:JSON.stringify({action,targetId,value,details})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok)throw new Error(j.error||"Admin action failed");
    return j.result;
  }
  function section(title, description) {
    const h=document.createElement("h2");h.textContent=title;h.style.marginTop="24px";
    const p=document.createElement("p");p.textContent=description;p.style.color="#94a3b8";
    const wrap=document.createElement("div");wrap.append(h,p);document.body.appendChild(wrap);return wrap;
  }
  window.lcAdminAction = adminAction;
  async function load() {
    const veil=document.createElement("div"); veil.id="lc-admin-auth-check";
    veil.style.cssText="position:fixed;inset:0;z-index:99999;background:#0b1020;color:white;display:grid;place-items:center;font:16px system-ui";
    veil.textContent="Verifying administrator permissions…"; document.body.appendChild(veil);
    const {data:{user},error:authError}=await supabaseClient.auth.getUser();
    if(authError||!user){location.replace(`login.html?next=${encodeURIComponent("admin.html")}`);return;}
    const {data:role,error}=await supabaseClient.from("user_roles").select("role").eq("user_id",user.id).eq("role","admin").maybeSingle();
    if(error||!role){veil.textContent="Access denied. This account is not a platform administrator.";return;}
    veil.remove();
    const target=document.querySelector("#view-overview")||document.body;
    const panel=document.createElement("section");panel.style.cssText="padding:18px;margin:18px 0;background:#101827;border:1px solid #334155;border-radius:14px";
    panel.innerHTML="<h2>Live database overview</h2><p style='color:#94a3b8'>Counts and records loaded from Supabase. Changes are saved through the protected admin-action function.</p><div id='lc-admin-real-stats' style='display:flex;gap:12px;flex-wrap:wrap'></div><div id='lc-admin-real-tables'></div>";
    target.prepend(panel);
    const stats=$("#lc-admin-real-stats"), tables=$("#lc-admin-real-tables");
    const notify=document.createElement("div");notify.style.cssText="margin-top:18px;padding:14px;border:1px solid #334155;border-radius:12px";
    const nh=html("h3","Send in-app notification");
    const titleInput=document.createElement("input");titleInput.placeholder="Notification title";titleInput.maxLength=120;titleInput.style.cssText="display:block;width:100%;padding:10px;margin:8px 0;background:#0b1020;color:white;border:1px solid #475569;border-radius:8px";
    const bodyInput=document.createElement("textarea");bodyInput.placeholder="Message";bodyInput.maxLength=1000;bodyInput.style.cssText=titleInput.style.cssText+"min-height:70px";
    const userInput=document.createElement("input");userInput.placeholder="Recipient user UUID (leave blank to send to all users)";userInput.style.cssText=titleInput.style.cssText;
    const urlInput=document.createElement("input");urlInput.placeholder="Optional action URL, e.g. index.html";urlInput.style.cssText=titleInput.style.cssText;
    const sendBtn=html("button","Send notification");sendBtn.type="button";sendBtn.onclick=async()=>{try{if(!titleInput.value.trim())throw new Error("Enter a title.");const details={title:titleInput.value.trim(),body:bodyInput.value.trim(),userId:userInput.value.trim()||null,allUsers:!userInput.value.trim(),actionUrl:urlInput.value.trim()||null};const result=await adminAction("create_notification",null,null,details);alert(details.allUsers?`Notification sent to ${result.sent} profiles.`:"Notification sent.");titleInput.value="";bodyInput.value="";userInput.value="";urlInput.value="";}catch(e){alert(e.message);}};
    notify.append(nh,titleInput,bodyInput,userInput,urlInput,sendBtn);panel.appendChild(notify);
    function $(s){return panel.querySelector(s)}
    const [eventsR, profilesR, paymentsR, reportsR, logsR, categoriesR] = await Promise.all([
      supabaseClient.from("events").select("id,title,creator_id,is_live,price_kes,scheduled_at,moderation_status").order("scheduled_at",{ascending:false}).limit(100),
      supabaseClient.from("profiles").select("*").limit(100),
      supabaseClient.from("payment_transactions").select("id,event_id,user_id,amount_kes,status,provider_receipt,created_at").order("created_at",{ascending:false}).limit(100),
      supabaseClient.from("event_reports").select("id,event_id,reporter_id,reason,status,created_at").order("created_at",{ascending:false}).limit(100),
      supabaseClient.from("platform_audit_logs").select("id,actor_id,action,target_type,target_id,created_at").order("created_at",{ascending:false}).limit(100),
      supabaseClient.from("event_categories").select("*").order("name")
    ]);
    const events=eventsR.data||[], profiles=profilesR.data||[], payments=paymentsR.data||[], reports=reportsR.data||[], logs=logsR.data||[], categories=categoriesR.data||[];
    const statData=[["Events",events.length],["Live now",events.filter(e=>e.is_live).length],["Profiles",profiles.length],["Verified payments",payments.filter(p=>p.status==="succeeded").length],["Open reports",reports.filter(r=>r.status==="open").length]];
    statData.forEach(([label,value])=>{const card=document.createElement("div");card.style.cssText="padding:12px 16px;border:1px solid #334155;border-radius:10px;min-width:110px";const strong=html("strong",value);strong.style.display="block";strong.style.fontSize="24px";card.append(strong,html("span",label));stats.appendChild(card);});
    function add(title, desc, table){const h=html("h3",title);h.style.marginTop="24px";const p=html("p",desc);p.style.color="#94a3b8";tables.append(h,p,table);}
    add("Events & moderation","Hide or restore events. This updates moderation status; it does not remotely disconnect an Agora publisher.",makeTable(["Event","Status","Moderation","Action"],events.map(e=>{const r=document.createElement("tr");r.append(td(e.title),td(e.is_live?"LIVE":"OFFLINE"),td(e.moderation_status||"active"));const cell=html("td","");const b=html("button",(e.moderation_status==="hidden"?"Restore":"Hide"));b.type="button";b.onclick=async()=>{try{await adminAction("set_event_moderation",e.id,e.moderation_status==="hidden"?"active":"hidden");alert("Event moderation status saved.");location.reload();}catch(x){alert(x.message)}};cell.appendChild(b);r.appendChild(cell);return r;})));
    add("Accounts","Account status is saved to profiles.account_status.",makeTable(["Profile","Creator status","Account status","Action"],profiles.map(p=>{const r=document.createElement("tr");r.append(td(p.username||p.full_name||p.id),td(p.creator_status),td(p.account_status));const cell=html("td","");const b=html("button",p.account_status==="suspended"?"Reactivate":"Suspend");b.onclick=async()=>{try{await adminAction("set_account_status",p.id,p.account_status==="suspended"?"active":"suspended");alert("Account status saved.");location.reload();}catch(x){alert(x.message)}};cell.appendChild(b);r.appendChild(cell);return r;})));
    add("Payment transactions","Read-only records. Payouts are not sent by this screen.",makeTable(["Payment ID","Event","User","Amount KES","Status","Receipt"],payments.map(p=>{const r=document.createElement("tr");[p.id,p.event_id,p.user_id,p.amount_kes,p.status,p.provider_receipt].forEach(v=>r.append(td(v)));return r;})));
    add("Event reports","Resolve, dismiss, or mark reports for review.",makeTable(["Event","Reason","Status","Action"],reports.map(p=>{const r=document.createElement("tr");r.append(td(p.event_id),td(p.reason),td(p.status));const c=html("td","");["reviewing","resolved","dismissed"].forEach(v=>{const b=html("button",v);b.style.marginRight="4px";b.onclick=async()=>{try{await adminAction("review_report",p.id,v);alert("Report updated.");location.reload();}catch(x){alert(x.message)}};c.appendChild(b)});r.appendChild(c);return r;})));
    add("Audit log","Recent recorded admin actions.",makeTable(["Action","Target","Target ID","Actor","Created"],logs.map(l=>{const r=document.createElement("tr");[l.action,l.target_type,l.target_id,l.actor_id,l.created_at].forEach(v=>r.append(td(v)));return r;})));
    add("Categories","Categories saved in the database.",makeTable(["Category","Status","Created"],categories.map(c=>{const r=document.createElement("tr");[c.name,c.active?"Active":"Inactive",c.created_at].forEach(v=>r.append(td(v)));return r;})));
    const errors=[eventsR,profilesR,paymentsR,reportsR,logsR,categoriesR].filter(r=>r.error);
    if(errors.length){const warning=html("p","Some sections could not load. Review the database migration and RLS policies. "+errors.map(e=>e.error.message).join(" | "));warning.style.color="#fca5a5";panel.appendChild(warning);}
  }
  document.addEventListener("DOMContentLoaded",()=>{if(!window.supabaseClient)return;load().catch(e=>{console.error(e);alert("Admin dashboard could not load: "+e.message);});});
})();
