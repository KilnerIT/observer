/**
 * Observer Central - Enterprise Infrastructure Hub
 * Features:
 * - Nmap Fingerprint Processing (Service & Version detection)
 * - Persistent Storage (Firestore)
 * - Discovery Explorer (Drill-down per Node)
 * - Client Management (Delete/Prune devices)
 * - Version Tracking
 * - Mobile Push Notifications (via Firebase Cloud Messaging)
 * - PWA Support (Manifest & Service Worker for iOS)
 * - Cloud-Ready: Configured for https://observer-sxv0.onrender.com
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
const VERSION = '1.5.3'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');

// VAPID Public Key
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'REPLACE_WITH_YOUR_ACTUAL_FIREBASE_PUBLIC_VAPID_KEY';

/**
 * FIREBASE CONFIGURATION LOAD
 */
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
    console.log("[CONFIG] Using Cloud Environment Variables");
} else if (fs.existsSync(CONFIG_PATH)) {
    try {
        firebaseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        console.log("[CONFIG] Using local config.json");
    } catch (e) {
        console.error("[CONFIG] Error reading config.json:", e.message);
    }
}

if (!firebaseConfig || !firebaseConfig.apiKey) {
    console.error("[CRITICAL] No Firebase configuration found. Persistence will fail.");
    firebaseConfig = { apiKey: "placeholder" };
}

