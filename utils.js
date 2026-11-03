function showToast(message, isError = false) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.innerHTML = `<i class="fa-solid ${isError ? 'fa-circle-xmark' : 'fa-circle-check'}"></i> ${message}`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function toggleSidebar() {
    document.body.classList.toggle('sidebar-collapsed');
}

function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    showToast(isLight ? 'Switched to Light Mode' : 'Switched to Dark Mode');
}

function setupSidebarRoleLinks() {
    const userRole = localStorage.getItem('userRole') || 'guest';
    const creatorBtn = document.getElementById('nav-creator-studio');
    const adminBtn = document.getElementById('nav-admin');
    const authBtn = document.getElementById('nav-auth');
    const logoutBtn = document.getElementById('nav-logout');

    if (creatorBtn) creatorBtn.style.display = (userRole === 'creator' || userRole === 'admin') ? 'flex' : 'none';
    if (adminBtn) adminBtn.style.display = (userRole === 'admin') ? 'flex' : 'none';

    if (authBtn) authBtn.style.display = (userRole === 'guest') ? 'flex' : 'none';
    if (logoutBtn) {
        logoutBtn.style.display = (userRole !== 'guest') ? 'flex' : 'none';
        logoutBtn.onclick = (e) => {
            e.preventDefault();
            localStorage.removeItem('userRole');
            window.location.href = 'index.html';
        };
    }
}

function updateNotificationBadge() {
    const badge = document.getElementById('notif-badge');
    if (badge) {
        const count = parseInt(localStorage.getItem('notifCount') || '0');
        badge.textContent = count > 0 ? (count > 9 ? '9+' : count) : '';
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-theme');
    }
    setupSidebarRoleLinks();
    updateNotificationBadge();
});