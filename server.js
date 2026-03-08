/**
 * Observer Central - Enterprise Infrastructure Hub v2.3.0
 * Features:
 * - Industrial Palette: Deep Greys with Safety Orange highlights
 * - Smart Thresholds: CPU, RAM, and Disk color-coding (75% Amber, 95% Red)
 * - Dynamic Sparklines: Trend lines now inherit color from performance status
 * - Explorer Overhaul: Metric cards with real-time threshold monitoring
 * - Unified Navigation: Persistent Home access and Admin utility bar
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Firebase SDKs
const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously, onAuthStateChanged } = require('firebase/auth');
const { getFirestore, doc, setDoc, getDoc, collection, getDocs, updateDoc, addDoc, query, limit } = require('firebase/firestore');

// --- CONFIGURATION ---
const VERSION = '2.3.0'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');

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

async function logAction(user, action, target) {
    if (!currentUser) return;
    try {
        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), {
            user: user || "System",
            action,
            target,
            timestamp: Date.now()
        });
    } catch (e) { console.error("Logging failed", e); }
}

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
                const existing = nodes.get(data.id) || { scannedDevices: [], metricsHistory: [] };
                
                let diskPercent = 0;
                if (data.disk && data.disk.includes('/')) {
                    const parts = data.disk.split('/').map(p => parseFloat(p));
                    if (parts.length === 2 && parts[1] > 0) diskPercent = Math.round(( (parts[1] - parts[0]) / parts[1]) * 100);
                }

                const metricsHistory = Array.isArray(existing.metricsHistory) ? existing.metricsHistory : [];
                metricsHistory.push({ cpu: data.cpu || 0, ram: data.ram || 0, disk: diskPercent, ts: Date.now() });
                if (metricsHistory.length > 24) metricsHistory.shift();

                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];
                (data.scannedDevices || []).forEach(newDev => {
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        const oldDev = mergedDevices[idx];
                        mergedDevices[idx] = { ...newDev, isImportant: !!oldDev.isImportant, lastSeen: Date.now() }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });

                const nodeUpdate = { ...existing, ...data, isArchived: false, uptimeStats, metricsHistory, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: req.socket.remoteAddress.replace('::ffff:', '') };
                nodes.set(data.id, nodeUpdate);
                if (currentUser) setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/log-audit' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const { user, action, target } = JSON.parse(body);
            await logAction(user, action, target);
            res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
        });
    }

    else if (url.pathname === '/api/update-settings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const data = JSON.parse(body);
            settings = { ...settings, ...data };
            if (currentUser) await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'), settings);
            res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
        });
    }

    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        let auditLogs = [];
        if (currentUser) {
            const logsSnap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), limit(15)));
            logsSnap.forEach(l => auditLogs.push(l.data()));
            auditLogs.sort((a,b) => b.timestamp - a.timestamp);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes: list, settings, auditLogs }));
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
        <title>Observer Central v${VERSION}</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #0a0a0a; color: #e5e5e5; }
            .node-row { background: #171717; border: 1px solid #262626; transition: all 0.2s ease; }
            .node-row:hover { border-color: #f97316; background: #1c1c1c; }
            .nav-blur { background: rgba(10, 10, 10, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid #262626; }
            .uptime-bar { height: 3px; border-radius: 2px; background: #262626; overflow: hidden; }
            .uptime-fill { height: 100%; background: #f97316; opacity: 0.8; }
            .hidden { display: none !important; }
            .sparkline { stroke: #404040; stroke-width: 1.5; fill: none; }
            .sparkline-active { stroke: #f97316; stroke-width: 1.5; fill: none; }
            .sparkline-lg { stroke-width: 2.5; fill: none; }
            input:focus { outline: none; border-color: #f97316 !important; }
            .card-metric { background: #171717; border: 1px solid #262626; transition: border-color 0.3s ease; }
            .btn-primary { background: #f97316; color: #000; }
            .btn-primary:hover { background: #fb923c; }
            .accent-orange { color: #f97316; }
            .border-orange { border-color: #f97316 !important; }
        </style>
    </head>
    <body class="min-h-screen flex flex-col antialiased">
        <div id="authView" class="fixed inset-0 z-[300] bg-[#0a0a0a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <i class="fas fa-eye text-[#f97316] text-5xl mb-6"></i>
                <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                <p class="text-neutral-500 text-[9px] font-bold uppercase tracking-[0.4em] mb-12">Security Operation Center</p>
                <div id="loginActions">
                    <button onclick="login()" class="btn-primary w-full flex items-center justify-center gap-3 py-4 rounded-xl font-bold mb-8 transition-transform active:scale-95">Authorize with Google</button>
                    <button onclick="showBackdoor()" class="text-[9px] text-neutral-600 font-bold uppercase tracking-widest hover:text-[#f97316]">Emergency Bypass</button>
                </div>
                <div id="backdoorView" class="hidden bg-neutral-900 border border-neutral-800 p-8 rounded-3xl">
                    <input type="text" id="bdUser" placeholder="ID" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-3">
                    <input type="password" id="bdPass" placeholder="Token" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-6">
                    <button onclick="tryBackdoor()" class="w-full py-3 btn-primary rounded-xl font-bold uppercase text-[10px] mb-4">Confirm</button>
                    <button onclick="hideBackdoor()" class="text-neutral-500 text-[9px] font-bold uppercase tracking-widest">Cancel</button>
                </div>
            </div>
        </div>

        <nav id="adminBar" class="hidden sticky top-0 z-[100] nav-blur px-6 py-3 flex items-center gap-8">
            <div class="flex items-center gap-3 min-w-max cursor-pointer" onclick="toggleView('dashboard')">
                <img id="headerLogo" src="" class="w-6 h-6 object-contain" alt="">
                <h1 id="headerTitle" class="text-sm font-black text-white uppercase"></h1>
            </div>
            <button onclick="toggleView('dashboard')" class="text-neutral-500 hover:text-[#f97316] transition-colors p-2"><i class="fas fa-home text-sm"></i></button>
            <div class="flex-1 max-w-xl relative">
                <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600 text-[10px]"></i>
                <input type="text" id="globalFilter" placeholder="Filter nodes..." class="w-full bg-neutral-900/50 border border-neutral-800 rounded-full pl-10 pr-4 py-1.5 text-xs text-neutral-300">
            </div>
            <div class="flex items-center gap-4 ml-auto">
                <button onclick="toggleView('config')" class="text-neutral-500 hover:text-[#f97316] transition-colors"><i class="fas fa-cog text-sm"></i></button>
                <div class="h-4 w-px bg-neutral-800"></div>
                <span id="adminEmailDisplay" class="text-[9px] font-bold text-neutral-500 uppercase truncate max-w-[120px]">...</span>
                <button onclick="logout()" class="text-neutral-500 hover:text-red-500 transition-colors"><i class="fas fa-sign-out-alt text-sm"></i></button>
            </div>
        </nav>

        <main id="mainApp" class="hidden flex-1 p-6 max-w-7xl mx-auto w-full text-left">
            <div id="dashboardView" class="view-section">
                <div class="flex flex-col gap-2" id="nodeList"></div>
            </div>
            <div id="explorerView" class="view-section hidden">
                <div id="explorerContent"></div>
            </div>
            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-[#f97316] font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 lg:col-span-2">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Identity & Alerts</h2>
                        <div class="space-y-4">
                            <input type="text" id="cfgTitle" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2 text-xs text-white" placeholder="Network Alias">
                            <input type="text" id="cfgLogo" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2 text-xs text-white" placeholder="Logo URL">
                            <input type="text" id="cfgWebhook" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2 text-xs text-white" placeholder="Webhook">
                            <button onclick="saveConfig()" class="w-full py-3 btn-primary rounded-lg font-black uppercase text-[10px]">Save Changes</button>
                        </div>
                    </div>
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Audit</h2>
                        <div id="auditLogList" class="space-y-1 text-[8px] font-mono text-neutral-400"></div>
                    </div>
                </div>
            </div>
        </main>

        <footer id="mainFooter" class="hidden px-6 py-4 border-t border-neutral-900 text-[8px] font-bold text-neutral-600 flex justify-between items-center bg-[#0a0a0a]">
            <div class="flex items-center gap-6">
                <span>&copy; 2026 OBSERVER INTELLIGENCE</span>
                <span class="text-neutral-800">|</span>
                <span>SYSTEM VERSION: v${VERSION}</span>
                <span class="text-neutral-800">|</span>
                <button onclick="toggleView('dashboard')" class="hover:text-white transition-colors">DASHBOARD</button>
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

            window.login = () => signInWithPopup(auth, provider).catch(e => alert(e.message));
            window.logout = async () => {
                sessionStorage.removeItem('observer_bypass');
                await signOut(auth);
                location.reload();
            };

            window.showBackdoor = () => { document.getElementById('loginActions').classList.add('hidden'); document.getElementById('backdoorView').classList.remove('hidden'); };
            window.hideBackdoor = () => { document.getElementById('loginActions').classList.remove('hidden'); document.getElementById('backdoorView').classList.add('hidden'); };
            window.tryBackdoor = () => { if(document.getElementById('bdUser').value === "${BACKDOOR_USER}" && document.getElementById('bdPass').value === "${BACKDOOR_PASS}") { sessionStorage.setItem('observer_bypass', 'true'); location.reload(); } else alert("Denied"); };

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

            function getStatusColor(val) {
                if (val >= 95) return '#ef4444'; // Red
                if (val >= 75) return '#f59e0b'; // Amber
                return '#f97316'; // Orange
            }

            function generateSparkline(history, key, w=50, h=20, cls='sparkline') {
                if (!history || history.length < 2) return \`<svg width="\${w}" height="\${h}"></svg>\`;
                const latestVal = history[history.length-1][key];
                const color = getStatusColor(latestVal);
                const points = history.map((p, i) => \`\${(i * (w / 23))},\${h - (p[key] / 100 * h)}\`).join(' ');
                return \`<svg width="\${w}" height="\${h}" class="\${cls}" style="stroke: \${color}"><polyline points="\${points}"/></svg>\`;
            }

            onAuthStateChanged(auth, async (user) => {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                if (backdoorActive || (user && currentSettings.allowedAdmins?.includes(user.email))) {
                    document.getElementById('authView').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    document.getElementById('adminBar').classList.remove('hidden');
                    document.getElementById('mainFooter').classList.remove('hidden');
                    document.getElementById('adminEmailDisplay').innerText = backdoorActive ? "ROOT_BYPASS" : user.email;
                    initApp(json);
                }
            });

            function initApp(json) {
                currentData = json.nodes;
                updateBranding();
                setInterval(async () => {
                    const r = await fetch('/api/status');
                    const j = await r.json();
                    currentData = j.nodes;
                    currentSettings = j.settings;
                    render();
                    if(j.auditLogs) renderAuditLogs(j.auditLogs);
                }, 10000);
                render();
            }

            function renderAuditLogs(logs) {
                const list = document.getElementById('auditLogList');
                if (!list) return;
                list.innerHTML = logs.map(l => \`<div>[\${new Date(l.timestamp).toLocaleTimeString()}] \${l.action} // \${l.target}</div>\`).join('');
            }

            function updateBranding() {
                document.getElementById('headerTitle').innerText = currentSettings.siteTitle || "HUB";
                document.getElementById('headerLogo').src = currentSettings.logoUrl || "";
            }

            window.toggleView = (view) => {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
                activeNodeId = (view === 'dashboard') ? null : activeNodeId;
            };

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => \`
                    <div class="node-row rounded-xl p-4 flex items-center gap-6 text-left">
                        <div class="w-1.5 h-1.5 rounded-full \${n.isOnline ? 'bg-emerald-500' : 'bg-red-500'}"></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-black text-white uppercase">\${n.location || n.hostname}</h3>
                            <p class="text-[8px] text-neutral-500 uppercase">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-6">
                            \${generateSparkline(n.metricsHistory, 'cpu')}
                            <div class="text-center min-w-[40px]">
                                <p class="text-[7px] text-neutral-600 uppercase">7D Health</p>
                                <p class="text-[9px] font-black accent-orange">\${getUptime(n.uptimeStats, 7)}%</p>
                            </div>
                        </div>
                        <button onclick="window.launchExplorer('\${n.id}')" class="px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-[8px] font-black uppercase hover:border-orange transition-colors">Explore</button>
                    </div>\`).join("");
            }

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); renderExplorer(); };

            function renderExplorer() {
                const n = currentData.find(x => x.id === activeNodeId);
                const grid = document.getElementById('explorerContent');
                if(!n) return;

                const latestMetric = n.metricsHistory?.[n.metricsHistory.length - 1] || { cpu: 0, ram: 0, disk: 0 };
                
                const cpuColor = getStatusColor(latestMetric.cpu);
                const ramColor = getStatusColor(latestMetric.ram);
                const diskColor = getStatusColor(latestMetric.disk);

                grid.innerHTML = \`
                    <button onclick="window.toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-[#f97316] font-bold text-[10px] uppercase tracking-widest transition-colors"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                    
                    <div class="mb-10 text-left">
                        <h2 class="text-3xl font-black text-white uppercase tracking-tighter mb-1">\${n.location || n.hostname}</h2>
                        <p class="text-neutral-500 text-[10px] font-bold uppercase tracking-widest">\${n.hostname} // Intelligent Telemetry Engine</p>
                    </div>

                    <!-- Metrics Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden \${latestMetric.cpu >= 75 ? 'border-orange' : ''}">
                            <div class="flex justify-between items-start mb-6">
                                <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">CPU Utilization</span>
                                <span class="text-3xl font-black" style="color: \${cpuColor}">\${latestMetric.cpu}%</span>
                            </div>
                            <div class="mt-4">\${generateSparkline(n.metricsHistory, 'cpu', 300, 60, 'sparkline-lg')}</div>
                        </div>
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden \${latestMetric.ram >= 75 ? 'border-orange' : ''}">
                            <div class="flex justify-between items-start mb-6">
                                <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">Memory Load</span>
                                <span class="text-3xl font-black" style="color: \${ramColor}">\${latestMetric.ram}%</span>
                            </div>
                            <div class="mt-4">\${generateSparkline(n.metricsHistory, 'ram', 300, 60, 'sparkline-lg')}</div>
                        </div>
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden \${latestMetric.disk >= 75 ? 'border-orange' : ''}">
                            <div class="flex justify-between items-start mb-6">
                                <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">Storage Saturation</span>
                                <span class="text-3xl font-black" style="color: \${diskColor}">\${latestMetric.disk}%</span>
                            </div>
                            <div class="mt-6">
                                <div class="text-[10px] font-bold text-neutral-400 mb-2 uppercase tracking-tighter">\${n.disk || 'N/A'}</div>
                                <div class="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                                    <div class="h-full opacity-80" style="width: \${latestMetric.disk}%; background-color: \${diskColor}"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Discovery Grid -->
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 mb-4">
                        <h3 class="text-xs font-black text-white uppercase mb-6 tracking-widest">Network Asset Map</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            \${(n.scannedDevices || []).map(c => \`
                                <div class="bg-black border border-neutral-800 p-4 rounded-xl hover:border-orange transition-colors">
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-[9px] font-mono text-neutral-500 font-bold">\${c.ip}</span>
                                        \${c.os_fingerprint ? '<span class="text-[7px] text-neutral-400 font-black uppercase">' + c.os_fingerprint + '</span>' : ''}
                                    </div>
                                    <h4 class="text-xs font-black text-white uppercase truncate mt-1">\${c.name}</h4>
                                    <p class="text-[8px] text-neutral-600 uppercase font-bold mt-1">\${c.description}</p>
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \`;
            }

            function render() {
                const filter = (document.getElementById('globalFilter').value || "").toLowerCase();
                if (activeNodeId) renderExplorer();
                else renderList(filter);
            }

            document.getElementById("globalFilter").addEventListener("input", render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
