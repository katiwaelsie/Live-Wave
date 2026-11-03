// LiveConcerts homepage logic. Event text is inserted with textContent to avoid HTML injection.
let currentCurrency = 'KES';
const exchangeRates = { KES: 1, USD: 0.0077, EUR: 0.0071, NGN: 11.5 };
const currencySymbols = { KES: 'KES ', USD: '$', EUR: '€', NGN: '₦' };
let cachedEvents = [];
let currentSearch = '';
let currentCategory = 'all';

function formatPrice(price) {
    if (Number(price) === 0) return 'Free';
    const converted = Math.round(Number(price || 0) * exchangeRates[currentCurrency]);
    return `${currencySymbols[currentCurrency]}${converted}`;
}

function safeDate(value) {
    if (!value) return 'Date to be announced';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date to be announced' : date.toLocaleString();
}

function createCard(event) {
    const card = document.createElement('article');
    card.className = 'event-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', `Open event ${event.title || 'Untitled event'}`);

    const imageWrap = document.createElement('div');
    imageWrap.style.position = 'relative';
    imageWrap.style.overflow = 'hidden';

    const image = document.createElement('img');
    image.className = 'event-thumb';
    image.alt = event.title ? `${event.title} event poster` : 'Event poster';
    image.loading = 'lazy';
    image.src = event.thumbnail_url || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=600&auto=format&fit=crop';
    image.onerror = () => { image.onerror = null; image.src = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=600&auto=format&fit=crop'; };
    imageWrap.appendChild(image);

    const now = Date.now();
    const scheduled = event.scheduled_at ? new Date(event.scheduled_at).getTime() : NaN;
    let statusText = '';
    if (event.is_live) statusText = 'LIVE';
    else if (event.replay_url) statusText = 'REPLAY';
    else if (Number.isFinite(scheduled) && scheduled > now) statusText = 'UPCOMING';
    else statusText = 'ENDED';

    const ribbon = document.createElement('span');
    ribbon.className = event.is_live ? 'live-ribbon' : 'event-status-ribbon';
    ribbon.textContent = statusText;
    if (!event.is_live) {
        Object.assign(ribbon.style, {
            position: 'absolute', top: '12px', left: '12px',
            background: statusText === 'REPLAY' ? '#3b82f6' : '#27272a',
            color: '#fff', padding: '4px 10px', borderRadius: '4px',
            fontSize: '.75rem', fontWeight: '800'
        });
    }
    imageWrap.appendChild(ribbon);

    const info = document.createElement('div');
    info.className = 'event-info';
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = event.title || 'Untitled event';
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const creatorName = event.profiles?.display_name || 'Creator';
    const category = event.category ? ` · ${event.category}` : '';
    meta.textContent = `${formatPrice(event.price_kes)} · ${creatorName}${category}`;
    const date = document.createElement('div');
    date.className = 'event-meta';
    date.style.marginTop = '6px';
    date.textContent = safeDate(event.scheduled_at);
    info.append(title, meta, date);
    card.append(imageWrap, info);

    const open = () => { window.location.href = `watch.html?id=${encodeURIComponent(event.id)}`; };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return card;
}

function matchesSearch(event) {
    const haystack = [event.title, event.category, event.profiles?.display_name]
        .filter(Boolean).join(' ').toLocaleLowerCase();
    const matchesText = !currentSearch || haystack.includes(currentSearch);
    const matchesCategory = currentCategory === 'all' || String(event.category || '').toLowerCase() === currentCategory.toLowerCase();
    return matchesText && matchesCategory;
}

