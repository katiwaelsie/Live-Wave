// js/config.js (or config.js depending on your folder)

const SUPABASE_URL = 'https://otzwaylngzkcasvwdlid.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90endheWxuZ3prY2FzdndkbGlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNTE2MzcsImV4cCI6MjEwODYyNzYzN30.1aeNcZRW-tqGmoBKD4NwBNXW8zR_KUUxa30d8aNmDmI';


const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Expose public configuration for shared feature modules; never put service-role secrets here.
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
