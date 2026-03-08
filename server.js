/**
 * Observer Central - Enterprise Infrastructure Hub v1.9.4
 * Features:
 * - Telemetrics Engine: Tracks active seconds per node using daily buckets
 * - Availability Metrics: 7-day, 30-day, and 365-day uptime percentages
 * - Network Health Index: Real-time global availability average
 * - Persistent Analytics: Uptime data stored in Firestore
 * - High-Density UI: Condensed list view with health sparklines
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
const VERSION = '1.9.4'; 
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
    allowedAdmins: [] 
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

/**
 * Uptime Telemetry Processor
 * Increments active seconds for the current date bucket
 */
function processUptime(nodeId, data) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const existing = nodes.get(nodeId) || {};
    
    let uptimeStats = existing.uptimeStats || { 
        firstSeen: now,
        buckets: {} 
    };

    // Initialize today's bucket if it doesn't exist
    if (!uptimeStats.buckets[today]) uptimeStats.buckets[today] = 0;

    const lastSeen = existing.lastSeen || now;
    const deltaSeconds = Math.floor((now - lastSeen) / 1000);

    // If the node has been seen recently (within 2x threshold), credit the uptime
    if (deltaSeconds > 0 && deltaSeconds < (OFFLINE_THRESHOLD * 2 / 1000)) {
        uptimeStats.buckets[today] += deltaSeconds;
    }

    // Prune buckets older than 366 days to save space
    const dates = Object.keys(uptimeStats.buckets).sort();
    if (dates.length > 366) {
        delete uptimeStats.buckets[dates[0]];
    }

    return uptimeStats;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            name: settings.siteTitle, short_name: "Observer", start_url: "/", display: "standalone",
            background_color: "#0f172a", theme_color: "#3b82f6",
            icons: [{ src: settings.logoUrl, sizes: "512x512", type: "image/png" }]
        }));
    }

    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!data.id) throw new Error("Missing ID");

                const uptimeStats = processUptime(data.id, data);
                const existing = nodes.get(data.id) || { scannedDevices: [], isArchived: false };
                const currentScans = data.scannedDevices || [];
                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];

                currentScans.forEach(newDev => {
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        const oldDev = mergedDevices[idx];
                        mergedDevices[idx] = { ...newDev, isImportant: !!oldDev.isImportant, firstSeen: oldDev.firstSeen || Date.now(), lastSeen: Date.now() }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });

                const nodeUpdate = { 
                    ...existing, 
                    ...data, 
                    isArchived: false, 
                    uptimeStats,
                    scannedDevices: mergedDevices, 
                    lastSeen: Date.now(), 
                    ip: req.socket.remoteAddress.replace('::ffff:', '') 
                };

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
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <link rel="manifest" href="/manifest.json">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #0f172a; }
            .node-row { background: #1e293b; border: 1px solid #334155; transition: all 0.2s ease; }
            .node-row:hover { border-color: #475569; transform: translateX(4px); }
            .btn-google { background: #fff; color: #1f2937; transition: all 0.2s; }
            .btn-google:hover { background: #f3f4f6; transform: translateY(-1px); }
            .hidden { display: none !important; }
            .uptime-bar { height: 4px; border-radius: 2px; background: #334155; overflow: hidden; }
            .uptime-fill { height: 100%; background: #10b981; transition: width 1s ease; }
        </style>
    </head>
    <body class="text-slate-200 min-h-screen antialiased">
        <div id="authView" class="fixed inset-0 z-[100] bg-[#0f172a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <div class="mb-10">
                    <div class="w-20 h-20 bg-blue-600/10 rounded-3xl flex items-center justify-center mx-auto mb-6 border border-blue-600/20">
                        <i class="fas fa-satellite-dish text-blue-500 text-3xl"></i>
                    </div>
                    <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                    <p class="text-slate-500 text-xs font-bold uppercase tracking-widest">Enterprise Telemetry Hub</p>
                </div>
                <div id="loginActions">
                    <button onclick="login()" class="btn-google w-full flex items-center justify-center gap-3 py-4 rounded-2xl font-bold shadow-2xl mb-6">
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" class="w-5 h-5">
                        Sign in with Google
                    </button>
                    <button onclick="showBackdoor()" class="text-[10px] text-slate-600 font-bold uppercase tracking-widest hover:text-blue-500 transition-colors">Emergency Access</button>
                    <p id="authError" class="mt-6 text-red-400 text-xs font-bold uppercase hidden">Access Denied</p>
                </div>
                <div id="backdoorView" class="hidden bg-slate-800 border border-slate-700 p-8 rounded-3xl shadow-2xl">
                    <h2 class="text-lg font-black text-white mb-6 uppercase">System Bypass</h2>
                    <input type="text" id="bdUser" placeholder="Username" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white mb-3 outline-none focus:ring-2 focus:ring-blue-500">
                    <input type="password" id="bdPass" placeholder="Password" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white mb-6 outline-none focus:ring-2 focus:ring-blue-500">
                    <button onclick="tryBackdoor()" class="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold uppercase tracking-widest text-[10px] mb-4">Authorize</button>
                    <button onclick="hideBackdoor()" class="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Cancel</button>
                </div>
                <div id="authLoading" class="hidden"><i class="fas fa-circle-notch fa-spin text-blue-500 text-2xl"></i></div>
            </div>
        </div>

        <div id="adminBar" class="hidden sticky top-0 z-50 bg-slate-900/90 backdrop-blur border-b border-slate-800 px-6 py-2.5 flex justify-between items-center">
            <div class="flex items-center gap-3">
                <span id="adminStatusDot" class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"></span>
                <span id="adminEmailDisplay" class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Admin: Loading...</span>
            </div>
            <button onclick="logout()" class="flex items-center gap-2 px-3 py-1 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all">Logout</button>
        </div>

        <div id="mainApp" class="hidden p-4 md:p-6 max-w-7xl mx-auto text-left">
            <header class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-6">
                <div class="flex items-center gap-4">
                    <img id="headerLogo" src="" class="w-10 h-10 object-contain" alt="Logo">
                    <div>
                        <h1 id="headerTitle" class="text-2xl font-black text-white tracking-tighter uppercase"></h1>
                        <p class="text-slate-500 text-[9px] font-bold uppercase tracking-[0.2em]">Infrastructure Intelligence</p>
                    </div>
                </div>
                
                <div class="flex items-center gap-4 bg-slate-900/50 p-3 rounded-2xl border border-slate-800">
                    <div class="text-center px-4 border-r border-slate-800">
                        <p class="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Health Index</p>
                        <p id="statHealth" class="text-lg font-black text-emerald-400">-%</p>
                    </div>
                    <div class="text-center px-4 border-r border-slate-800">
                        <p class="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Fleet</p>
                        <p id="statFleet" class="text-lg font-black text-blue-400">-</p>
                    </div>
                    <div class="text-center px-4">
                        <p class="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1 text-amber-500">Priority</p>
                        <p id="statPriority" class="text-lg font-black text-amber-500">-</p>
                    </div>
                </div>

                <div class="flex items-center gap-3">
                    <button onclick="toggleView('config')" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all"><i class="fas fa-cog"></i></button>
                    <input type="text" id="globalFilter" placeholder="Search..." class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px]">
                </div>
            </header>

            <div id="dashboardView" class="view-section">
                <div class="flex flex-col gap-3" id="nodeList"></div>
            </div>

            <div id="explorerView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-slate-400 hover:text-white font-bold text-xs uppercase tracking-widest"><i class="fas fa-chevron-left mr-2"></i> Dashboard</button>
                <div id="explorerContent"></div>
            </div>

            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-slate-400 hover:text-white font-bold text-xs uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Back</button>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-8">
                        <h2 class="text-xl font-black text-white mb-6 uppercase">System Settings</h2>
                        <div class="space-y-5">
                            <input type="text" id="cfgTitle" placeholder="Network Name" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white">
                            <input type="text" id="cfgLogo" placeholder="Logo URL" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white">
                            <button onclick="saveConfig()" class="w-full py-4 bg-blue-600 text-white rounded-xl font-bold uppercase text-[10px]">Save Changes</button>
                        </div>
                    </div>
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-8">
                        <h2 class="text-xl font-black text-white mb-6 uppercase">Authorized Admins</h2>
                        <div class="flex gap-2 mb-4">
                            <input type="email" id="newAdminEmail" class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white outline-none">
                            <button onclick="addAdmin()" class="bg-blue-600 px-4 rounded-xl text-white"><i class="fas fa-plus"></i></button>
                        </div>
                        <div id="adminList" class="space-y-2"></div>
                    </div>
                </div>
            </div>
        </div>

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

            const authView = document.getElementById('authView');
            const mainApp = document.getElementById('mainApp');
            const adminBar = document.getElementById('adminBar');
            const adminEmailDisplay = document.getElementById('adminEmailDisplay');

            window.showBackdoor = () => { document.getElementById('loginActions').classList.add('hidden'); document.getElementById('backdoorView').classList.remove('hidden'); };
            window.hideBackdoor = () => { document.getElementById('loginActions').classList.remove('hidden'); document.getElementById('backdoorView').classList.add('hidden'); };
            window.tryBackdoor = () => { if (document.getElementById('bdUser').value === "${BACKDOOR_USER}" && document.getElementById('bdPass').value === "${BACKDOOR_PASS}") { sessionStorage.setItem('observer_bypass', 'true'); location.reload(); } else alert("Denied"); };
            window.login = () => signInWithPopup(auth, provider).catch(e => alert(e.message));
            window.logout = async () => { sessionStorage.removeItem('observer_bypass'); await signOut(auth); location.reload(); };

            function calculateUptime(stats, days) {
                if (!stats || !stats.buckets) return 0;
                const now = new Date();
                let activeSecs = 0;
                let totalPossibleSecs = 0;

                for (let i = 0; i < days; i++) {
                    const date = new Date();
                    date.setDate(now.getDate() - i);
                    const dateStr = date.toISOString().split('T')[0];
                    
                    // Total seconds in a day is 86400
                    // If the node was registered today, limit the totalPossible to time since registration
                    const regDate = new Date(stats.firstSeen);
                    const isRegDay = dateStr === regDate.toISOString().split('T')[0];
                    
                    if (date >= regDate) {
                        const dayPossible = isRegDay ? Math.floor((now - regDate) / 1000) : 86400;
                        totalPossibleSecs += Math.min(dayPossible, 86400);
                        activeSecs += (stats.buckets[dateStr] || 0);
                    }
                }
                return totalPossibleSecs > 0 ? Math.min(Math.round((activeSecs / totalPossibleSecs) * 100), 100) : 0;
            }

            onAuthStateChanged(auth, async (user) => {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                const allowed = currentSettings.allowedAdmins || [];

                if (backdoorActive || (user && allowed.includes(user.email))) {
                    authView.classList.add('hidden');
                    mainApp.classList.remove('hidden');
                    adminBar.classList.remove('hidden');
                    adminEmailDisplay.innerText = backdoorActive ? "Emergency: Root Access" : "Admin: " + user.email;
                    initApp(json);
                } else {
                    authView.classList.remove('hidden');
                    mainApp.classList.add('hidden');
                    adminBar.classList.add('hidden');
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
                updateStats();
                render();
            }

            function updateStats() {
                const active = currentData.filter(n => !n.isArchived);
                const fleet = active.reduce((acc, n) => acc + (n.scannedDevices?.length || 0), 0);
                const priority = active.reduce((acc, n) => acc + (n.scannedDevices?.filter(d => d.isImportant).length || 0), 0);
                
                // Calculate network health (Average of 7d uptime across nodes)
                const healthSum = active.reduce((acc, n) => acc + calculateUptime(n.uptimeStats, 7), 0);
                const health = active.length > 0 ? Math.round(healthSum / active.length) : 100;

                document.getElementById('statHealth').innerText = health + "%";
                document.getElementById('statFleet').innerText = fleet;
                document.getElementById('statPriority').innerText = priority;
            }

            function render() {
                const filter = (document.getElementById('globalFilter')?.value || "").toLowerCase();
                const list = document.getElementById('nodeList');
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => {
                    const u7 = calculateUptime(n.uptimeStats, 7);
                    const u30 = calculateUptime(n.uptimeStats, 30);
                    const u365 = calculateUptime(n.uptimeStats, 365);
                    const statusColor = n.isOnline ? 'bg-emerald-500' : 'bg-red-500';

                    return \`
                    <div class="node-row rounded-2xl p-4 flex flex-col md:flex-row items-center gap-6">
                        <div class="flex items-center gap-4 min-w-[120px]">
                            <div class="w-3 h-3 rounded-full \${statusColor}"></div>
                            <span class="text-[9px] font-black uppercase tracking-widest \${n.isOnline ? 'text-emerald-400' : 'text-red-400'}">\${n.isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-xl font-black text-white uppercase tracking-tighter truncate">\${n.location || n.hostname}</h3>
                            <p class="text-[9px] text-slate-500 font-bold uppercase tracking-widest truncate opacity-80">\${n.hostname} // \${n.ip || '0.0.0.0'}</p>
                        </div>
                        
                        <!-- Availability Engine -->
                        <div class="flex items-center gap-6 min-w-[200px]">
                            <div class="text-center">
                                <p class="text-[7px] text-slate-500 font-black uppercase mb-1">7 Day</p>
                                <div class="uptime-bar w-10"><div class="uptime-fill" style="width: \${u7}%"></div></div>
                                <p class="text-[9px] font-bold mt-1">\${u7}%</p>
                            </div>
                            <div class="text-center">
                                <p class="text-[7px] text-slate-500 font-black uppercase mb-1">30 Day</p>
                                <div class="uptime-bar w-10"><div class="uptime-fill" style="width: \${u30}%"></div></div>
                                <p class="text-[9px] font-bold mt-1">\${u30}%</p>
                            </div>
                            <div class="text-center">
                                <p class="text-[7px] text-slate-500 font-black uppercase mb-1">Year</p>
                                <div class="uptime-bar w-10"><div class="uptime-fill" style="width: \${u365}%"></div></div>
                                <p class="text-[9px] font-bold mt-1">\${u365}%</p>
                            </div>
                        </div>

                        <div class="flex items-center gap-2">
                            <button onclick="window.launchExplorer('\${n.id}')" class="px-5 py-2 bg-slate-800 hover:bg-blue-600 text-white rounded-xl font-black text-[9px] uppercase tracking-widest transition-all">Explore</button>
                        </div>
                    </div>\`;
                }).join("");
            }

            // Window Exports & Boilerplate
            window.launchExplorer = (id) => { activeNodeId = id; document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden')); document.getElementById('explorerView').classList.remove('hidden'); renderExplorer(); };
            window.toggleView = (view) => { document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden')); document.getElementById(view + 'View').classList.remove('hidden'); };
            function renderExplorer() {
                const node = currentData.find(n => n.id === activeNodeId);
                const grid = document.getElementById('explorerContent');
                if (!node) return;
                grid.innerHTML = \`<div class="bg-slate-800 border border-slate-700 rounded-3xl p-8 mb-6"><h2 class="text-3xl font-black text-white uppercase tracking-tighter">\${node.location || node.hostname}</h2></div>\`;
                // Discovery list rendering logic here...
            }
            function updateBranding() { document.getElementById('headerTitle').innerText = currentSettings.siteTitle || "OBSERVER HUB"; document.getElementById('headerLogo').src = currentSettings.logoUrl || ""; }
            async function saveConfig() { const data = { siteTitle: document.getElementById('cfgTitle').value, logoUrl: document.getElementById('cfgLogo').value }; await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }); location.reload(); }
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));

