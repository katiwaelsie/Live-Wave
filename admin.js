// LiveConcerts admin navigation only. Data-changing actions are handled by admin-secure.js
// and the server-side admin-action Edge Function; never simulate success in the browser.
const adminViews = ['overview','live','creators','users','payouts','audit-log','broadcast-notif','tickets-mgmt','categories','regions','roles'];
adminViews.forEach(view => {
  const link = document.getElementById('nav-' + view);
  if (!link) return;
  link.addEventListener('click', event => {
    event.preventDefault();
    document.querySelectorAll('.page-view').forEach(section => { section.style.display='none'; });
    const target = document.getElementById('view-' + view);
    if (target) target.style.display='block';
    document.querySelectorAll('.sidebar-nav a').forEach(a=>a.classList.remove('active'));
    link.classList.add('active');
  });
});
