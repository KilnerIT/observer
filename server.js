/**
 * Observer Central - Enterprise Infrastructure Hub v1.6.1
 * Features:
 * - Archive Node Functionality (Hides nodes without deleting)
 * - Important Client Tagging (Star/Highlight high-priority endpoints)
 * - Location Tagging Support
 * - iOS PWA Hardening
 * - Firebase Persistent Storage
 * - Bugfix: Robust merging logic to prevent HTTP 400 errors
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
const VERSION = '1.6.1'; 
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
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated. Loading persistence for ${appId}...`);
        try {
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => nodes.set(d.id, d.data()));
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
            name: "Observer Central", short_name: "Observer", start_url: "/", display: "standalone",
            background_color: "#0b0f1a", theme_color: "#0b0f1a",
            icons: [{ src: "https://cdn-icons-png.flaticon.com/512/564/564348.png", sizes: "512x512", type: "image/png" }]
        }));
    }

    if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(`self.addEventListener('push', e => {
            let d = { title: "Observer Alert", body: "Change detected" };
            try { d = e.data.json(); } catch(err) {}
            e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: "https://cdn-icons-png.flaticon.com/512/564/564348.png" }));
        });`);
    }

    // API: Heartbeat (Fixed Merge Logic)
    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!data.id) throw new Error("Missing ID");

                const existing = nodes.get(data.id) || { scannedDevices: [], isArchived: false };
                
                // Reset archive status if node reports in
                const isArchived = existing.isArchived || false;

                const currentScans = Array.isArray(data.scannedDevices) ? data.scannedDevices : [];
                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];

                currentScans.forEach(newDev => {
                    if (!newDev || !newDev.ip) return;
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        // Safe merge: preserve 'isImportant' and 'firstSeen'
                        const oldDev = mergedDevices[idx];
                        mergedDevices[idx] = { 
                            ...newDev, 
                            isImportant: !!oldDev.isImportant, 
                            firstSeen: oldDev.firstSeen || Date.now(),
                            lastSeen: Date.now() 
                        }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });

                const nodeUpdate = { 
                    ...existing, 
                    ...data, 
                    isArchived: false, // Unarchive on heartbeat
                    scannedDevices: mergedDevices, 
                    lastSeen: Date.now(), 
                    ip: req.socket.remoteAddress.replace('::ffff:', '') 
                };

                nodes.set(data.id, nodeUpdate);
                if (currentUser) setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                
                res.writeHead(200); 
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { 
                console.error("[API ERROR]", e.message); 
                res.writeHead(400); 
                res.end('Error'); 
            }
        });
    }

    // API: Archive Node
    else if (url.pathname === '/api/archive-node' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { nodeId, archive } = JSON.parse(body);
                const node = nodes.get(nodeId);
                if (node) {
                    node.isArchived = !!archive;
                    nodes.set(nodeId, node);
                    if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { isArchived: !!archive });
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
            } catch(e) { res.writeHead(400); res.end('Fail'); }
        });
    }

    // API: Toggle Important Client
    else if (url.pathname === '/api/toggle-important' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { nodeId, clientIp } = JSON.parse(body);
                const node = nodes.get(nodeId);
                if (node) {
                    const device = node.scannedDevices.find(d => d.ip === clientIp);
                    if (device) {
                        device.isImportant = !device.isImportant;
                        nodes.set(nodeId, node);
                        if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { scannedDevices: node.scannedDevices });
                    }
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
            } catch(e) { res.writeHead(400); res.end('Fail'); }
        });
    }

    // API: Delete Client
    else if (url.pathname === '/api/delete-client' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { nodeId, clientIp } = JSON.parse(body);
                const node = nodes.get(nodeId);
                if (node) {
                    node.scannedDevices = node.scannedDevices.filter(d => d.ip !== clientIp);
                    nodes.set(nodeId, node);
                    if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { scannedDevices: node.scannedDevices });
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'deleted' }));
            } catch(e) { res.writeHead(400); res.end('Fail'); }
        });
    }

    // API: Status
    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
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
        <title>Observer Hub v${VERSION}</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <link rel="manifest" href="/manifest.json">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            .important-client { border-color: #fbbf24 !important; background: rgba(251, 191, 36, 0.05); }
            .important-tag { color: #fbbf24; }
        </style>
    </head>
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen font-sans">
        <div id="app" class="p-4 md:p-6 max-w-7xl mx-auto">
            <header class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-10 gap-4">
                <div>
                    <h1 class="text-3xl font-black text-white flex items-center gap-3">
                        <i class="fas fa-eye text-blue-500"></i> OBSERVER <span class="text-blue-500">HUB</span>
                    </h1>
                    <div class="flex items-center gap-3 mt-1">
                        <p class="text-slate-500 text-xs font-bold uppercase tracking-widest">Global Fleet Monitor</p>
                        <span class="text-[9px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-bold border border-slate-700 uppercase">v${VERSION}</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                    <button id="viewArchiveBtn" onclick="toggleArchiveView()" class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700">
                        <i class="fas fa-archive mr-2"></i> Show Archives
                    </button>
                    <button id="notifBtn" onclick="initPush()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/20">
                        <i class="fas fa-bell mr-2"></i> Setup Alerts
                    </button>
                    <input type="text" id="globalFilter" placeholder="Search..." class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]">
                </div>
            </header>

            <div id="mainView">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="nodeGrid"></div>
            </div>

            <div id="explorerView" class="hidden">
                <div class="flex justify-between items-center mb-8">
                    <button onclick="showMain()" class="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-sm uppercase">
                        <i class="fas fa-chevron-left text-xs"></i> BACK TO FLEET
                    </button>
                    <div class="flex items-center gap-4">
                        <label class="flex items-center gap-2 text-xs font-bold text-slate-500 cursor-pointer">
                            <input type="checkbox" id="showOnlyImportant" class="rounded border-slate-800 bg-slate-900 text-amber-500 focus:ring-amber-500">
                            IMPORTANT ONLY
                        </label>
                    </div>
                </div>
                <div id="explorerContent"></div>
            </div>
        </div>

        <div id="iosModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6 hidden">
            <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-sm w-full text-center">
                <i class="fas fa-mobile-alt text-blue-500 text-3xl mb-4"></i>
                <h2 class="text-xl font-bold text-white mb-2">Setup Required</h2>
                <p class="text-slate-400 text-sm mb-6">On iOS, tap 'Share' then 'Add to Home Screen' to enable push alerts.</p>
                <button onclick="document.getElementById('iosModal').classList.add('hidden')" class="w-full py-3 bg-slate-800 text-white rounded-xl font-bold text-sm">Got it</button>
            </div>
        </div>

        <script>
            let currentData = [];
            let activeNodeId = null;
            let showArchived = false;
            const VAPID_KEY = "${VAPID_PUBLIC_KEY}";

            async function initPush() {
                if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.navigator.standalone) {
                    document.getElementById('iosModal').classList.remove('hidden');
                    return;
                }
                const btn = document.getElementById('notifBtn');
                try {
                    btn.innerHTML = "Initializing...";
                    const reg = await navigator.serviceWorker.ready;
                    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_KEY) });
                    await fetch('/api/register-token', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ subscription: sub }) });
                    btn.innerHTML = "Alerts Active";
                    btn.classList.add('bg-emerald-500/10', 'text-emerald-500', 'border-emerald-500/20');
                } catch (e) { btn.innerHTML = "Setup Failed"; console.error(e); }
            }

            function urlBase64ToUint8Array(s) { const p = '='.repeat((4-s.length%4)%4); const b = (s+p).replace(/-/g,'+').replace(/_/g,'/'); const r = window.atob(b); const o = new Uint8Array(r.length); for(let i=0; i<r.length; ++i){ o[i]=r.charCodeAt(i); } return o; }
            if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

            async function fetchData() {
                try {
                    const res = await fetch('/api/status');
                    currentData = await res.json();
                    render();
                } catch (e) {}
            }

            function toggleArchiveView() {
                showArchived = !showArchived;
                document.getElementById('viewArchiveBtn').innerHTML = showArchived ? '<i class="fas fa-eye mr-2"></i> Show Active' : '<i class="fas fa-archive mr-2"></i> Show Archives';
                render();
            }

            function render() {
                const filter = (document.getElementById('globalFilter')?.value || "").toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderGrid(filter);
            }

            function renderGrid(filter) {
                const grid = document.getElementById('nodeGrid');
                if(!grid) return;
                const filtered = currentData.filter(n => {
                    const matchesSearch = (n.hostname || "").toLowerCase().includes(filter) || (n.id || "").toLowerCase().includes(filter);
                    return matchesSearch && (!!n.isArchived === showArchived);
                });

                if (filtered.length === 0) {
                    grid.innerHTML = \`<div class="col-span-full py-20 text-center text-slate-600 italic border-2 border-dashed border-slate-800/50 rounded-3xl">No \${showArchived ? 'archived' : 'active'} nodes found.</div>\`;
                    return;
                }

                grid.innerHTML = filtered.map(n => {
                    const statusClass = n.isOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20';
                    return \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 transition-all group relative hover:border-blue-500/50">
                        <div class="flex justify-between items-start mb-6">
                            <div class="p-3 bg-blue-500/10 rounded-2xl"><i class="fas fa-server text-blue-400"></i></div>
                            <div class="flex items-center gap-2">
                                <button onclick="archiveNode('\${n.id}', \${!n.isArchived})" class="p-2 text-slate-600 hover:text-white transition-colors" title="Archive Node"><i class="fas fa-archive text-[10px]"></i></button>
                                <span class="px-2 py-1 rounded-lg text-[9px] font-black uppercase \${statusClass}">\${n.isOnline ? 'Online' : 'Offline'}</span>
                            </div>
                        </div>
                        <h3 class="text-xl font-bold text-white mb-0.5 truncate uppercase tracking-tighter font-black">\${n.hostname}</h3>
                        <p class="text-[10px] text-slate-500 font-mono mb-4 uppercase tracking-widest opacity-60">\${n.location || 'Unknown Location'}</p>
                        <div class="grid grid-cols-2 gap-3 mb-6">
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50"><span class="text-[8px] uppercase text-slate-500 block font-black mb-1 tracking-widest">Hosts</span><span class="text-sm font-bold text-blue-400 font-mono">\${Array.isArray(n.scannedDevices) ? n.scannedDevices.length : 0}</span></div>
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50"><span class="text-[8px] uppercase text-slate-500 block font-black mb-1 tracking-widest">Disk</span><span class="text-xs font-bold text-slate-300 font-mono">\${n.disk ? n.disk.split(' ')[0] : 'N/A'}</span></div>
                        </div>
                        <button onclick="launchExplorer('\${n.id}')" class="w-full py-3.5 bg-slate-800 hover:bg-blue-600 text-white rounded-2xl font-bold text-xs transition-all uppercase tracking-tighter">View Network</button>
                    </div>\`;
                }).join("");
            }

            function renderExplorer(filter) {
                const node = currentData.find(n => n.id === activeNodeId);
                const showOnlyImportant = document.getElementById('showOnlyImportant')?.checked;
                const grid = document.getElementById('explorerContent');
                if (!node || !grid) return;

                const devices = (node.scannedDevices || []).filter(c => {
                    const matchesSearch = (c.ip || "").includes(filter) || (c.name || "").toLowerCase().includes(filter);
                    const matchesImportant = !showOnlyImportant || !!c.isImportant;
                    return matchesSearch && matchesImportant;
                }).sort((a, b) => (b.isImportant ? 1 : 0) - (a.isImportant ? 1 : 0));

                grid.innerHTML = \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 md:p-10 mb-8 flex justify-between items-center">
                        <div>
                            <h2 class="text-3xl font-black text-white uppercase tracking-tighter mb-1">\${node.hostname}</h2>
                            <p class="text-slate-500 text-xs font-bold uppercase tracking-widest">\${node.location} // Inventory Discovery</p>
                        </div>
                        <div class="text-[10px] bg-slate-800 text-slate-400 px-4 py-2 rounded-xl border border-slate-700 font-bold uppercase tracking-widest">Last Sync: \${new Date(node.lastSeen).toLocaleTimeString()}</div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        \${devices.length === 0 ? '<div class="col-span-full py-20 text-center text-slate-600 italic">No devices match your criteria.</div>' : devices.map(c => \`
                            <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg relative transition-all \${c.isImportant ? 'important-client' : ''}">
                                <div class="flex justify-between items-start mb-4">
                                    <span class="text-blue-400 font-mono font-bold text-xs font-black">\${c.ip}</span>
                                    <div class="flex gap-1">
                                        <button onclick="toggleImportant('\${node.id}', '\${c.ip}')" class="p-1.5 \${c.isImportant ? 'text-amber-400' : 'text-slate-600 hover:text-white'} transition-colors"><i class="fas fa-star text-xs"></i></button>
                                        <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="p-1.5 text-slate-600 hover:text-red-500 transition-colors"><i class="fas fa-trash-alt text-xs"></i></button>
                                    </div>
                                </div>
                                <h4 class="text-white font-bold mb-1 truncate text-base uppercase tracking-tight font-black">\${c.name}</h4>
                                <p class="text-[10px] text-slate-500 mb-6 truncate font-bold uppercase tracking-widest opacity-60">\${c.description}</p>
                                <div class="flex justify-between items-center text-[9px] font-black text-slate-600 uppercase pt-4 border-t border-slate-800/50">
                                    <span>Sync: \${new Date(c.lastSeen).toLocaleTimeString()}</span>
                                    \${c.isImportant ? '<span class="important-tag font-black tracking-widest uppercase">PRIORITY</span>' : '<span class="text-slate-700 font-black tracking-widest uppercase">NORMAL</span>'}
                                </div>
                            </div>\`).join("")}
                    </div>\`;
            }

            function launchExplorer(id) { activeNodeId = id; document.getElementById("mainView")?.classList.add("hidden"); document.getElementById("explorerView")?.classList.remove("hidden"); window.scrollTo(0,0); render(); }
            function showMain() { activeNodeId = null; document.getElementById("mainView")?.classList.remove("hidden"); document.getElementById("explorerView")?.classList.add("hidden"); render(); }
            
            async function archiveNode(nodeId, archive) {
                await fetch("/api/archive-node", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, archive }) });
                fetchData();
            }

            async function toggleImportant(nodeId, clientIp) {
                await fetch("/api/toggle-important", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, clientIp }) });
                fetchData();
            }

            async function deleteClient(nodeId, clientIp) {
                if (!confirm(\`Remove \${clientIp}?\`)) return;
                await fetch("/api/delete-client", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, clientIp }) });
                fetchData();
            }

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
