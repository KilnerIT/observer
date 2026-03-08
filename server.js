/**
 * Observer Central - Enterprise Infrastructure Hub v2.0.0
 * Features:
 * - Performance Trending: Real-time SVG sparklines for CPU & RAM history
 * - Maintenance Windows: 2-hour alert silencing toggle for nodes
 * - Audit Logging: Persistent tracking of admin actions (Who, What, When)
 * - OS Fingerprinting: Support for advanced Nmap OS detection storage
 * - Monochrome Industrial Palette: Refined grey/white/black UI
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
const VERSION = '2.0.0'; 
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

/**
 * Utility: Audit Logger
 */
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
                const existing = nodes.get(data.id) || { scannedDevices: [], metricsHistory: [] };
                
                // Process Metrics History (Max 24 points)
                const metricsHistory = Array.isArray(existing.metricsHistory) ? existing.metricsHistory : [];
                metricsHistory.push({ cpu: data.cpu || 0, ram: data.ram || 0, ts: Date.now() });
                if (metricsHistory.length > 24) metricsHistory.shift();

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

                const nodeUpdate = { 
                    ...existing, 
                    ...data, 
                    isArchived: false, 
                    uptimeStats, 
                    metricsHistory,
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
                await logAction(data.adminEmail, "Updated Hub Settings", "Global");
                res.writeHead(200); res.end(JSON.stringify({ status: 'updated' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/set-maintenance' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const { nodeId, durationHours, adminEmail } = JSON.parse(body);
            const node = nodes.get(nodeId);
            if (node) {
                const until = durationHours > 0 ? Date.now() + (durationHours * 3600000) : 0;
                node.maintenanceUntil = until;
                nodes.set(nodeId, node);
                if (currentUser) updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', nodeId), { maintenanceUntil: until });
                await logAction(adminEmail, until > 0 ? `Set Maintenance (${durationHours}h)` : "Cleared Maintenance", node.location || nodeId);
            }
            res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
        });
    }

    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        // Also fetch audit logs (last 10)
        let auditLogs = [];
        if (currentUser) {
            const logsSnap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), limit(10)));
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
            .node-row:hover { border-color: #404040; background: #1c1c1c; }
            .nav-blur { background: rgba(10, 10, 10, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid #262626; }
            .uptime-bar { height: 3px; border-radius: 2px; background: #262626; overflow: hidden; }
            .uptime-fill { height: 100%; background: #ffffff; opacity: 0.8; }
            .hidden { display: none !important; }
            .sparkline { stroke: #525252; stroke-width: 1.5; fill: none; }
            ::-webkit-scrollbar { width: 4px; }
            ::-webkit-scrollbar-thumb { background: #262626; border-radius: 10px; }
        </style>
    </head>
    <body class="min-h-screen flex flex-col antialiased">
        <div id="authView" class="fixed inset-0 z-[300] bg-[#0a0a0a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <i class="fas fa-eye text-white text-5xl mb-6"></i>
                <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                <p class="text-neutral-500 text-[9px] font-bold uppercase tracking-[0.4em] mb-12">Security Operation Center</p>
                <div id="loginActions">
                    <button onclick="login()" class="w-full bg-white text-black flex items-center justify-center gap-3 py-4 rounded-xl font-bold shadow-2xl mb-8">
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" class="w-5 h-5">
                        Authorize with Google
                    </button>
                    <button onclick="showBackdoor()" class="text-[9px] text-neutral-600 font-bold uppercase tracking-[0.2em] hover:text-white transition-colors">Emergency Bypass</button>
                    <p id="authError" class="mt-8 text-red-500 text-[10px] font-bold uppercase hidden">Access Denied</p>
                </div>
                <div id="backdoorView" class="hidden bg-neutral-900 border border-neutral-800 p-8 rounded-3xl">
                    <input type="text" id="bdUser" placeholder="ID" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-3">
                    <input type="password" id="bdPass" placeholder="Token" class="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-sm mb-6">
                    <button onclick="tryBackdoor()" class="w-full py-3 bg-white text-black rounded-xl font-bold uppercase text-[10px] mb-4">Confirm</button>
                    <button onclick="hideBackdoor()" class="text-neutral-500 text-[9px] font-bold uppercase tracking-widest">Cancel</button>
                </div>
            </div>
        </div>

        <nav id="adminBar" class="hidden sticky top-0 z-[100] nav-blur px-6 py-3 flex items-center gap-8">
            <div class="flex items-center gap-3 min-w-max">
                <img id="headerLogo" src="" class="w-6 h-6 object-contain grayscale" alt="">
                <h1 id="headerTitle" class="text-sm font-black text-white uppercase tracking-tight"></h1>
            </div>
            <div class="flex-1 max-w-xl relative">
                <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600 text-[10px]"></i>
                <input type="text" id="globalFilter" placeholder="Filter nodes..." class="w-full bg-neutral-900/50 border border-neutral-800 rounded-full pl-10 pr-4 py-1.5 text-xs text-neutral-300">
            </div>
            <div class="flex items-center gap-6 text-[9px] font-black uppercase tracking-widest text-neutral-500">
                <div><span id="statNodes" class="text-white">-</span> Nodes</div>
                <div><span id="statFleet" class="text-white">-</span> Assets</div>
                <div class="text-emerald-500"><span id="statHealth" class="text-white">-%</span> Health</div>
            </div>
            <div class="flex items-center gap-4 ml-auto">
                <button onclick="toggleView('config')" class="text-neutral-500 hover:text-white transition-colors"><i class="fas fa-cog text-sm"></i></button>
                <div class="h-4 w-px bg-neutral-800"></div>
                <span id="adminEmailDisplay" class="text-[9px] font-bold text-neutral-500 uppercase truncate max-w-[120px]">...</span>
                <button onclick="logout()" class="text-neutral-500 hover:text-red-500 transition-colors"><i class="fas fa-sign-out-alt text-sm"></i></button>
            </div>
        </nav>

        <main id="mainApp" class="hidden flex-1 p-6 max-w-7xl mx-auto w-full">
            <div id="dashboardView" class="view-section">
                <div class="flex flex-col gap-2" id="nodeList"></div>
            </div>
            <div id="explorerView" class="view-section hidden">
                <div id="explorerContent"></div>
            </div>
            <div id="configView" class="view-section hidden">
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 lg:col-span-2">
                        <h2 class="text-xs font-black text-white mb-8 uppercase tracking-widest">Global Configuration</h2>
                        <div class="space-y-6">
                            <input type="text" id="cfgTitle" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white" placeholder="Network Alias">
                            <input type="text" id="cfgLogo" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white" placeholder="Logo URL">
                            <input type="text" id="cfgWebhook" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2.5 text-xs text-white" placeholder="Google Chat Webhook">
                            <button onclick="saveConfig()" class="w-full py-3 bg-white text-black rounded-lg font-black uppercase text-[10px]">Apply Settings</button>
                        </div>
                    </div>
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 overflow-hidden">
                        <h2 class="text-xs font-black text-white mb-8 uppercase tracking-widest">Authorized Access</h2>
                        <div id="adminList" class="space-y-2 mb-6 max-h-[200px] overflow-y-auto"></div>
                        <input type="email" id="newAdminEmail" class="w-full bg-black border border-neutral-800 rounded-lg px-4 py-2 text-xs text-white mb-2" placeholder="Add Email">
                        <button onclick="addAdmin()" class="w-full py-2 bg-neutral-800 text-white rounded-lg text-[9px] uppercase font-black">Add Admin</button>
                    </div>
                </div>
                <!-- Audit Log Section -->
                <div class="mt-8 bg-neutral-900 border border-neutral-800 rounded-2xl p-8 text-left">
                    <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Administrative Audit Trail</h2>
                    <div id="auditLogList" class="space-y-2"></div>
                </div>
            </div>
        </main>

        <footer id="mainFooter" class="hidden px-6 py-4 border-t border-neutral-900 text-[8px] font-bold text-neutral-600 flex justify-between items-center bg-[#0a0a0a]">
            <div class="flex items-center gap-6">
                <span>&copy; 2026 OBSERVER INTELLIGENCE</span>
                <span class="text-neutral-800">|</span>
                <span>BUILD: v${VERSION}</span>
                <span class="text-neutral-800">|</span>
                <span class="flex items-center gap-2"><span class="w-1 h-1 rounded-full bg-emerald-500"></span> ENGINE ACTIVE</span>
            </div>
            <div class="flex items-center gap-6 uppercase tracking-widest">
                <a href="#" class="hover:text-white transition-colors">Topology</a>
                <a href="#" class="hover:text-white transition-colors">Vulnerability Report</a>
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
            window.logout = async () => { sessionStorage.removeItem('observer_bypass'); await signOut(auth); location.reload(); };
            window.showBackdoor = () => { document.getElementById('loginActions').classList.add('hidden'); document.getElementById('backdoorView').classList.remove('hidden'); };
            window.hideBackdoor = () => { document.getElementById('loginActions').classList.remove('hidden'); document.getElementById('backdoorView').classList.add('hidden'); };
            window.tryBackdoor = () => { if(document.getElementById('bdUser').value === "${BACKDOOR_USER}" && document.getElementById('bdPass').value === "${BACKDOOR_PASS}") { sessionStorage.setItem('observer_bypass', 'true'); location.reload(); } else alert("Access Denied"); };

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

            function generateSparkline(history, key) {
                if (!history || history.length < 2) return \`<svg width="50" height="20"></svg>\`;
                const max = 100;
                const points = history.map((p, i) => \`\${(i * (50 / 23))},\${20 - (p[key] / max * 20)}\`).join(' ');
                return \`<svg width="50" height="20" class="sparkline"><polyline points="\${points}"/></svg>\`;
            }

            onAuthStateChanged(auth, async (user) => {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                const allowed = currentSettings.allowedAdmins || [];
                if (backdoorActive || (user && allowed.includes(user.email))) {
                    document.getElementById('authView').classList.add('hidden');
                    document.getElementById('mainApp').classList.remove('hidden');
                    document.getElementById('adminBar').classList.remove('hidden');
                    document.getElementById('mainFooter').classList.remove('hidden');
                    document.getElementById('adminEmailDisplay').innerText = backdoorActive ? "ROOT_OVERRIDE" : user.email;
                    initApp(json);
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
                render();
                updateStats();
                if(json.auditLogs) renderAuditLogs(json.auditLogs);
            }

            function renderAuditLogs(logs) {
                const list = document.getElementById('auditLogList');
                list.innerHTML = logs.map(l => \`
                    <div class="flex justify-between items-center text-[8px] bg-black p-2 rounded-lg border border-neutral-800">
                        <span class="text-neutral-500 font-mono">\${new Date(l.timestamp).toLocaleTimeString()}</span>
                        <span class="text-neutral-300 font-black uppercase">\${l.user}</span>
                        <span class="text-neutral-500 uppercase">\${l.action}</span>
                        <span class="text-white font-black truncate max-w-[100px]">\${l.target}</span>
                    </div>
                \`).join('');
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
            }

            window.toggleView = (view) => {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
            };

            window.setMaintenance = async (id, hours) => {
                const adminEmail = document.getElementById('adminEmailDisplay').innerText;
                await fetch('/api/set-maintenance', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nodeId: id, durationHours: hours, adminEmail }) });
                refreshLoop();
            };

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => {
                    const u7 = getUptime(n.uptimeStats, 7);
                    const isMaint = n.maintenanceUntil && n.maintenanceUntil > Date.now();
                    return \`
                    <div class="node-row rounded-xl p-4 flex items-center gap-6 text-left relative">
                        \${isMaint ? '<div class="absolute inset-x-0 bottom-0 h-0.5 bg-amber-500 opacity-50"></div>' : ''}
                        <div class="w-1.5 h-1.5 rounded-full \${n.isOnline ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}"></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-black text-white uppercase tracking-tight truncate">\${n.location || n.hostname} \${isMaint ? '<i class="fas fa-wrench text-[10px] text-amber-500 ml-2"></i>' : ''}</h3>
                            <p class="text-[8px] text-neutral-500 font-bold uppercase tracking-[0.2em]">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-8">
                            <div class="text-center min-w-[50px]">
                                <p class="text-[7px] text-neutral-600 font-bold mb-1 uppercase">Load Trend</p>
                                \${generateSparkline(n.metricsHistory, 'cpu')}
                            </div>
                            <div class="text-center min-w-[50px]">
                                <p class="text-[7px] text-neutral-600 font-bold mb-1 uppercase">RAM Trend</p>
                                \${generateSparkline(n.metricsHistory, 'ram')}
                            </div>
                            <div class="text-center min-w-[40px]">
                                <p class="text-[7px] text-neutral-600 font-bold mb-1 uppercase">7D Health</p>
                                <div class="uptime-bar w-10 mx-auto"><div class="uptime-fill" style="width:\${u7}%"></div></div>
                                <p class="text-[8px] font-bold mt-1">\${u7}%</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="window.setMaintenance('\${n.id}', \${isMaint ? 0 : 2})" class="p-2 bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-600 hover:text-amber-500 transition-colors">
                                <i class="fas \${isMaint ? 'fa-bell' : 'fa-bell-slash'} text-[10px]"></i>
                            </button>
                            <button onclick="window.launchExplorer('\${n.id}')" class="px-4 py-2 bg-neutral-900 hover:bg-white hover:text-black rounded-lg text-[8px] font-black uppercase tracking-widest border border-neutral-800 transition-all">Explore</button>
                        </div>
                    </div>\`;
                }).join("");
            }

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); render(); };
            function renderExplorer() {
                const n = currentData.find(x => x.id === activeNodeId);
                const grid = document.getElementById('explorerContent');
                if(!n) return;
                grid.innerHTML = \`
                    <button onclick="window.toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-white font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 mb-6 flex justify-between items-center text-left">
                        <div>
                            <h2 class="text-2xl font-black text-white uppercase tracking-tighter">\${n.location || n.hostname}</h2>
                            <p class="text-neutral-500 text-[8px] font-bold uppercase tracking-[0.4em] opacity-80">\${n.hostname} Subnet Discovery</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-left">
                        \${(n.scannedDevices || []).map(c => \`
                            <div class="bg-neutral-900 border border-neutral-800 p-4 rounded-xl flex flex-col justify-between">
                                <div>
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-[9px] font-mono text-neutral-500">\${c.ip}</span>
                                        \${c.os_fingerprint ? '<span class="text-[7px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded font-black uppercase">' + c.os_fingerprint + '</span>' : ''}
                                    </div>
                                    <h4 class="text-xs font-black text-white uppercase truncate">\${c.name}</h4>
                                    <p class="text-[8px] text-neutral-600 uppercase font-bold mt-1">\${c.description}</p>
                                </div>
                            </div>
                        \`).join('')}
                    </div>\`;
            }

            function render() {
                const filter = (document.getElementById('globalFilter').value || "").toLowerCase();
                if (activeNodeId) renderExplorer();
                else renderList(filter);
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

            async function saveSettings(extra = {}) {
                const adminEmail = document.getElementById('adminEmailDisplay').innerText;
                const data = { 
                    siteTitle: document.getElementById('cfgTitle').value, 
                    logoUrl: document.getElementById('cfgLogo').value,
                    webhookUrl: document.getElementById('cfgWebhook').value,
                    adminEmail,
                    ...extra 
                };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            }

            window.saveConfig = async () => { await saveSettings(); toggleView('dashboard'); refreshLoop(); };
            document.getElementById("globalFilter").addEventListener("input", render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
