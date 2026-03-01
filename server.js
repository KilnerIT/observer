/**
 * Observer Central - Enterprise Infrastructure Hub v1.8.2
 * Features:
 * - Google Chat Webhook Integration: Instant alerts for Node Up/Down events
 * - High-Density List View: Optimized for large fleets
 * - Global Stats Bar: Total Nodes, Total Clients, and Priority Asset counts
 * - Site-Centric Labeling: Prioritizes Location/Site titles
 * - Firebase Persistent Settings & Storage
 */

const http = require('http');
const https = require('https'); // Required for outgoing Webhook calls
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Firebase SDKs
const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously, onAuthStateChanged } = require('firebase/auth');
const { getFirestore, doc, setDoc, getDoc, collection, getDocs, updateDoc } = require('firebase/firestore');

// --- CONFIGURATION ---
const VERSION = '1.8.2'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
const DASHBOARD_URL = 'https://observer-sxv0.onrender.com';
const GCHAT_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAQA6gvsbXw/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=u5n0S4cRM8UoDk27DUgUATSUxnazlIMangV1S1_AJZ8';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'REPLACE_WITH_YOUR_ACTUAL_FIREBASE_PUBLIC_VAPID_KEY';

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
} else if (fs.existsSync(path.join(__dirname, 'config.json'))) {
    try {
        firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    } catch(e) { console.error("Config parse failed"); }
}

const appId = typeof __app_id !== 'undefined' ? __app_id : (process.env.OBSERVER_APP_ID || 'observer-prod');
const app = initializeApp(firebaseConfig || { apiKey: "none" });
const auth = getAuth(app);
const db = getFirestore(app);

const nodes = new Map();
const nodeStates = new Map(); // Track status in-memory to detect transitions
let settings = { siteTitle: "OBSERVER HUB", logoUrl: "https://cdn-icons-png.flaticon.com/512/564/564348.png" };
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated. Loading persistence for ${appId}...`);
        try {
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => {
                const data = d.data();
                nodes.set(d.id, data);
                // Initialize state tracker
                nodeStates.set(d.id, (Date.now() - (data.lastSeen || 0)) < OFFLINE_THRESHOLD);
            });
            const setDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'settings', 'config'));
            if (setDocRef.exists()) settings = { ...settings, ...setDocRef.data() };
        } catch(e) { console.error("Recovery failed:", e.message); }
    }
});

/**
 * Google Chat Alert Dispatcher
 * Sends a structured card message to Google Chat via Webhook
 */
function sendGoogleChatAlert(node, isOnline) {
    const statusText = isOnline ? "ONLINE (Recovered)" : "OFFLINE (Unreachable)";
    const statusColor = isOnline ? "#22c55e" : "#ef4444";
    const siteName = node.location || node.hostname || "Unknown Site";

    const payload = JSON.stringify({
        cards: [{
            header: {
                title: "Observer Central Alert",
                subtitle: "Infrastructure Health Monitor",
                imageUrl: settings.logoUrl
            },
            sections: [{
                widgets: [
                    { "textParagraph": { "text": `<b>Site:</b> ${siteName}<br><b>Host:</b> ${node.hostname}<br><b>Status:</b> <font color="${statusColor}">${statusText}</font>` } },
                    {
                        "buttons": [{
                            "textButton": {
                                "text": "VIEW DASHBOARD",
                                "onClick": { "openLink": { "url": DASHBOARD_URL } }
                            }
                        }]
                    }
                ]
            }]
        }]
    });

    const url = new URL(GCHAT_WEBHOOK);
    const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options);
    req.on('error', (e) => console.error(`[WEBHOOK ERROR] ${e.message}`));
    req.write(payload);
    req.end();
}

/**
 * Health Monitor Loop
 * Checks node heartbeats every 10 seconds to detect state changes
 */
setInterval(() => {
    nodes.forEach((node, id) => {
        const isOnline = (Date.now() - (node.lastSeen || 0)) < OFFLINE_THRESHOLD;
        const previousState = nodeStates.get(id);

        // State Transition Detection (Online -> Offline OR Offline -> Online)
        if (previousState !== undefined && previousState !== isOnline) {
            console.log(`[ALERT] Node ${node.hostname} transitioned to ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
            sendGoogleChatAlert(node, isOnline);
        }
        
        nodeStates.set(id, isOnline);
    });
}, 10000);

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(`self.addEventListener('push', e => {
            let d = { title: "Observer Alert", body: "Change detected" };
            try { d = e.data.json(); } catch(err) {}
            e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: "${settings.logoUrl}" }));
        });`);
    }

    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!data.id) throw new Error("Missing ID");
                const existing = nodes.get(data.id) || { scannedDevices: [], isArchived: false };
                const currentScans = Array.isArray(data.scannedDevices) ? data.scannedDevices : [];
                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];

                currentScans.forEach(newDev => {
                    if (!newDev || !newDev.ip) return;
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        const oldDev = mergedDevices[idx];
                        mergedDevices[idx] = { ...newDev, isImportant: !!oldDev.isImportant, firstSeen: oldDev.firstSeen || Date.now(), lastSeen: Date.now() }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });

                const nodeUpdate = { ...existing, ...data, isArchived: false, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: req.socket.remoteAddress.replace('::ffff:', '') };
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
            const data = JSON.parse(body);
            settings = { ...settings, ...data };
            if (currentUser) setDoc(doc(db, 'artifacts', appId, 'public', 'settings', 'config'), settings);
            res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
        });
    }

    else if (url.pathname === '/api/archive-node' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const { nodeId, archive } = JSON.parse(body);
            const node = nodes.get(nodeId);
            if (node) {
                node.isArchived = !!archive;
                nodes.set(nodeId, node);
                if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { isArchived: !!archive });
            }
            res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
        });
    }

    else if (url.pathname === '/api/toggle-important' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const { nodeId, clientIp } = JSON.parse(body);
            const node = nodes.get(nodeId);
            if (node) {
                const device = node.scannedDevices.find(d => d.ip === clientIp);
                if (device) {
                    device.isImportant = !device.isImportant;
                    if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { scannedDevices: node.scannedDevices });
                }
            }
            res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
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
        res.end(generateUI());
    }
});

