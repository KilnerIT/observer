/**
 * Observer Central - Enterprise Infrastructure Hub v1.7.0
 * Features:
 * - Refined Professional UI: Slate Grey, White, and Blue palette
 * - Priority Device Monitor: Live list of important endpoints on Node cards
 * - System Config: Customizable branding (Logo, Title) via UI
 * - Navigation: Compact icon-based explorer access
 * - Firebase Persistent Settings
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
const VERSION = '1.7.0'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');
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
let settings = { siteTitle: "OBSERVER HUB", logoUrl: "https://cdn-icons-png.flaticon.com/512/564/564348.png" };
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated. Loading persistence for ${appId}...`);
        try {
            // Load Nodes
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => nodes.set(d.id, d.data()));
            
            // Load Settings
            const setDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'settings', 'config'));
            if (setDocRef.exists()) settings = { ...settings, ...setDocRef.data() };
        } catch(e) { console.error("Recovery failed:", e.message); }
    }
});

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // PWA Assets
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

    // API: Heartbeat
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

    // API: Update Settings
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

    // API: Archive Node
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

    // API: Toggle Important Client
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

    // API: Status
    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes: list, settings }));
    }

    // Dashboard UI
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
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #0f172a; }
            .node-card { background: #1e293b; border: 1px solid #334155; }
            .priority-item { border-left: 2px solid #3b82f6; }
            .important-glow { border-color: #fbbf24 !important; box-shadow: 0 0 15px rgba(251, 191, 36, 0.1); }
        </style>
    </head>
    <body class="text-slate-200 min-h-screen antialiased">
        <div id="app" class="p-4 md:p-8 max-w-7xl mx-auto">
            <header class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-12 gap-6">
                <div class="flex items-center gap-5">
                    <img id="headerLogo" src="" class="w-12 h-12 object-contain" alt="Logo">
                    <div>
                        <h1 id="headerTitle" class="text-3xl font-black text-white tracking-tighter uppercase"></h1>
                        <p class="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em]">Infrastructure Intelligence</p>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                    <button onclick="toggleView('config')" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all">
                        <i class="fas fa-cog"></i>
                    </button>
                    <button id="viewArchiveBtn" onclick="toggleArchiveView()" class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700">
                        <i class="fas fa-archive mr-2"></i> Archives
                    </button>
                    <button onclick="initPush()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-blue-500/20">
                        <i class="fas fa-bell mr-2"></i> Alerts
                    </button>
                    <input type="text" id="globalFilter" placeholder="Global Search..." class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px]">
                </div>
            </header>

            <!-- Views -->
            <div id="mainView" class="view-section">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8" id="nodeGrid"></div>
            </div>

            <div id="explorerView" class="view-section hidden">
                <div class="flex justify-between items-center mb-8 bg-slate-800/50 p-4 rounded-2xl border border-slate-800">
                    <button onclick="toggleView('main')" class="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-xs uppercase tracking-widest">
                        <i class="fas fa-chevron-left text-[10px]"></i> Fleet Overview
                    </button>
                    <label class="flex items-center gap-2 text-[10px] font-black text-slate-500 cursor-pointer uppercase tracking-widest">
                        <input type="checkbox" id="showOnlyImportant" class="rounded border-slate-800 bg-slate-900 text-amber-500 focus:ring-amber-500">
                        Priority Only
                    </label>
                </div>
                <div id="explorerContent"></div>
            </div>

            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('main')" class="mb-8 text-slate-400 hover:text-white font-bold text-xs uppercase tracking-widest">
                    <i class="fas fa-arrow-left mr-2"></i> Back
                </button>
                <div class="max-w-2xl bg-slate-800 border border-slate-700 rounded-3xl p-8 shadow-2xl">
                    <h2 class="text-2xl font-black text-white mb-8">SYSTEM CONFIGURATION</h2>
                    <div class="space-y-6">
                        <div>
                            <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Company Name / Hub Title</label>
                            <input type="text" id="cfgTitle" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Logo URL (PNG/SVG Preferred)</label>
                            <input type="text" id="cfgLogo" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:ring-2 focus:ring-blue-500">
                        </div>
                        <button onclick="saveConfig()" class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all shadow-xl shadow-blue-500/20 uppercase tracking-widest text-xs mt-4">
                            Apply Changes
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
                    alert("Alerts Enabled.");
                } catch (e) { console.error(e); }
            }

            async function fetchData() {
                try {
                    const res = await fetch('/api/status');
                    const json = await res.json();
                    currentData = json.nodes;
                    currentSettings = json.settings;
                    updateBranding();
                    render();
                } catch (e) {}
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
                else renderGrid(filter);
            }

            function renderGrid(filter) {
                const grid = document.getElementById('nodeGrid');
                const nodes = currentData.filter(n => {
                    const match = (n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter);
                    return match && (!!n.isArchived === showArchived);
                });

                grid.innerHTML = nodes.map(n => {
                    const statusClass = n.isOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20';
                    const importantDevices = (n.scannedDevices || []).filter(d => d.isImportant).slice(0, 3);
                    
                    return \`
                    <div class="node-card rounded-[2.5rem] p-8 transition-all group relative overflow-hidden shadow-2xl">
                        <div class="flex justify-between items-start mb-8">
                            <div class="p-4 bg-blue-500/10 rounded-2xl border border-blue-500/20 shadow-inner">
                                <i class="fas fa-broadcast-tower text-blue-400 text-2xl"></i>
                            </div>
                            <div class="flex items-center gap-3">
                                <button onclick="archiveNode('\${n.id}', \${!n.isArchived})" class="p-2 text-slate-600 hover:text-white transition-colors"><i class="fas fa-archive text-xs"></i></button>
                                <span class="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase \${statusClass}">\${n.isOnline ? 'Online' : 'Offline'}</span>
                                <button onclick="launchExplorer('\${n.id}')" class="p-2.5 bg-slate-800 text-blue-400 rounded-xl hover:bg-blue-500 hover:text-white transition-all">
                                    <i class="fas fa-search-plus"></i>
                                </button>
                            </div>
                        </div>

                        <h3 class="text-3xl font-black text-white mb-1 uppercase tracking-tighter">\${n.hostname}</h3>
                        <p class="text-xs text-slate-500 font-bold uppercase tracking-widest mb-8 opacity-80">\${n.location || 'Remote Site'}</p>

                        <div class="grid grid-cols-2 gap-4 mb-8">
                            <div class="bg-black/20 p-4 rounded-2xl border border-slate-700/50">
                                <span class="text-[9px] font-black text-slate-500 block mb-1 tracking-widest">FLEET COUNT</span>
                                <span class="text-3xl font-black text-blue-400">\${n.scannedDevices.length}</span>
                            </div>
                            <div class="bg-black/20 p-4 rounded-2xl border border-slate-700/50">
                                <span class="text-[9px] font-black text-slate-500 block mb-1 tracking-widest">DISK LOAD</span>
                                <span class="text-lg font-black text-slate-300">\${n.disk ? n.disk.split(' ')[0] : 'N/A'}</span>
                            </div>
                        </div>

                        <div class="space-y-3">
                            <span class="text-[9px] font-black text-slate-500 block mb-2 tracking-widest uppercase">Priority Assets</span>
                            \${importantDevices.length === 0 ? '<p class="text-[10px] text-slate-600 italic">No assets marked for priority</p>' : importantDevices.map(d => \`
                                <div class="priority-item bg-slate-800/80 p-3 rounded-xl flex justify-between items-center">
                                    <div>
                                        <p class="text-[11px] font-black text-white">\${d.name || d.ip}</p>
                                        <p class="text-[9px] text-slate-500 font-mono">\${d.ip}</p>
                                    </div>
                                    <div class="text-right">
                                        <p class="text-[8px] font-black text-blue-500 uppercase">\${new Date(d.lastSeen).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
                                    </div>
                                </div>
                            \`).join('')}
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
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-10 mb-8 flex justify-between items-center shadow-inner">
                        <div>
                            <h2 class="text-4xl font-black text-white uppercase tracking-tighter mb-1">\${node.hostname}</h2>
                            <p class="text-blue-500 text-xs font-black uppercase tracking-[0.3em]">\${node.location} Discovery</p>
                        </div>
                        <div class="text-[10px] bg-slate-900 text-slate-400 px-5 py-3 rounded-xl border border-slate-800 font-bold uppercase tracking-widest">Sync: \${new Date(node.lastSeen).toLocaleTimeString()}</div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        \${devices.map(c => \`
                            <div class="bg-slate-800/80 border border-slate-700 p-6 rounded-[1.5rem] shadow-xl relative \${c.isImportant ? 'important-glow' : ''}">
                                <div class="flex justify-between items-start mb-5">
                                    <span class="text-blue-400 font-mono font-black text-xs">\${c.ip}</span>
                                    <div class="flex gap-1">
                                        <button onclick="toggleImportant('\${node.id}', '\${c.ip}')" class="p-1.5 \${c.isImportant ? 'text-amber-400' : 'text-slate-600 hover:text-white'} transition-colors"><i class="fas fa-star text-xs"></i></button>
                                        <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="p-1.5 text-slate-600 hover:text-red-500 transition-colors"><i class="fas fa-trash-alt text-xs"></i></button>
                                    </div>
                                </div>
                                <h4 class="text-white font-black mb-1 truncate text-base uppercase tracking-tight">\${c.name}</h4>
                                <p class="text-[10px] text-slate-500 mb-6 truncate font-bold uppercase tracking-widest opacity-60">\${c.description}</p>
                                <div class="flex justify-between items-center text-[9px] font-black text-slate-600 uppercase pt-4 border-t border-slate-700/50">
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