function populateCategoryFilter() {
    const select = document.getElementById('category-filter');
    if (!select) return;
    const selected = currentCategory;
    const categories = [...new Set(cachedEvents.map(e => String(e.category || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    select.replaceChildren();
    const all = document.createElement('option'); all.value='all'; all.textContent='All categories'; select.appendChild(all);
    categories.forEach(category => { const option=document.createElement('option'); option.value=category; option.textContent=category; select.appendChild(option); });
    select.value = categories.some(c=>c.toLowerCase()===selected.toLowerCase()) ? selected : 'all';
}

function renderEventGrids() {
    const liveGrid = document.getElementById('live-grid');
    const upcomingGrid = document.getElementById('upcoming-grid');
    if (!liveGrid || !upcomingGrid) return;

    const filtered = cachedEvents.filter(matchesSearch);
    const live = filtered.filter(e => e.is_live);
    const now = Date.now();
    const nonLive = filtered.filter(e => !e.is_live).sort((a, b) => {
        const aDate = a.scheduled_at ? new Date(a.scheduled_at).getTime() : Infinity;
        const bDate = b.scheduled_at ? new Date(b.scheduled_at).getTime() : Infinity;
        return aDate - bDate;
    });
    const upcoming = nonLive.filter(e => !e.replay_url && e.scheduled_at && new Date(e.scheduled_at).getTime() > now);
    const replaysOrEnded = nonLive.filter(e => e.replay_url || !e.scheduled_at || new Date(e.scheduled_at).getTime() <= now);
    const secondary = [...upcoming, ...replaysOrEnded];

    liveGrid.replaceChildren();
    upcomingGrid.replaceChildren();
    if (!live.length) {
        const p = document.createElement('p');
        p.style.color = 'var(--text-muted)';
        p.textContent = currentSearch ? 'No live events match your search.' : 'No live streams right now.';
        liveGrid.appendChild(p);
    } else live.forEach(e => liveGrid.appendChild(createCard(e)));

    if (!secondary.length) {
        const p = document.createElement('p');
        p.style.color = 'var(--text-muted)';
        p.textContent = currentSearch ? 'No upcoming events or replays match your search.' : 'No upcoming events or replays yet.';
        upcomingGrid.appendChild(p);
    } else secondary.forEach(e => upcomingGrid.appendChild(createCard(e)));
}

async function loadEvents() {
    const liveGrid = document.getElementById('live-grid');
    if (!liveGrid) return;
    const { data: events, error } = await supabaseClient
        .from('events')
        .select('id, title, price_kes, category, is_live, scheduled_at, thumbnail_url, replay_url, moderation_status, profiles:creator_id (display_name)')
        .order('scheduled_at', { ascending: true });

    if (error) {
        console.error('Could not load events:', error);
        liveGrid.textContent = 'Failed to load live streams. Please refresh and try again.';
        const upcomingGrid = document.getElementById('upcoming-grid');
        if (upcomingGrid) upcomingGrid.textContent = 'Failed to load events.';
        return;
    }
    cachedEvents = (events || []).filter(e => !['hidden','removed'].includes(e.moderation_status));
    populateCategoryFilter();
    renderEventGrids();
}

async function renderMyTickets() {
    const container = document.getElementById('my-tickets-container');
    if (!container) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        container.textContent = 'Please log in to see your tickets.';
        return;
    }
    const { data: tickets, error } = await supabaseClient.from('tickets')
        .select('id, paid, events:event_id (id, title, price_kes, thumbnail_url, is_live, replay_url, profiles:creator_id(display_name))')
        .eq('user_id', session.user.id).eq('paid', true);
    if (error) {
        console.error('Could not load tickets:', error);
        container.textContent = 'Tickets could not be loaded. Please try again later.';
        return;
    }
    if (!tickets || tickets.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:3rem 2rem;background:var(--card-bg);border-radius:16px;border:1px solid var(--border)"><h2>No tickets yet</h2><p style="color:var(--text-muted);margin-bottom:1.5rem">Tickets from verified purchases will appear here.</p><button class="btn-primary" id="find-events-btn">Find Events</button></div>`;
        document.getElementById('find-events-btn')?.addEventListener('click', () => switchView('home', document.getElementById('nav-home')));
        return;
    }
    container.replaceChildren();
    tickets.forEach(ticket => {
        const ev = ticket.events;
        if (!ev) return;
        const card = document.createElement('div');
        card.className = 'event-card';
        card.style.cssText = 'display:flex;padding:1.5rem;gap:1.5rem;align-items:center;cursor:default;margin-bottom:1rem;flex-wrap:wrap';
        const title = document.createElement('h3'); title.textContent = ev.title || 'Event';
        const meta = document.createElement('p'); meta.style.color = 'var(--text-muted)';
        meta.textContent = `Host: ${ev.profiles?.display_name || 'Creator'} · ${ev.is_live ? 'LIVE' : ev.replay_url ? 'Replay available' : 'Scheduled'}`;
        const body = document.createElement('div'); body.style.flex = '1'; body.append(title, meta);
        const button = document.createElement('button'); button.className = 'btn-primary'; button.textContent = ev.is_live ? 'Watch Now' : 'Open Event';
        button.addEventListener('click', () => { window.location.href = `watch.html?id=${encodeURIComponent(ev.id)}`; });
        card.append(body, button); container.appendChild(card);
    });
}

async function loadProfile() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;
    const { data: profile } = await supabaseClient.from('profiles').select('display_name, is_creator').eq('id', session.user.id).maybeSingle();
    if (profile) {
        const name = profile.display_name || 'User';
        const nameInput = document.getElementById('profile-name-input'); if (nameInput) nameInput.value = name;
        const displayName = document.getElementById('profile-display-name'); if (displayName) displayName.textContent = name;
        const initial = document.getElementById('profile-avatar-initial'); if (initial) initial.textContent = name.charAt(0).toUpperCase();
        const role = document.getElementById('profile-role-label'); if (role) role.textContent = profile.is_creator ? 'Creator Account' : 'Viewer Account';
    }
    const email = document.getElementById('profile-email-input'); if (email) email.value = session.user.email || '';
}

async function saveProfile() {
    const name = document.getElementById('profile-name-input')?.value.trim();
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { showToast('Not logged in', true); return; }
    if (!name) { showToast('Enter a display name.', true); return; }
    const { error } = await supabaseClient.from('profiles').update({ display_name: name }).eq('id', session.user.id);
    if (error) { showToast(error.message, true); return; }
    showToast('Profile updated successfully!');
    const displayName = document.getElementById('profile-display-name'); if (displayName) displayName.textContent = name;
    const initial = document.getElementById('profile-avatar-initial'); if (initial) initial.textContent = name.charAt(0).toUpperCase();
}

async function renderTrending() {
    const grid = document.getElementById('trending-grid');
    if (!grid) return;
    const { data: events, error } = await supabaseClient.from('events')
        .select('id, title, price_kes, category, is_live, scheduled_at, thumbnail_url, replay_url, moderation_status, profiles:creator_id (display_name)')
        .order('is_live', { ascending: false }).limit(12);
    if (error || !events?.length) { grid.textContent = 'No trending events available yet.'; return; }
    grid.replaceChildren(); events.forEach(e => grid.appendChild(createCard(e)));
}

function switchView(viewName, activeLink) {
    document.querySelectorAll('.page-view').forEach(v => v.style.display = 'none');
    const target = document.getElementById('view-' + viewName);
    if (target) target.style.display = 'block';
    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    if (activeLink) activeLink.classList.add('active');
    if (viewName === 'tickets' || viewName === 'purchases') renderMyTickets();
    if (viewName === 'profile') loadProfile();
    if (viewName === 'trending') renderTrending();
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadEvents();
    ['home', 'trending', 'tickets', 'saved', 'reminders', 'notifications', 'purchases', 'language', 'profile'].forEach(view => {
        const link = document.getElementById('nav-' + view);
        if (link) link.addEventListener('click', e => { e.preventDefault(); switchView(view, e.currentTarget); });
    });
    const search = document.getElementById('global-search');
    if (search) search.addEventListener('input', e => { currentSearch = e.target.value.trim().toLocaleLowerCase(); renderEventGrids(); });
    const currencySelect = document.getElementById('global-currency-select');
    if (currencySelect) currencySelect.addEventListener('change', e => { currentCurrency = e.target.value; renderEventGrids(); });
});

document.getElementById('category-filter')?.addEventListener('change', (e) => {
    currentCategory = e.target.value || 'all';
    renderEventGrids();
});