function generateUI() {
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
            .node-row:hover { border-color: #475569; background: #1e293b; transform: translateX(4px); }
            .important-glow { border-color: #fbbf24 !important; box-shadow: 0 0 15px rgba(251, 191, 36, 0.1); }
            ::-webkit-scrollbar { width: 8px; }
            ::-webkit-scrollbar-track { background: #0f172a; }
            ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        </style>
    </head>
    <body class="text-slate-200 min-h-screen antialiased">
        <div id="app" class="p-4 md:p-6 max-w-7xl mx-auto">
            <header class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-6">
                <div class="flex items-center gap-4">
                    <img id="headerLogo" src="" class="w-10 h-10 object-contain" alt="Logo">
                    <div>
                        <h1 id="headerTitle" class="text-2xl font-black text-white tracking-tighter uppercase"></h1>
                        <p class="text-slate-500 text-[9px] font-bold uppercase tracking-[0.2em]">Global Intelligence Network</p>
                    </div>
                </div>
                
                <div class="flex items-center gap-6 bg-slate-900/50 p-3 rounded-2xl border border-slate-800">
                    <div class="text-center px-4 border-r border-slate-800">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Nodes</p>
                        <p id="statNodes" class="text-lg font-black text-white">-</p>
                    </div>
                    <div class="text-center px-4 border-r border-slate-800">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Fleet</p>
                        <p id="statFleet" class="text-lg font-black text-blue-400">-</p>
                    </div>
                    <div class="text-center px-4">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest text-amber-500">Priority</p>
                        <p id="statPriority" class="text-lg font-black text-amber-500">-</p>
                    </div>
                </div>

                <div class="flex items-center gap-3 w-full lg:w-auto">
                    <button onclick="toggleView('config')" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all" title="Settings">
                        <i class="fas fa-cog"></i>
                    </button>
                    <button id="viewArchiveBtn" onclick="toggleArchiveView()" class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700">
                        <i class="fas fa-archive"></i>
                    </button>
                    <button onclick="initPush()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-blue-500/20">
                        <i class="fas fa-bell"></i>
                    </button>
                    <input type="text" id="globalFilter" placeholder="Search Fleet..." class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]">
                </div>
            </header>

            <!-- Main Dashboard -->
            <div id="mainView" class="view-section">
                <div class="flex flex-col gap-3" id="nodeList"></div>
            </div>

            <!-- Discovery Explorer -->
            <div id="explorerView" class="view-section hidden">
                <div class="flex justify-between items-center mb-6 bg-slate-800/50 p-4 rounded-2xl border border-slate-800">
                    <button onclick="toggleView('main')" class="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-xs uppercase tracking-widest">
                        <i class="fas fa-chevron-left text-[10px]"></i> Fleet Dashboard
                    </button>
                    <label class="flex items-center gap-2 text-[10px] font-black text-slate-500 cursor-pointer uppercase tracking-widest">
                        <input type="checkbox" id="showOnlyImportant" class="rounded border-slate-800 bg-slate-900 text-amber-500 focus:ring-amber-500">
                        Show Priority Only
                    </label>
                </div>
                <div id="explorerContent"></div>
            </div>

            <!-- Config View -->
            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('main')" class="mb-6 text-slate-400 hover:text-white font-bold text-xs uppercase tracking-widest">
                    <i class="fas fa-arrow-left mr-2"></i> Back
                </button>
                <div class="max-w-xl bg-slate-800 border border-slate-700 rounded-3xl p-8 shadow-2xl">
                    <h2 class="text-xl font-black text-white mb-6 uppercase">System Preferences</h2>
                    <div class="space-y-5">
                        <div>
                            <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Network Name</label>
                            <input type="text" id="cfgTitle" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Interface Logo URL</label>
                            <input type="text" id="cfgLogo" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:ring-2 focus:ring-blue-500">
                        </div>
                        <button onclick="saveConfig()" class="w-full py-3.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all uppercase tracking-widest text-[10px] mt-2">
                            Update Environment
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let currentData = [];
            let currentSettings = {};
            let activeNodeId = null;
            let showArchived = false;
            const VAPID_KEY = "${VAPID_PUBLIC_KEY}";

            function urlBase64ToUint8Array(s) { const p = '='.repeat((4-s.length%4)%4); const b = (s+p).replace(/-/g,'+').replace(/_/g,'/'); const r = window.atob(b); const o = new Uint8Array(r.length); for(let i=0; i<r.length; ++i){ o[i]=r.charCodeAt(i); } return o; }
            if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

            async function initPush() {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_KEY) });
                    await fetch('/api/register-token', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ subscription: sub }) });
                    alert("System Alerts Activated.");
                } catch (e) { console.error(e); }
            }

            async function fetchData() {
                try {
                    const res = await fetch('/api/status');
                    const json = await res.json();
                    currentData = json.nodes;
                    currentSettings = json.settings;
                    updateDashboardStats();
                    updateBranding();
                    render();
                } catch (e) {}
            }

            function updateDashboardStats() {
                const totalNodes = currentData.filter(n => !n.isArchived).length;
                const totalFleet = currentData.filter(n => !n.isArchived).reduce((acc, n) => acc + (n.scannedDevices?.length || 0), 0);
                const totalPriority = currentData.filter(n => !n.isArchived).reduce((acc, n) => acc + (n.scannedDevices?.filter(d => d.isImportant).length || 0), 0);
                
                document.getElementById('statNodes').innerText = totalNodes;
                document.getElementById('statFleet').innerText = totalFleet;
                document.getElementById('statPriority').innerText = totalPriority;
            }

            function updateBranding() {
                document.getElementById('headerTitle').innerText = currentSettings.siteTitle;
                document.getElementById('headerLogo').src = currentSettings.logoUrl;
                document.getElementById('cfgTitle').value = currentSettings.siteTitle;
                document.getElementById('cfgLogo').value = currentSettings.logoUrl;
            }

            async function saveConfig() {
                const data = { siteTitle: document.getElementById('cfgTitle').value, logoUrl: document.getElementById('cfgLogo').value };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
                fetchData();
                toggleView('main');
            }

            function toggleView(view) {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
                activeNodeId = (view === 'main' || view === 'config') ? null : activeNodeId;
            }

            function toggleArchiveView() {
                showArchived = !showArchived;
                document.getElementById('viewArchiveBtn').classList.toggle('bg-blue-500/10');
                render();
            }

            function render() {
                const filter = (document.getElementById('globalFilter')?.value || "").toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderList(filter);
            }

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                if(!list) return;
                const filtered = currentData.filter(n => {
                    const match = (n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter);
                    return match && (!!n.isArchived === showArchived);
                }).sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                if (filtered.length === 0) {
                    list.innerHTML = \`<div class="py-12 text-center text-slate-600 italic border border-dashed border-slate-800 rounded-3xl">No \${showArchived ? 'archived' : 'active'} telemetry units reporting.</div>\`;
                    return;
                }

                list.innerHTML = filtered.map(n => {
                    const statusColor = n.isOnline ? 'bg-emerald-500' : 'bg-red-500';
                    const priorityCount = (n.scannedDevices || []).filter(d => d.isImportant).length;
                    const siteName = n.location || n.hostname || 'Undefined Site';
                    const hostLabel = n.location ? n.hostname : 'System Agent';
                    
                    return \`
                    <div class="node-row rounded-2xl p-4 flex flex-col md:flex-row items-center gap-6">
                        <!-- Status Pillar -->
                        <div class="flex items-center gap-4 min-w-[140px]">
                            <div class="w-3 h-3 rounded-full \${statusColor} shadow-[0_0_10px_rgba(0,0,0,0.5)]"></div>
                            <span class="text-[10px] font-black uppercase tracking-widest \${n.isOnline ? 'text-emerald-400' : 'text-red-400'}">
                                \${n.isOnline ? 'Active' : 'Offline'}
                            </span>
                        </div>

                        <!-- Site Info -->
                        <div class="flex-1 min-w-0">
                            <h3 class="text-xl font-black text-white uppercase tracking-tighter truncate">\${siteName}</h3>
                            <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest truncate opacity-80">\${hostLabel} // \${n.ip || '0.0.0.0'}</p>
                        </div>

                        <!-- Metrics -->
                        <div class="flex items-center gap-4">
                            <div class="flex flex-col items-center min-w-[80px]">
                                <span class="text-[8px] font-black text-slate-500 uppercase mb-0.5">Fleet</span>
                                <span class="text-sm font-black text-blue-400 font-mono">\${n.scannedDevices.length}</span>
                            </div>
                            <div class="flex flex-col items-center min-w-[80px]">
                                <span class="text-[8px] font-black text-slate-500 uppercase mb-0.5">Priority</span>
                                <span class="text-sm font-black text-amber-500 font-mono">\${priorityCount}</span>
                            </div>
                            <div class="flex flex-col items-center min-w-[80px]">
                                <span class="text-[8px] font-black text-slate-500 uppercase mb-0.5">Storage</span>
                                <span class="text-sm font-black text-slate-300 font-mono">\${n.disk ? n.disk.split(' ')[0] : 'N/A'}</span>
                            </div>
                        </div>

                        <!-- Actions -->
                        <div class="flex items-center gap-2 ml-4">
                            <button onclick="archiveNode('\${n.id}', \${!n.isArchived})" class="p-2.5 text-slate-600 hover:text-white transition-colors" title="Archive">
                                <i class="fas fa-archive text-xs"></i>
                            </button>
                            <button onclick="launchExplorer('\${n.id}')" class="px-5 py-2.5 bg-slate-800 hover:bg-blue-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all border border-slate-700 hover:border-blue-500">
                                EXPLORE
                            </button>
                        </div>
                    </div>\`;
                }).join("");
            }

            function renderExplorer(filter) {
                const node = currentData.find(n => n.id === activeNodeId);
                const showOnlyImportant = document.getElementById('showOnlyImportant')?.checked;
                const grid = document.getElementById('explorerContent');
                if (!node || !grid) return;

                const devices = (node.scannedDevices || []).filter(c => {
                    const match = (c.ip || "").includes(filter) || (c.name || "").toLowerCase().includes(filter);
                    return match && (!showOnlyImportant || !!c.isImportant);
                }).sort((a,b) => (b.isImportant?1:0) - (a.isImportant?1:0));

                grid.innerHTML = \`
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-8 mb-6 flex justify-between items-center shadow-inner">
                        <div>
                            <h2 class="text-3xl font-black text-white uppercase tracking-tighter mb-1">\${node.location || node.hostname}</h2>
                            <p class="text-blue-500 text-[10px] font-black uppercase tracking-[0.3em] opacity-80">\${node.hostname} Subnet Discovery</p>
                        </div>
                        <div class="text-[9px] bg-slate-900 text-slate-400 px-4 py-2 rounded-xl border border-slate-800 font-bold uppercase tracking-widest">Update: \${new Date(node.lastSeen).toLocaleTimeString()}</div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        \${devices.length === 0 ? '<div class="col-span-full py-20 text-center text-slate-600 italic">No discovery matches found.</div>' : devices.map(c => \`
                            <div class="bg-slate-800/80 border border-slate-700 p-5 rounded-2xl shadow-lg relative \${c.isImportant ? 'important-glow' : ''}">
                                <div class="flex justify-between items-start mb-4">
                                    <span class="text-blue-400 font-mono font-black text-[10px]">\${c.ip}</span>
                                    <div class="flex gap-1">
                                        <button onclick="toggleImportant('\${node.id}', '\${c.ip}')" class="p-1.5 \${c.isImportant ? 'text-amber-400' : 'text-slate-600 hover:text-white'} transition-colors"><i class="fas fa-star text-xs"></i></button>
                                        <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="p-1.5 text-slate-600 hover:text-red-500 transition-colors"><i class="fas fa-trash-alt text-xs"></i></button>
                                    </div>
                                </div>
                                <h4 class="text-white font-black mb-1 truncate text-sm uppercase tracking-tight">\${c.name}</h4>
                                <p class="text-[9px] text-slate-500 mb-5 truncate font-bold uppercase tracking-widest opacity-60">\${c.description}</p>
                                <div class="flex justify-between items-center text-[8px] font-black text-slate-600 uppercase pt-3 border-t border-slate-700/50">
                                    <span>Sync: \${new Date(c.lastSeen).toLocaleTimeString()}</span>
                                    \${c.isImportant ? '<span class="text-amber-500 tracking-widest font-black">PRIORITY</span>' : '<span class="tracking-widest">GENERIC</span>'}
                                </div>
                            </div>\`).join("")}
                    </div>\`;
            }

            function launchExplorer(id) { activeNodeId = id; toggleView('explorer'); render(); }
            async function archiveNode(nodeId, archive) { await fetch("/api/archive-node", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, archive }) }); fetchData(); }
            async function toggleImportant(nodeId, clientIp) { await fetch("/api/toggle-important", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, clientIp }) }); fetchData(); }
            async function deleteClient(nodeId, clientIp) { if (confirm(\`Remove \${clientIp}?\`)) { await fetch("/api/delete-client", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, clientIp }) }); fetchData(); } }
            
            document.getElementById("globalFilter")?.addEventListener("input", render);
            document.getElementById('showOnlyImportant')?.addEventListener('change', render);
            setInterval(fetchData, 5000);
            fetchData();
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
