/**
 * Observer Central - Enterprise Infrastructure Hub v1.9.5
 * Features:
 * - Unified Header: Title, Stats, and Search condensed into top navigation
 * - Greyscale Palette: Professional monochrome UI (Neutral Greys & White)
 * - Notification Webhooks: Google Chat Webhook support with Mute control
 * - System Footer: Version tracking and quick-link navigation
 * - High-Density List View: Optimized for large-scale deployments
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Firebase SDKs
const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously, onAuthStateChanged } = require('firebase/auth');
const { getFirestore, doc, setDoc, getDoc, collection, getDocs, updateDoc } = require('firebase/firestore');

// --- CONFIGURATION ---
const VERSION = '1.9.5'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'REPLACE_WITH_YOUR_ACTUAL_FIREBASE_PUBLIC_VAPID_KEY';

// --- BACKDOOR CREDENTIALS ---
const BACKDOOR_USER = "Observer";
const BACKDOOR_PASS = "!0bserver!";

let firebaseConfig = null;
if (process.env.FIREBASE_API_KEY) {
    firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID
    };
} else if (fs.existsSync(CONFIG_PATH)) {
    try {
        firebaseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch(e) { console.error("Config parse failed"); }
}

const appId = typeof __app_id !== 'undefined' ? __app_id : (process.env.OBSERVER_APP_ID || 'observer-prod');
const app = initializeApp(firebaseConfig || { apiKey: "none" });
const auth = getAuth(app);
const db = getFirestore(app);

const nodes = new Map();
let settings = { 
    siteTitle: "OBSERVER HUB", 
    logoUrl: "https://cdn-icons-png.flaticon.com/512/564/564348.png",
    allowedAdmins: [],
    webhookUrl: "",
    muteNotifications: false
};
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Sync Engine Online. AppID: ${appId}`);
        try {
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => nodes.set(d.id, d.data()));
            const setDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'));
            if (setDocRef.exists()) {
                const data = setDocRef.data();
                settings = { ...settings, ...data, allowedAdmins: data.allowedAdmins || [] };
            }
        } catch(e) { console.error("Recovery failed:", e.message); }
    }
});

function processUptime(nodeId, data) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const existing = nodes.get(nodeId) || {};
    let uptimeStats = existing.uptimeStats || { firstSeen: now, buckets: {} };
    if (!uptimeStats.buckets[today]) uptimeStats.buckets[today] = 0;
    const lastSeen = existing.lastSeen || now;
    const deltaSeconds = Math.floor((now - lastSeen) / 1000);
    if (deltaSeconds > 0 && deltaSeconds < (OFFLINE_THRESHOLD * 2 / 1000)) {
        uptimeStats.buckets[today] += deltaSeconds;
    }
    const dates = Object.keys(uptimeStats.buckets).sort();
    if (dates.length > 366) delete uptimeStats.buckets[dates[0]];
    return uptimeStats;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const uptimeStats = processUptime(data.id, data);
                const existing = nodes.get(data.id) || { scannedDevices: [], isArchived: false };
                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];
                (data.scannedDevices || []).forEach(newDev => {
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        const oldDev = mergedDevices[idx];
                        mergedDevices[idx] = { ...newDev, isImportant: !!oldDev.isImportant, firstSeen: oldDev.firstSeen || Date.now(), lastSeen: Date.now() }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });
                const nodeUpdate = { ...existing, ...data, isArchived: false, uptimeStats, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: req.socket.remoteAddress.replace('::ffff:', '') };
                nodes.set(data.id, nodeUpdate);
                if (currentUser) setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/update-settings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                settings = { ...settings, ...data };
                if (currentUser) await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'), settings);
                res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes: list, settings }));
    }

    else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateUI(firebaseConfig));
    }
});

function generateUI(cfg) {
    return `
    <!DOCTYPE html>
    <html class="dark">
    <head>
        <title>Observer Hub</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="mobile-web-app-capable" content="yes">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #0a0a0a; color: #e5e5e5; }
            .node-row { background: #171717; border: 1px solid #262626; transition: all 0.2s ease; }
            .node-row:hover { border-color: #404040; background: #1c1c1c; }
            .nav-blur { background: rgba(10, 10, 10, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid #262626; }
            .uptime-bar { height: 3px; border-radius: 2px; background: #262626; overflow: hidden; }
            .uptime-fill { height: 100%; background: #ffffff; transition: width 1s ease; opacity: 0.8; }
            .btn-google { background: #ffffff; color: #000000; }
            .hidden { display: none !important; }
            input:focus { outline: none; border-color: #525252 !important; }
        </style>
    </head>
    <body class="min-h-screen antialiased flex flex-col">
        <!-- Auth View -->
        <div id="authView" class="fixed inset-0 z-[200] bg-[#0a0a0a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <div class="mb-12">
                    <i class="fas fa-eye text-white text-5xl mb-6"></i>
                    <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                    <p class="text-neutral-500 text-[10px] font-bold uppercase tracking-[0.4em]">Infrastructure Intelligence</p>
                </div>
                <div id="loginActions">
                    <button onclick="login()" class="btn-google w-full flex items-center justify-center gap-3 py-4 rounded-xl font-bold shadow-2xl mb-8">
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" class="w-5 h-5">
                        Continue with Google
                    </button>
                    <button onclick="showBackdoor()" class="text-[9px] text-neutral-600 font-bold uppercase tracking-[0.2em] hover:text-white transition-colors">Emergency Bypass</button>
                    <p id="authError" class="mt-8 text-red-500 text-[10px] font-bold uppercase hidden">Access Denied</p>
                </div>
                <div id="backdoorView" class="hidden bg-neutral-900 border border-neutral-800 p-8 rounded-3xl">
                    <h2 class="text-sm font-black text-white mb-6 uppercase tracking-widest">System Override</h2>
                    <input type="text" id="bdUser" placeholder="Identity" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-3">
                    <input type="password" id="bdPass" placeholder="Secret" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-6">
                    <button onclick="tryBackdoor()" class="w-full py-3 bg-white text-black rounded-xl font-bold uppercase text-[10px] mb-4">Authorize</button>
                    <button onclick="hideBackdoor()" class="text-neutral-500 text-[9px] font-bold uppercase tracking-widest">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Unified Navigation Bar -->
        <nav id="adminBar" class="hidden sticky top-0 z-[100] nav-blur px-6 py-3 flex items-center gap-8">
            <div class="flex items-center gap-3 min-w-max">
                <img id="headerLogo" src="" class="w-6 h-6 object-contain grayscale" alt="">
                <h1 id="headerTitle" class="text-sm font-black text-white tracking-tight uppercase"></h1>
            </div>

            <div class="flex-1 max-w-xl relative">
                <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600 text-xs"></i>
                <input type="text" id="globalFilter" placeholder="Search infrastructure..." class="w-full bg-neutral-900/50 border border-neutral-800 rounded-full pl-10 pr-4 py-1.5 text-xs text-neutral-300 focus:ring-0">
            </div>

            <div class="flex items-center gap-6 text-[10px] font-black uppercase tracking-widest text-neutral-500">
                <div class="flex items-center gap-2"><span id="statNodes" class="text-white">-</span> Nodes</div>
                <div class="flex items-center gap-2"><span id="statFleet" class="text-white">-</span> Assets</div>
                <div class="flex items-center gap-2 text-emerald-500"><span id="statHealth" class="text-white">-%</span> Health</div>
            </div>

            <div class="flex items-center gap-4 ml-auto">
                <button onclick="toggleView('config')" class="text-neutral-500 hover:text-white transition-colors"><i class="fas fa-cog text-sm"></i></button>
                <div class="h-4 w-px bg-neutral-800"></div>
                <span id="adminEmailDisplay" class="text-[9px] font-bold text-neutral-500 uppercase truncate max-w-[120px]">...</span>
                <button onclick="logout()" class="text-neutral-500 hover:text-red-500 transition-colors"><i class="fas fa-sign-out-alt text-sm"></i></button>
            </div>
        </nav>

        <!-- Main Content -->
        <main id="mainApp" class="hidden flex-1 p-6 max-w-7xl mx-auto w-full">
            <div id="dashboardView" class="view-section">
                <div class="flex flex-col gap-2" id="nodeList"></div>
            </div>

            <div id="explorerView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-white font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                <div id="explorerContent"></div>
            </div>

            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-white font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Exit Settings</button>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-8 uppercase tracking-[0.2em]">Environment Identity</h2>
                        <div class="space-y-6">
                            <div>
                                <label class="block text-[9px] font-bold text-neutral-500 uppercase mb-2">Network Alias</label>
                                <input type="text" id="cfgTitle" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white">
                            </div>
                            <div>
                                <label class="block text-[9px] font-bold text-neutral-500 uppercase mb-2">Logo Asset (URL)</label>
                                <input type="text" id="cfgLogo" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white">
                            </div>
                            <div class="pt-4 border-t border-neutral-800">
                                <h3 class="text-[10px] font-black text-white mb-4 uppercase">Alert Channels</h3>
                                <div class="space-y-4">
                                    <div>
                                        <label class="block text-[9px] font-bold text-neutral-500 uppercase mb-2">Google Chat Webhook</label>
                                        <input type="text" id="cfgWebhook" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white" placeholder="https://chat.googleapis.com/v1/spaces/...">
                                    </div>
                                    <label class="flex items-center gap-3 cursor-pointer">
                                        <input type="checkbox" id="cfgMute" class="w-4 h-4 bg-black border-neutral-800 rounded">
                                        <span class="text-[9px] font-bold text-neutral-400 uppercase">Mute All External Notifications</span>
                                    </label>
                                </div>
                            </div>
                            <button onclick="saveConfig()" class="w-full py-3 bg-white text-black rounded-lg font-black uppercase text-[10px] transition-transform active:scale-95">Commit Changes</button>
                        </div>
                    </div>
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-8 uppercase tracking-[0.2em]">Access Control</h2>
                        <div class="flex gap-2 mb-6">
                            <input type="email" id="newAdminEmail" class="flex-1 bg-black border border-neutral-800 rounded-lg px-4 py-2 text-xs text-white" placeholder="Email Address">
                            <button onclick="addAdmin()" class="bg-neutral-800 px-4 rounded-lg text-white hover:bg-neutral-700"><i class="fas fa-plus text-xs"></i></button>
                        </div>
                        <div id="adminList" class="space-y-2 max-h-[300px] overflow-y-auto pr-2"></div>
                    </div>
                </div>
            </div>
        </main>

        <!-- Persistent Footer -->
        <footer id="mainFooter" class="hidden px-6 py-4 border-t border-neutral-900 text-[9px] font-bold text-neutral-600 flex justify-between items-center bg-[#0a0a0a]">
            <div class="flex items-center gap-6">
                <span>&copy; 2026 OBSERVER INTELLIGENCE</span>
                <span class="text-neutral-800">|</span>
                <span class="uppercase">Build: v${VERSION}</span>
                <span class="text-neutral-800">|</span>
                <span class="flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 opacity-50"></span> SYSTEM NOMINAL</span>
            </div>
            <div class="flex items-center gap-6 uppercase tracking-widest">
                <a href="#" class="hover:text-white transition-colors">Documentation</a>
                <a href="#" class="hover:text-white transition-colors">Support</a>
                <a href="#" class="hover:text-white transition-colors">Audit Logs</a>
            </div>
        </footer>

        <script type="module">
            import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
            import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

            const firebaseConfig = ${JSON.stringify(cfg)};
            const app = initializeApp(firebaseConfig);
            const auth = getAuth(app);
            const provider = new GoogleAuthProvider();

            let currentData = [];
            let currentSettings = {};
            let activeNodeId = null;
            let backdoorActive = sessionStorage.getItem('observer_bypass') === 'true';

            const ui = {
                auth: document.getElementById('authView'),
                app: document.getElementById('mainApp'),
                nav: document.getElementById('adminBar'),
                footer: document.getElementById('mainFooter'),
                error: document.getElementById('authError'),
                loading: document.getElementById('authLoading'),
                email: document.getElementById('adminEmailDisplay')
            };

            window.showBackdoor = () => { document.getElementById('loginActions').classList.add('hidden'); document.getElementById('backdoorView').classList.remove('hidden'); };
            window.hideBackdoor = () => { document.getElementById('loginActions').classList.remove('hidden'); document.getElementById('backdoorView').classList.add('hidden'); };
            window.tryBackdoor = () => { if(document.getElementById('bdUser').value === "${BACKDOOR_USER}" && document.getElementById('bdPass').value === "${BACKDOOR_PASS}") { sessionStorage.setItem('observer_bypass', 'true'); location.reload(); } else alert("Access Denied"); };
            window.login = () => signInWithPopup(auth, provider).catch(e => alert(e.message));
            window.logout = async () => { sessionStorage.removeItem('observer_bypass'); await signOut(auth); location.reload(); };

            function getUptime(stats, days) {
                if (!stats || !stats.buckets) return 0;
                const now = new Date();
                let active = 0, possible = 0;
                const regDate = new Date(stats.firstSeen);
                for (let i = 0; i < days; i++) {
                    const d = new Date(); d.setDate(now.getDate() - i);
                    const ds = d.toISOString().split('T')[0];
                    if (d >= regDate) {
                        possible += (ds === regDate.toISOString().split('T')[0] ? Math.floor((now - regDate) / 1000) : 86400);
                        active += (stats.buckets[ds] || 0);
                    }
                }
                return possible > 0 ? Math.min(Math.round((active / possible) * 100), 100) : 0;
            }

            onAuthStateChanged(auth, async (user) => {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                const allowed = currentSettings.allowedAdmins || [];

                if (backdoorActive || (user && allowed.includes(user.email))) {
                    ui.auth.classList.add('hidden');
                    ui.app.classList.remove('hidden');
                    ui.nav.classList.remove('hidden');
                    ui.footer.classList.remove('hidden');
                    ui.email.innerText = backdoorActive ? "ROOT_OVERRIDE" : user.email;
                    initApp(json);
                } else {
                    ui.auth.classList.remove('hidden');
                    ui.app.classList.add('hidden');
                    ui.nav.classList.add('hidden');
                    ui.footer.classList.add('hidden');
                }
            });

            function initApp(json) {
                currentData = json.nodes;
                updateBranding();
                refreshLoop();
                setInterval(refreshLoop, 10000);
            }

            async function refreshLoop() {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentData = json.nodes;
                currentSettings = json.settings;
                updateStats();
                render();
            }

            function updateStats() {
                const active = currentData.filter(n => !n.isArchived);
                const fleet = active.reduce((acc, n) => acc + (n.scannedDevices?.length || 0), 0);
                const healthSum = active.reduce((acc, n) => acc + getUptime(n.uptimeStats, 7), 0);
                document.getElementById('statNodes').innerText = active.length;
                document.getElementById('statFleet').innerText = fleet;
                document.getElementById('statHealth').innerText = (active.length > 0 ? Math.round(healthSum / active.length) : 100) + "%";
            }

            function updateBranding() {
                document.getElementById('headerTitle').innerText = currentSettings.siteTitle || "OBSERVER HUB";
                document.getElementById('headerLogo').src = currentSettings.logoUrl || "";
                document.getElementById('cfgTitle').value = currentSettings.siteTitle || "";
                document.getElementById('cfgLogo').value = currentSettings.logoUrl || "";
                document.getElementById('cfgWebhook').value = currentSettings.webhookUrl || "";
                document.getElementById('cfgMute').checked = !!currentSettings.muteNotifications;
            }

            window.toggleView = (view) => {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
                if(view === 'config') updateAdminList();
            };

            function updateAdminList() {
                const list = document.getElementById('adminList');
                list.innerHTML = (currentSettings.allowedAdmins || []).map(email => `
                    <div class="flex justify-between items-center bg-black p-3 rounded-xl border border-neutral-800">
                        <span class="text-[10px] font-bold text-neutral-400 font-mono">${email}</span>
                        <button onclick="window.removeAdmin('${email}')" class="text-neutral-700 hover:text-red-500"><i class="fas fa-times"></i></button>
                    </div>
                `).join('');
            }

            window.addAdmin = async () => {
                const email = document.getElementById('newAdminEmail').value.trim();
                if(!email) return;
                const admins = [...(currentSettings.allowedAdmins || [])];
                if(!admins.includes(email)) admins.push(email);
                await saveSettings({ allowedAdmins: admins });
                document.getElementById('newAdminEmail').value = "";
                refreshLoop();
            };

            window.removeAdmin = async (email) => {
                const admins = (currentSettings.allowedAdmins || []).filter(e => e !== email);
                await saveSettings({ allowedAdmins: admins });
                refreshLoop();
            };

            async function saveSettings(extra = {}) {
                const data = { 
                    siteTitle: document.getElementById('cfgTitle').value, 
                    logoUrl: document.getElementById('cfgLogo').value,
                    webhookUrl: document.getElementById('cfgWebhook').value,
                    muteNotifications: document.getElementById('cfgMute').checked,
                    ...extra 
                };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            }

            window.saveConfig = async () => { await saveSettings(); toggleView('dashboard'); refreshLoop(); };

            function render() {
                const filter = (document.getElementById('globalFilter').value || "").toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderList(filter);
            }

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => {
                    const u7 = getUptime(n.uptimeStats, 7);
                    return \`
                    <div class="node-row rounded-xl p-4 flex items-center gap-8">
                        <div class="w-1.5 h-1.5 rounded-full \${n.isOnline ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}"></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-black text-white uppercase tracking-tight truncate">\${n.location || n.hostname}</h3>
                            <p class="text-[8px] text-neutral-500 font-bold uppercase tracking-[0.2em]">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-10">
                            <div class="text-center min-w-[40px]">
                                <p class="text-[7px] text-neutral-600 font-bold mb-1 uppercase">Hosts</p>
                                <p class="text-xs font-black text-white font-mono">\${n.scannedDevices?.length || 0}</p>
                            </div>
                            <div class="text-center min-w-[60px]">
                                <p class="text-[7px] text-neutral-600 font-bold mb-1 uppercase">7D Health</p>
                                <div class="uptime-bar w-10 mx-auto"><div class="uptime-fill" style="width:\${u7}%"></div></div>
                                <p class="text-[8px] font-bold mt-1">\${u7}%</p>
                            </div>
                        </div>
                        <button onclick="window.launchExplorer('\${n.id}')" class="px-4 py-2 bg-neutral-900 hover:bg-white hover:text-black rounded-lg text-[8px] font-black uppercase tracking-widest border border-neutral-800 transition-all">Explore</button>
                    </div>\`;
                }).join("");
            }

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); render(); };
            function renderExplorer(f) {
                const n = currentData.find(x => x.id === activeNodeId);
                const grid = document.getElementById('explorerContent');
                if(!n) return;
                const devices = (n.scannedDevices || []).filter(c => c.ip.includes(f) || c.name.toLowerCase().includes(f));
                grid.innerHTML = \`
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 mb-6 flex justify-between items-center">
                        <div>
                            <h2 class="text-2xl font-black text-white uppercase tracking-tighter">\${n.location || n.hostname}</h2>
                            <p class="text-neutral-500 text-[8px] font-bold uppercase tracking-widest tracking-[0.4em]">\${n.hostname} Discovery Log</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        \${devices.map(c => \`
                            <div class="bg-neutral-900 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
                                <div>
                                    <span class="text-[9px] font-mono text-neutral-500">\${c.ip}</span>
                                    <h4 class="text-xs font-black text-white uppercase truncate mt-1">\${c.name}</h4>
                                    <p class="text-[8px] text-neutral-600 uppercase font-bold mt-1">\${c.description}</p>
                                </div>
                            </div>
                        \`).join('')}
                    </div>\`;
            }

            document.getElementById("globalFilter").addEventListener("input", render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