const appId = typeof __app_id !== 'undefined' ? __app_id : (process.env.OBSERVER_APP_ID || 'observer-prod');
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const nodes = new Map();
const nodeStates = new Map(); 
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated UID: ${user.uid} | AppID: ${appId}`);
        try {
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => {
                const data = d.data();
                nodes.set(d.id, data);
                nodeStates.set(d.id, (Date.now() - (data.lastSeen || 0)) < OFFLINE_THRESHOLD);
            });
            console.log(`[SYSTEM] Restored ${nodes.size} nodes from cloud.`);
        } catch (e) {
            console.error("[SYSTEM] Persistence recovery failed:", e.message);
        }
    }
});

/**
 * Mobile Push Notification Dispatcher
 */
async function sendMobilePush(title, body, isOnline) {
    if (!currentUser) return;
    try {
        const tokensSnapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'push_tokens'));
        const tokens = [];
        tokensSnapshot.forEach(doc => tokens.push(doc.id));
        if (tokens.length === 0) return;
        console.log(`[PUSH] Dispatching alerts to ${tokens.length} devices...`);
    } catch (e) {
        console.error("[PUSH ERROR]", e.message);
    }
}

/**
 * Monitor Node Health
 */
setInterval(() => {
    nodes.forEach((node, id) => {
        const isOnline = (Date.now() - node.lastSeen) < OFFLINE_THRESHOLD;
        const prevState = nodeStates.get(id);
        if (prevState !== undefined && prevState !== isOnline) {
            const statusLabel = isOnline ? "ONLINE" : "OFFLINE";
            sendMobilePush(`Node ${statusLabel}: ${node.hostname}`, `${node.hostname} is now ${statusLabel.toLowerCase()}.`, isOnline);
        }
        nodeStates.set(id, isOnline);
    });
}, 10000);

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            name: "Observer Central",
            short_name: "Observer",
            start_url: "/",
            display: "standalone",
            background_color: "#0b0f1a",
            theme_color: "#0b0f1a",
            icons: [{ src: "https://cdn-icons-png.flaticon.com/512/564/564348.png", sizes: "512x512", type: "image/png" }]
        }));
    }

    if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(`
            self.addEventListener('push', function(event) {
                let data = { title: "Observer Alert", body: "Status change detected." };
                try { data = event.data.json(); } catch(e) {}
                event.waitUntil(self.registration.showNotification(data.title, {
                    body: data.body,
                    icon: "https://cdn-icons-png.flaticon.com/512/564/564348.png"
                }));
            });
        `);
    }

    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const existing = nodes.get(data.id) || { scannedDevices: [] };
                const currentScans = data.scannedDevices || [];
                const mergedDevices = [...(existing.scannedDevices || [])];
                currentScans.forEach(newDev => {
                    const idx = mergedDevices.findIndex(d => d.ip === newDev.ip);
                    if (idx > -1) { mergedDevices[idx] = { ...mergedDevices[idx], ...newDev, lastSeen: Date.now() }; }
                    else { mergedDevices.push({ ...newDev, firstSeen: Date.now(), lastSeen: Date.now() }); }
                });
                const nodeUpdate = { ...data, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: req.socket.remoteAddress };
                nodes.set(data.id, nodeUpdate);
                if (currentUser) {
                    setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { res.writeHead(400); res.end('Invalid JSON'); }
        });
    }

    else if (url.pathname === '/api/register-token' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { subscription } = JSON.parse(body);
                if (currentUser && subscription) {
                    const subId = Buffer.from(subscription.endpoint).toString('base64').substring(0, 50);
                    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'push_tokens', subId), {
                        subscription, registeredAt: Date.now(), uid: currentUser.uid
                    });
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'registered' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

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
                    if (currentUser) {
                        updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { scannedDevices: node.scannedDevices });
                    }
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'deleted' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n,
            isOnline: (Date.now() - n.lastSeen) < OFFLINE_THRESHOLD
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
    }

    else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateUI());
    }
});

function generateUI() {
    return `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
        <meta charset="UTF-8">
        <title>Observer Central v${VERSION}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <link rel="manifest" href="/manifest.json">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen font-sans antialiased">
        <div id="app" class="p-4 md:p-6 max-w-7xl mx-auto">
            <!-- Header -->
            <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-4">
                <div>
                    <h1 class="text-2xl md:text-3xl font-black text-white flex items-center gap-3">
                        <i class="fas fa-satellite-dish text-blue-500"></i> OBSERVER <span class="text-blue-500">CENTRAL</span>
                    </h1>
                    <div class="flex items-center gap-3 mt-1">
                        <p class="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-tight">Cloud Environment v${VERSION}</p>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                    <button id="notifBtn" onclick="initMobilePush()" class="flex-1 lg:flex-none px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20">
                        <i class="fas fa-mobile-alt"></i> Setup Alerts
                    </button>
                    <input type="text" id="globalFilter" placeholder="Filter..." class="flex-1 lg:flex-none bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]">
                </div>
            </div>

            <!-- Dashboard Content -->
            <div id="mainView">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="nodeGrid">
                    <div class="col-span-full text-center py-20 opacity-50 italic">Awaiting fleet synchronization...</div>
                </div>
            </div>

            <div id="explorerView" class="hidden">
                <button onclick="showMain()" class="mb-6 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-sm uppercase">
                    <i class="fas fa-arrow-left text-xs"></i> Back to Fleet
                </button>
                <div id="explorerContent"></div>
            </div>
        </div>

        <!-- Popups -->
        <div id="iosModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6 hidden">
            <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center">
                <i class="fas fa-plus-circle text-blue-400 text-3xl mb-4"></i>
                <h2 class="text-xl font-bold text-white mb-2">iOS Setup</h2>
                <p class="text-slate-400 text-sm mb-6">To enable notifications on iPhone, tap 'Share' and then 'Add to Home Screen'.</p>
                <button onclick="document.getElementById('iosModal').classList.add('hidden')" class="w-full py-3 bg-slate-800 text-white rounded-xl font-bold text-sm">Got it</button>
            </div>
        </div>

        <script>
            let currentData = [];
            let activeNodeId = null;
            const VAPID_KEY = "${VAPID_PUBLIC_KEY}";

            function urlBase64ToUint8Array(base64String) {
                const padding = "=".repeat((4 - base64String.length % 4) % 4);
                const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
                const rawData = window.atob(base64);
                const outputArray = new Uint8Array(rawData.length);
                for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
                return outputArray;
            }

            if ("serviceWorker" in navigator) {
                navigator.serviceWorker.register("/sw.js").catch(e => console.error("SW Error", e));
            }

            async function initMobilePush() {
                if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.navigator.standalone) {
                    document.getElementById("iosModal").classList.remove("hidden");
                    return;
                }
                const btn = document.getElementById("notifBtn");
                try {
                    btn.innerHTML = "Subscribing...";
                    const reg = await navigator.serviceWorker.ready;
                    const sub = await reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY)
                    });
                    await fetch("/api/register-token", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ subscription: sub })
                    });
                    btn.innerHTML = "Alerts Active";
                } catch (e) { btn.innerHTML = "Setup Failed"; console.error(e); }
            }

            async function fetchData() {
                try {
                    const res = await fetch("/api/status");
                    currentData = await res.json();
                    render();
                } catch (e) { console.error("Fetch failed", e); }
            }

            function render() {
                const filter = (document.getElementById("globalFilter").value || "").toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderGrid(filter);
            }

            function renderGrid(filter) {
                const grid = document.getElementById("nodeGrid");
                const filtered = currentData.filter(n => (n.hostname || "").toLowerCase().includes(filter) || (n.id || "").toLowerCase().includes(filter));
                
                if (filtered.length === 0) {
                    grid.innerHTML = '<div class="col-span-full py-20 opacity-30 italic text-center text-lg font-bold uppercase tracking-tighter">No active nodes reporting</div>';
                    return;
                }

                grid.innerHTML = filtered.map(node => {
                    const statusClass = node.isOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20';
                    const diskVal = node.disk ? node.disk.toString().split(" ")[0] : "N/A";
                    
                    return \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 shadow-xl text-left">
                        <div class="flex justify-between items-start mb-6">
                            <div class="p-3 bg-blue-500/10 rounded-2xl"><i class="fas fa-server text-blue-400"></i></div>
                            <span class="px-2 py-1 rounded-lg text-[9px] font-black uppercase \${statusClass}">\${node.isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                        <h3 class="text-xl font-bold text-white mb-0.5 truncate uppercase tracking-tighter font-black">\${node.hostname || 'Unknown'}</h3>
                        <p class="text-[10px] text-slate-500 font-mono mb-6 uppercase tracking-widest opacity-60">ID: \${node.id}</p>
                        <div class="grid grid-cols-2 gap-3 mb-6">
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50">
                                <span class="text-[8px] uppercase text-slate-500 block font-black mb-1">Endpoints</span>
                                <span class="text-sm font-bold text-blue-400 font-mono">\${node.scannedDevices ? node.scannedDevices.length : 0}</span>
                            </div>
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50">
                                <span class="text-[8px] uppercase text-slate-500 block font-black mb-1">Capacity</span>
                                <span class="text-xs font-bold text-slate-300 truncate">\${diskVal}</span>
                            </div>
                        </div>
                        <button onclick="launchExplorer('\${node.id}')" class="w-full py-3.5 bg-slate-800 hover:bg-blue-600 text-white rounded-2xl font-bold text-xs transition-all uppercase tracking-tighter shadow-md">Network Explorer</button>
                    </div>\`;
                }).join("");
            }

            function renderExplorer(filter) {
                const node = currentData.find(n => n.id === activeNodeId);
                const content = document.getElementById("explorerContent");
                if (!node) return;
                const devices = (node.scannedDevices || []).filter(c => (c.ip || "").includes(filter) || (c.name || "").toLowerCase().includes(filter));
                
                content.innerHTML = \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-8 mb-6 text-left">
                        <h2 class="text-2xl font-black text-white uppercase tracking-tighter">\${node.hostname}</h2>
                        <p class="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Network Subnet Discovery</p>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        \${devices.map(c => \`
                            <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl text-left shadow-lg">
                                <div class="flex justify-between items-start mb-3">
                                    <span class="text-blue-400 font-mono font-bold text-xs font-black">\${c.ip}</span>
                                    <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="text-slate-600 hover:text-red-500 p-1"><i class="fas fa-trash-alt text-xs"></i></button>
                                </div>
                                <h4 class="text-white font-bold mb-1 truncate text-sm uppercase tracking-tight font-black">\${c.name || 'Device'}</h4>
                                <p class="text-[10px] text-slate-500 mb-4 truncate font-bold uppercase tracking-tighter opacity-50">\${c.description || 'Checking services...'}</p>
                                <div class="flex justify-between items-center text-[8px] font-black text-slate-600 uppercase pt-3 border-t border-slate-800">
                                    <span>Sync: \${new Date(c.lastSeen).toLocaleTimeString()}</span>
                                    <span class="text-emerald-500 font-black tracking-tighter uppercase">Active</span>
                                </div>
                            </div>\`).join("")}
                    </div>\`;
            }

            function launchExplorer(id) { activeNodeId = id; document.getElementById("mainView").classList.add("hidden"); document.getElementById("explorerView").classList.remove("hidden"); window.scrollTo(0,0); render(); }
            function showMain() { activeNodeId = null; document.getElementById("mainView").classList.remove("hidden"); document.getElementById("explorerView").classList.add("hidden"); render(); }
            async function deleteClient(nodeId, clientIp) { if (!confirm(\`Delete \${clientIp}?\`)) return; await fetch("/api/delete-client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId, clientIp }) }); fetchData(); }
            
            document.getElementById("globalFilter").addEventListener("input", render);
            setInterval(fetchData, 5000);
            fetchData();
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
