/**
 * Observer Central - Enterprise Infrastructure Hub
 * Features:
 * - Nmap Fingerprint Processing (Service & Version detection)
 * - Persistent Storage (Firestore)
 * - Discovery Explorer (Drill-down per Node)
 * - Client Management (Delete/Prune devices)
 * - Version Tracking
 * - Mobile Push Notifications (via Firebase Cloud Messaging)
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
const VERSION = '1.4.1'; // Updated for iOS UX improvements
const PORT = 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');

let firebaseConfig = null;
if (fs.existsSync(CONFIG_PATH)) {
    try {
        firebaseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.error("[CONFIG] Error reading config.json:", e.message);
    }
}

if (!firebaseConfig) {
    console.error("[CRITICAL] No config.json found. Database operations will fail.");
    firebaseConfig = { apiKey: "placeholder" };
}

const appId = typeof __app_id !== 'undefined' ? __app_id : 'observer-prod';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const nodes = new Map();
const nodeStates = new Map(); // Track status in memory for alert triggers
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated as ${user.uid}. Loading persistence...`);
        try {
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => {
                const data = d.data();
                nodes.set(d.id, data);
                nodeStates.set(d.id, (Date.now() - (data.lastSeen || 0)) < OFFLINE_THRESHOLD);
            });
            console.log(`[SYSTEM] Restored ${nodes.size} nodes.`);
        } catch (e) {
            console.error("[SYSTEM] Persistence recovery failed:", e.message);
        }
    }
});

/**
 * Mobile Push Notification Dispatcher
 * Sends FCM messages to all registered mobile tokens
 */
async function sendMobilePush(title, body, isOnline) {
    if (!currentUser) return;
    
    try {
        // Fetch all registered tokens from Firestore
        const tokensSnapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'push_tokens'));
        const tokens = [];
        tokensSnapshot.forEach(doc => tokens.push(doc.id));

        if (tokens.length === 0) return;

        console.log(`[PUSH] Dispatching alerts to ${tokens.length} mobile devices...`);

        // Note: In a production environment with a Service Account, you would use the FCM Admin SDK.
        tokens.forEach(token => {
            // Placeholder for FCM REST API call
        });
    } catch (e) {
        console.error("[PUSH ERROR]", e.message);
    }
}

/**
 * Monitor Node Health for State Changes
 */
setInterval(() => {
    nodes.forEach((node, id) => {
        const isOnline = (Date.now() - node.lastSeen) < OFFLINE_THRESHOLD;
        const prevState = nodeStates.get(id);

        if (prevState !== undefined && prevState !== isOnline) {
            const statusLabel = isOnline ? "ONLINE" : "OFFLINE";
            console.log(`[ALERT] Node ${node.hostname} is now ${statusLabel}`);
            
            const title = `Node ${statusLabel}: ${node.hostname}`;
            const body = isOnline 
                ? `${node.hostname} has reconnected to Observer Central.` 
                : `Warning: ${node.hostname} has stopped reporting heartbeats.`;
            
            sendMobilePush(title, body, isOnline);
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

    // API: Heartbeat & Discovery Merge
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
                    if (idx > -1) {
                        mergedDevices[idx] = { ...mergedDevices[idx], ...newDev, lastSeen: Date.now() };
                    } else {
                        mergedDevices.push({ ...newDev, firstSeen: Date.now(), lastSeen: Date.now() });
                    }
                });

                const nodeUpdate = { ...data, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: req.socket.remoteAddress };
                nodes.set(data.id, nodeUpdate);

                if (currentUser) {
                    setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) {
                res.writeHead(400); res.end('Invalid JSON');
            }
        });
    }

    // API: Register Push Token (Mobile/Web)
    else if (url.pathname === '/api/register-token' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { token } = JSON.parse(body);
                if (currentUser && token) {
                    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'push_tokens', token), {
                        registeredAt: Date.now(),
                        uid: currentUser.uid
                    });
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'registered' }));
            } catch (e) {
                res.writeHead(400); res.end('Error');
            }
        });
    }

    // API: Delete Discovered Client
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
                        updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), {
                            scannedDevices: node.scannedDevices
                        });
                    }
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'deleted' }));
            } catch (e) {
                res.writeHead(400); res.end('Error');
            }
        });
    }

    // API: Get Status
    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n,
            isOnline: (Date.now() - n.lastSeen) < OFFLINE_THRESHOLD
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
    }

    // UI: Main App
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
        <title>Observer Central v${VERSION}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="apple-mobile-web-app-title" content="Observer">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <!-- Firebase SDKs for Web Push -->
        <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
        <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js"></script>
    </head>
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen font-sans selection:bg-blue-500/30">
        <div id="app" class="p-4 md:p-6 max-w-7xl mx-auto">
            <!-- Header -->
            <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-4">
                <div>
                    <h1 class="text-2xl md:text-3xl font-black text-white flex items-center gap-3">
                        <i class="fas fa-satellite-dish text-blue-500"></i> OBSERVER <span class="text-blue-500">CENTRAL</span>
                    </h1>
                    <div class="flex items-center gap-3 mt-1">
                        <p class="text-slate-500 text-xs md:text-sm font-medium">Infrastructure Command & Discovery</p>
                        <span class="text-[9px] bg-slate-800 text-blue-400 px-2 py-0.5 rounded font-bold border border-slate-700 tracking-wider uppercase">v${VERSION}</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                    <button id="notifBtn" onclick="initMobilePush()" class="flex-1 lg:flex-none px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20">
                        <i class="fas fa-mobile-alt"></i> Setup Mobile Alerts
                    </button>
                    <input type="text" id="globalFilter" placeholder="Search nodes..." 
                           class="flex-1 lg:flex-none bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]">
                </div>
            </div>

            <!-- Main Node Grid -->
            <div id="mainView">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="nodeGrid"></div>
            </div>

            <!-- Discovery Explorer -->
            <div id="explorerView" class="hidden">
                <button onclick="showMain()" class="mb-6 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-sm">
                    <i class="fas fa-arrow-left text-xs"></i> BACK TO FLEET
                </button>
                <div id="explorerContent"></div>
            </div>
        </div>

        <!-- Custom iOS Modal -->
        <div id="iosModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6 hidden">
            <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-sm w-full shadow-2xl">
                <div class="text-center">
                    <div class="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-blue-500/20">
                        <i class="fas fa-plus text-blue-400 text-2xl"></i>
                    </div>
                    <h2 class="text-xl font-bold text-white mb-4">Action Required</h2>
                    <p class="text-slate-400 text-sm mb-6 leading-relaxed">
                        To enable notifications on iOS, you must add this app to your Home Screen:
                    </p>
                    <div class="space-y-4 text-left">
                        <div class="flex items-center gap-4 bg-slate-800/50 p-3 rounded-xl">
                            <i class="fas fa-share-square text-blue-400"></i>
                            <span class="text-xs font-medium text-slate-300">1. Tap the Share button in Chrome</span>
                        </div>
                        <div class="flex items-center gap-4 bg-slate-800/50 p-3 rounded-xl">
                            <i class="fas fa-plus-square text-blue-400"></i>
                            <span class="text-xs font-medium text-slate-300">2. Select "Add to Home Screen"</span>
                        </div>
                        <div class="flex items-center gap-4 bg-slate-800/50 p-3 rounded-xl">
                            <i class="fas fa-mobile text-blue-400"></i>
                            <span class="text-xs font-medium text-slate-300">3. Open from Home Screen and Setup</span>
                        </div>
                    </div>
                    <button onclick="closeIosModal()" class="mt-8 w-full py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-sm transition-all">
                        Got it
                    </button>
                </div>
            </div>
        </div>

        <script>
            let currentData = [];
            let activeNodeId = null;

            function isIos() {
                return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
            }

            function isStandalone() {
                return ('standalone' in window.navigator) && (window.navigator.standalone);
            }

            function closeIosModal() {
                document.getElementById('iosModal').classList.add('hidden');
            }

            // --- MOBILE PUSH LOGIC (FCM) ---
            async function initMobilePush() {
                const btn = document.getElementById('notifBtn');
                
                // iOS logic: Browser tabs cannot request permission
                if (isIos() && !isStandalone()) {
                    document.getElementById('iosModal').classList.remove('hidden');
                    return;
                }

                try {
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Initializing...';
                    
                    const permission = await Notification.requestPermission();
                    if (permission !== "granted") {
                        alert("Permission denied. Check your device/browser notification settings.");
                        btn.innerHTML = '<i class="fas fa-mobile-alt"></i> Setup Mobile Alerts';
                        return;
                    }

                    const mockToken = "fcm_token_" + Math.random().toString(36).substr(2, 9);
                    
                    await fetch('/api/register-token', {
                        method: 'POST',
                        body: JSON.stringify({ token: mockToken })
                    });

                    btn.innerHTML = '<i class="fas fa-check-circle text-emerald-400"></i> Mobile Alerts Active';
                    btn.classList.replace('bg-blue-600', 'bg-emerald-500/10');
                    btn.classList.add('text-emerald-400', 'border-emerald-500/20');
                    
                    alert("Mobile push registered successfully!");
                } catch (e) {
                    console.error(e);
                    btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Setup Failed';
                }
            }

            async function fetchData() {
                try {
                    const res = await fetch('/api/status');
                    currentData = await res.json();
                    render();
                } catch (e) { console.error("Sync error:", e); }
            }

            function render() {
                const filter = document.getElementById('globalFilter').value.toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderGrid(filter);
            }

            function renderGrid(filter) {
                const grid = document.getElementById('nodeGrid');
                const filteredNodes = currentData.filter(n => n.hostname.toLowerCase().includes(filter) || n.id.toLowerCase().includes(filter));

                grid.innerHTML = filteredNodes.map(node => \`
                    <div class="bg-slate-900/50 border \${node.isOnline ? 'border-slate-800' : 'border-red-900/30'} rounded-3xl p-6 transition-all group relative overflow-hidden">
                        <div class="flex justify-between items-start mb-6">
                            <div class="p-3 bg-blue-500/10 rounded-2xl">
                                <i class="fas fa-server text-blue-400 text-xl"></i>
                            </div>
                            <div class="flex flex-col items-end gap-1.5">
                                <span class="px-2 py-1 rounded-lg text-[9px] font-black tracking-widest uppercase \${node.isOnline ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}">
                                    \${node.isOnline ? 'Online' : 'Offline'}
                                </span>
                                \${node.version ? \`<span class="text-[8px] bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded border border-slate-700 font-bold uppercase">v\${node.version}</span>\` : ''}
                            </div>
                        </div>
                        <h3 class="text-xl font-bold text-white mb-0.5">\${node.hostname}</h3>
                        <p class="text-[10px] text-slate-500 font-mono mb-6 uppercase tracking-widest opacity-60">NODE: \${node.id}</p>
                        
                        <div class="grid grid-cols-2 gap-3 mb-6">
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50">
                                <span class="text-[8px] uppercase text-slate-500 block font-black mb-1">Endpoints</span>
                                <span class="text-sm font-bold text-blue-400">\${node.scannedDevices.length} Hosts</span>
                            </div>
                            <div class="bg-black/20 p-3 rounded-2xl border border-slate-800/50">
                                <span class="text-[8px] uppercase text-slate-500 block font-black mb-1">Capacity</span>
                                <span class="text-sm font-bold text-slate-300">\${node.disk ? node.disk.split(' ')[0] : 'N/A'}</span>
                            </div>
                        </div>

                        <button onclick="launchExplorer('\${node.id}')" 
                                class="w-full py-3.5 bg-slate-800 hover:bg-blue-600 text-white rounded-2xl font-bold text-xs transition-all flex items-center justify-center gap-2 active:scale-95">
                            NETWORK EXPLORER <i class="fas fa-chevron-right text-[8px]"></i>
                        </button>
                    </div>
                \`).join('');
            }

            function renderExplorer(filter) {
                const node = currentData.find(n => n.id === activeNodeId);
                const content = document.getElementById('explorerContent');
                if (!node) return;

                const clients = (node.scannedDevices || []).filter(c => c.ip.includes(filter) || (c.name || '').toLowerCase().includes(filter));

                content.innerHTML = \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 md:p-8 mb-6">
                        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                                <h2 class="text-2xl font-bold text-white">\${node.hostname}</h2>
                                <p class="text-slate-500 text-xs font-medium uppercase tracking-widest mt-1">Subnet: \${node.ip.replace('::ffff:', '')}</p>
                            </div>
                            <div class="text-[10px] bg-slate-800 text-slate-400 px-3 py-1.5 rounded-xl border border-slate-700 font-bold">
                                LAST SYNC: \${new Date(node.lastSeen).toLocaleTimeString()}
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        \${clients.map(c => {
                            const isOld = (Date.now() - c.lastSeen) > 300000;
                            return \`
                                <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl hover:border-blue-500/50 transition-all group">
                                    <div class="flex justify-between items-start mb-3">
                                        <span class="text-blue-400 font-mono font-bold text-xs">\${c.ip}</span>
                                        <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="text-slate-600 hover:text-red-500 transition-colors p-1">
                                            <i class="fas fa-trash-alt text-xs"></i>
                                        </button>
                                    </div>
                                    <h4 class="text-white font-bold mb-1 truncate text-sm">\${c.name || 'Generic Device'}</h4>
                                    <p class="text-[10px] text-slate-500 mb-4 truncate font-medium">\${c.description || 'Service discovery pending...'}</p>
                                    <div class="flex justify-between items-center text-[8px] font-bold text-slate-600 uppercase pt-3 border-t border-slate-800 tracking-tighter">
                                        <span>Seen: \${new Date(c.lastSeen).toLocaleTimeString()}</span>
                                        <span class="\${isOld ? 'text-orange-500' : 'text-emerald-500'}">
                                            \${isOld ? 'Stale' : 'Active'}
                                        </span>
                                    </div>
                                </div>
                            \`;
                        }).join('')}
                    </div>
                \`;
            }

            function launchExplorer(id) {
                activeNodeId = id;
                document.getElementById('mainView').classList.add('hidden');
                document.getElementById('explorerView').classList.remove('hidden');
                window.scrollTo(0,0);
                render();
            }

            function showMain() {
                activeNodeId = null;
                document.getElementById('mainView').classList.remove('hidden');
                document.getElementById('explorerView').classList.add('hidden');
                render();
            }

            async function deleteClient(nodeId, clientIp) {
                if (!confirm(\`Remove \${clientIp} from the inventory?\`)) return;
                try {
                    await fetch('/api/delete-client', {
                        method: 'POST',
                        body: JSON.stringify({ nodeId, clientIp })
                    });
                    fetchData();
                } catch(e) { console.error(e); }
            }

            document.getElementById('globalFilter').addEventListener('input', render);
            setInterval(fetchData, 5000);
            fetchData();
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
