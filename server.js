/**
 * Observer Central - Enterprise Infrastructure Hub v2.6.1
 * * UPTIME ANALYTICS UPDATE:
 * - Global Health: Aggregate fleet uptime % displayed in the persistent header.
 * - Tri-Period Metrics: 24h, 7d, and 30d health stats integrated into Explorer view.
 * - Performance Logic: Maintenance windows continue to be "Excused" from health penalties.
 * - UI Polish: Standardized health cards with period-specific labels.
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
const VERSION = '2.6.1'; 
const PORT = process.env.PORT || 8080; 
const OFFLINE_THRESHOLD = 60000;
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
let cloudUITemplate = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Hub Online. AppID: ${appId}`);
        try {
            // Recover Nodes
            const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
            snapshot.forEach(d => nodes.set(d.id, d.data()));
            
            // Recover Settings
            const setDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'));
            if (setDocRef.exists()) {
                const data = setDocRef.data();
                settings = { ...settings, ...data, allowedAdmins: data.allowedAdmins || [] };
            }

            // UI Hot-Swap Check
            const uiDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'assets', 'ui_template'));
            if (uiDocRef.exists()) {
                cloudUITemplate = uiDocRef.data().html;
                console.log("[SYSTEM] Cloud UI active.");
            }
        } catch(e) { console.error("Sync failed:", e.message); }
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
    } catch (e) {}
}

function processUptime(nodeId, data) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const existing = nodes.get(nodeId) || {};
    let uptimeStats = existing.uptimeStats || { firstSeen: now, buckets: {} };
    if (!uptimeStats.buckets[today]) uptimeStats.buckets[today] = 0;
    
    const lastSeen = existing.lastSeen || now;
    const deltaSeconds = Math.floor((now - lastSeen) / 1000);
    
    // Check if node is in maintenance
    const inMaintenance = existing.maintenanceUntil && existing.maintenanceUntil > now;

    if (deltaSeconds > 0 && deltaSeconds < (OFFLINE_THRESHOLD * 2 / 1000)) {
        // Normal check-in
        uptimeStats.buckets[today] += deltaSeconds;
    } else if (inMaintenance && deltaSeconds > 0) {
        // Maintenance periods are counted as uptime for health stats
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
                if (!data.id) throw new Error("No ID");
                const uptimeStats = processUptime(data.id, data);
                const existing = nodes.get(data.id) || { scannedDevices: [], metricsHistory: [] };
                
                let diskPercent = 0;
                if (data.disk && data.disk.includes('/')) {
                    const parts = data.disk.split('/').map(p => parseFloat(p));
                    if (parts.length === 2 && parts[1] > 0) diskPercent = Math.round(((parts[1] - parts[0]) / parts[1]) * 100);
                }

                const metricsHistory = Array.isArray(existing.metricsHistory) ? existing.metricsHistory : [];
                metricsHistory.push({ cpu: data.cpu || 0, ram: data.ram || 0, disk: diskPercent, ts: Date.now() });
                if (metricsHistory.length > 24) metricsHistory.shift();

                const mergedDevices = Array.isArray(existing.scannedDevices) ? [...existing.scannedDevices] : [];
                (data.scannedDevices || []).forEach(newDev => {
                    const idx = mergedDevices.findIndex(d => d && d.ip === newDev.ip);
                    if (idx > -1) { 
                        mergedDevices[idx] = { ...newDev, isImportant: !!mergedDevices[idx].isImportant, lastSeen: Date.now() }; 
                    } else { 
                        mergedDevices.push({ ...newDev, isImportant: false, firstSeen: Date.now(), lastSeen: Date.now() }); 
                    }
                });

                const rawIp = req.socket.remoteAddress || String(req.headers['x-forwarded-for'] || '127.0.0.1');
                const clientIp = rawIp.replace('::ffff:', '').split(',')[0].trim();
                
                const nodeUpdate = { ...existing, ...data, uptimeStats, metricsHistory, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: clientIp };
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
                if (data.newCloudUI) {
                    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'assets', 'ui_template'), { html: data.newCloudUI, ts: Date.now() });
                    cloudUITemplate = data.newCloudUI;
                }
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { res.writeHead(400); res.end('Error'); }
        });
    }

    else if (url.pathname === '/api/status') {
        const list = Array.from(nodes.values()).map(n => ({
            ...n, isOnline: (Date.now() - (n.lastSeen || 0)) < OFFLINE_THRESHOLD
        }));
        let auditLogs = [];
        if (currentUser) {
            try {
                const logsSnap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), limit(15)));
                logsSnap.forEach(l => auditLogs.push(l.data()));
                auditLogs.sort((a,b) => b.timestamp - a.timestamp);
            } catch(e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes: list, settings, auditLogs }));
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

    else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(cloudUITemplate || generateLocalUI(firebaseConfig));
    }
});

function generateLocalUI(cfg) {
    return `
    <!DOCTYPE html>
    <html class="dark">
    <head>
        <title>Observer Hub v${VERSION}</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap');
            body { font-family: 'Inter', sans-serif; background-color: #1a1a1a; color: #e5e5e5; }
            .node-row { background: #262626; border: 1px solid #333333; transition: all 0.2s ease; }
            .node-row:hover { border-color: #f97316; background: #2d2d2d; }
            .nav-blur { background: rgba(26, 26, 26, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid #333333; }
            .uptime-bar { height: 3px; border-radius: 2px; background: #333333; overflow: hidden; }
            .uptime-fill { height: 100%; background: #f97316; opacity: 0.8; }
            .sparkline { stroke: #404040; stroke-width: 1.5; fill: none; }
            .sparkline-lg { stroke-width: 2.5; fill: none; }
            input:focus { outline: none; border-color: #f97316 !important; }
            .card-metric { background: #262626; border: 1px solid #333333; transition: all 0.3s ease; }
            .btn-primary { background: #f97316; color: #000; }
            .accent-orange { color: #f97316; }
            .risk-badge { background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-size: 7px; font-weight: 900; text-transform: uppercase; }
            .topology-line { stroke: #333333; stroke-width: 1; stroke-dasharray: 4; }
            .topology-node { fill: #262626; stroke: #f97316; stroke-width: 2; }
            .topology-center { fill: #f97316; }
            .maint-row { background: #2d241a; border: 1px solid #b45309; }
        </style>
    </head>
    <body class="min-h-screen flex flex-col antialiased">
        <div id="authView" class="fixed inset-0 z-[300] bg-[#1a1a1a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <i class="fas fa-eye text-[#f97316] text-5xl mb-6"></i>
                <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                <p class="text-neutral-500 text-[9px] font-bold uppercase tracking-[0.4em] mb-12">Security Operation Center</p>
                <div id="loginActions">
                    <button onclick="login()" class="btn-primary w-full flex items-center justify-center gap-3 py-4 rounded-xl font-bold mb-8 transition-transform active:scale-95">Authorize with Google</button>
                    <button onclick="showBackdoor()" class="text-[9px] text-neutral-600 font-bold uppercase tracking-widest hover:text-[#f97316]">Emergency Bypass</button>
                </div>
                <div id="backdoorView" class="hidden bg-[#262626] border border-[#333333] p-8 rounded-3xl text-left">
                    <input type="text" id="bdUser" placeholder="ID" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-xl px-4 py-3 text-sm mb-3 text-white">
                    <input type="password" id="bdPass" placeholder="Token" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-xl px-4 py-3 text-sm mb-6 text-white">
                    <button onclick="tryBackdoor()" class="w-full py-3 btn-primary rounded-xl font-bold uppercase text-[10px] mb-4">Confirm</button>
                    <button onclick="hideBackdoor()" class="w-full text-neutral-500 text-[9px] font-bold uppercase tracking-widest text-center">Cancel</button>
                </div>
            </div>
        </div>

        <nav id="adminBar" class="hidden sticky top-0 z-[100] nav-blur px-6 py-3 flex items-center gap-8">
            <div class="flex items-center gap-3 min-w-max cursor-pointer" onclick="toggleView('dashboard')">
                <img id="headerLogo" src="" class="w-6 h-6 object-contain" alt="">
                <h1 id="headerTitle" class="text-sm font-black text-white uppercase"></h1>
            </div>
            <div class="flex items-center gap-2">
                <button onclick="toggleView('dashboard')" class="text-neutral-500 hover:text-[#f97316] transition-colors p-2"><i class="fas fa-home text-sm"></i></button>
                <button onclick="toggleView('agenda')" class="text-neutral-500 hover:text-[#f97316] transition-colors p-2"><i class="fas fa-calendar-alt text-sm"></i></button>
            </div>
            <div class="flex-1 max-w-sm relative">
                <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600 text-[10px]"></i>
                <input type="text" id="globalFilter" placeholder="Search fleet..." class="w-full bg-neutral-900/50 border border-neutral-800 rounded-full pl-10 pr-4 py-1.5 text-xs text-neutral-300 focus:ring-0">
            </div>
            <div class="flex items-center gap-4 ml-auto">
                <div class="hidden md:flex flex-col items-end">
                    <span class="text-[7px] font-black text-neutral-500 uppercase tracking-widest">Fleet Health</span>
                    <span id="globalHealthDisplay" class="text-xs font-black text-emerald-500">100%</span>
                </div>
                <div class="h-4 w-px bg-neutral-800"></div>
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

            <div id="agendaView" class="view-section hidden">
                <div class="mb-10 text-left">
                    <h2 class="text-3xl font-black text-white uppercase tracking-tighter mb-1">Maintenance Agenda</h2>
                    <p class="text-neutral-500 text-[10px] font-bold uppercase tracking-widest">Silenced Nodes & Active Maintenance Windows</p>
                </div>
                <div class="flex flex-col gap-2" id="agendaList"></div>
            </div>

            <div id="explorerView" class="view-section hidden">
                <div id="explorerContent"></div>
            </div>

            <div id="configView" class="view-section hidden text-left">
                <button onclick="toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-[#f97316] font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                    <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Network Identity</h2>
                        <div class="space-y-4">
                            <input type="text" id="cfgTitle" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Site Alias">
                            <input type="text" id="cfgLogo" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Logo Asset URL">
                            <input type="text" id="cfgWebhook" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Chat Webhook">
                            <button onclick="saveConfig()" class="w-full py-3 btn-primary rounded-lg font-black uppercase text-[10px]">Save Global Settings</button>
                        </div>
                    </div>
                    <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Access Control</h2>
                        <div class="space-y-4">
                            <div class="flex gap-2">
                                <input type="email" id="newAdminEmail" class="flex-1 bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Admin Email">
                                <button onclick="window.addAdmin()" class="px-4 bg-[#333333] text-white rounded-lg text-xs"><i class="fas fa-plus"></i></button>
                            </div>
                            <div id="adminList" class="space-y-2 max-h-[160px] overflow-y-auto pr-2"></div>
                        </div>
                    </div>
                </div>
                <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                    <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Audit Trail</h2>
                    <div id="auditLogList" class="space-y-1 text-[8px] font-mono text-neutral-400"></div>
                </div>
            </div>
        </main>

        <footer id="mainFooter" class="hidden px-6 py-4 border-t border-neutral-900 text-[8px] font-bold text-neutral-600 flex justify-between items-center bg-[#1a1a1a]">
            <div class="flex items-center gap-6">
                <span>&copy; 2026 OBSERVER INTELLIGENCE</span>
                <span class="text-neutral-800">|</span>
                <span>SYSTEM VERSION: v${VERSION}</span>
                <span class="text-neutral-800">|</span>
                <button onclick="toggleView('dashboard')" class="hover:text-white transition-colors uppercase">Hub</button>
            </div>
        </footer>

        <script type="module">
            import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
            import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

            const firebaseConfig = ${JSON.stringify(cfg)};
            const app = initializeApp(firebaseConfig);
            const auth = getAuth(app);
            const provider = new GoogleAuthProvider();

            const RISKY_PORTS = { "21": "FTP", "23": "Telnet", "3389": "RDP", "445": "SMB", "139": "NetBIOS", "5900": "VNC" };

            let currentData = [], currentSettings = {}, activeNodeId = null;
            let backdoorActive = sessionStorage.getItem('observer_bypass') === 'true';

            window.login = () => signInWithPopup(auth, provider).catch(e => alert(e.message));
            window.logout = async () => { sessionStorage.removeItem('observer_bypass'); await signOut(auth); location.reload(); };
            window.showBackdoor = () => { document.getElementById('loginActions').classList.add('hidden'); document.getElementById('backdoorView').classList.remove('hidden'); };
            window.hideBackdoor = () => { document.getElementById('loginActions').classList.remove('hidden'); document.getElementById('backdoorView').classList.add('hidden'); };
            window.tryBackdoor = () => { if(document.getElementById('bdUser').value === "${BACKDOOR_USER}" && document.getElementById('bdPass').value === "${BACKDOOR_PASS}") { sessionStorage.setItem('observer_bypass', 'true'); location.reload(); } else alert("Access Denied"); };

            function getStatusColor(val) { return val >= 95 ? '#10b981' : (val >= 75 ? '#f59e0b' : '#ef4444'); }

            /**
             * Enhanced Uptime Calculation
             * Now accurately accounts for 'Possible' seconds since first seen
             */
            function getUptime(stats, days) {
                if (!stats || !stats.buckets || !stats.firstSeen) return 0;
                const now = new Date();
                let active = 0, possible = 0;
                const regDate = new Date(stats.firstSeen);
                if (isNaN(regDate.getTime())) return 0;

                for (let i = 0; i < days; i++) {
                    const d = new Date(); d.setDate(now.getDate() - i);
                    const ds = d.toISOString().split('T')[0];
                    if (d >= regDate) {
                        const isToday = ds === now.toISOString().split('T')[0];
                        const isFirstDay = ds === regDate.toISOString().split('T')[0];

                        let dayPossible = 86400;
                        if (isToday) {
                            const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0);
                            dayPossible = Math.floor((now - startOfToday) / 1000);
                        } else if (isFirstDay) {
                            const endOfFirstDay = new Date(regDate); endOfFirstDay.setHours(23,59,59,999);
                            dayPossible = Math.floor((endOfFirstDay - regDate) / 1000);
                        }

                        possible += Math.max(0, dayPossible);
                        active += (stats.buckets[ds] || 0);
                    }
                }
                return possible > 0 ? Math.min(Math.round((active / possible) * 100), 100) : 0;
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
                    try {
                        const r = await fetch('/api/status');
                        const j = await r.json();
                        currentData = j.nodes;
                        currentSettings = j.settings;
                        render();
                        if(j.auditLogs) renderAuditLogs(j.auditLogs);
                        updateAdminList();
                    } catch(e) {}
                }, 10000);
                render();
            }

            function render() {
                const activeView = Array.from(document.querySelectorAll('.view-section')).find(s => !s.classList.contains('hidden'))?.id;
                
                // Calculate Global Health (All nodes average for 7 days)
                if (currentData.length > 0) {
                    const avg = Math.round(currentData.reduce((acc, n) => acc + getUptime(n.uptimeStats, 7), 0) / currentData.length);
                    const el = document.getElementById('globalHealthDisplay');
                    el.innerText = \`\${avg}%\`;
                    el.className = avg >= 95 ? 'text-emerald-500 font-black' : (avg >= 75 ? 'text-amber-500 font-black' : 'text-red-500 font-black');
                }

                if (activeView === 'agendaView') {
                    renderAgenda();
                } else if (activeNodeId) {
                    renderExplorer();
                } else {
                    renderList();
                }
            }

            function renderList() {
                const list = document.getElementById('nodeList');
                if (!list) return;
                const filter = (document.getElementById('globalFilter')?.value || "").toLowerCase();
                
                const nodesToRender = currentData.filter(n => ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                if (nodesToRender.length === 0) {
                    list.innerHTML = \`<div class="p-12 text-center bg-[#262626] rounded-2xl border border-dashed border-neutral-700">
                        <p class="text-[10px] font-black uppercase text-neutral-500 tracking-widest">Fleet Monitoring Idle...</p>
                    </div>\`;
                    return;
                }

                list.innerHTML = nodesToRender.map(n => {
                    const isMaint = n.maintenanceUntil && n.maintenanceUntil > Date.now();
                    const u7 = getUptime(n.uptimeStats, 7);
                    const rowClass = isMaint ? 'maint-row' : 'node-row';
                    
                    return \`
                    <div class="\${rowClass} rounded-xl p-4 flex items-center gap-6 text-left relative transition-all duration-300">
                        <div class="w-1.5 h-1.5 rounded-full \${isMaint ? 'bg-amber-500 shadow-[0_0_8px_#f59e0b]' : (n.isOnline ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500')}"></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-black text-white uppercase">\${n.location || n.hostname} \${isMaint ? '<span class="ml-2 text-[8px] text-amber-500">[MAINT]</span>' : ''}</h3>
                            <p class="text-[8px] text-neutral-500 uppercase font-mono">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-6">
                            \${generateSparkline(n.metricsHistory, 'cpu')}
                            <div class="text-center min-w-[40px]">
                                <p class="text-[7px] text-neutral-600 uppercase">Health Score</p>
                                <p class="text-[9px] font-black accent-orange">\${u7}%</p>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.setMaintenance('\${n.id}', \${isMaint ? 0 : 2})" class="p-2 bg-neutral-900 border border-[#444444] rounded-lg text-neutral-600 hover:text-amber-500 transition-colors">
                                <i class="fas \${isMaint ? 'fa-bell' : 'fa-bell-slash'} text-[10px]"></i>
                            </button>
                            <button onclick="window.launchExplorer('\${n.id}')" class="px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-[8px] font-black uppercase hover:border-orange transition-colors">Explorer</button>
                        </div>
                    </div>\`;
                }).join("");
            }

            function renderAgenda() {
                const list = document.getElementById('agendaList');
                if (!list) return;
                const now = Date.now();
                const maintNodes = currentData.filter(n => n.maintenanceUntil && n.maintenanceUntil > now);

                if (maintNodes.length === 0) {
                    list.innerHTML = \`<div class="p-20 text-center bg-[#262626] rounded-3xl border border-dashed border-neutral-800">
                        <i class="fas fa-calendar-check text-neutral-700 text-4xl mb-4"></i>
                        <p class="text-[10px] font-black uppercase text-neutral-500 tracking-widest">No Active Maintenance Windows.</p>
                    </div>\`;
                    return;
                }

                list.innerHTML = maintNodes.map(n => {
                    const timeLeft = Math.max(0, Math.ceil((n.maintenanceUntil - now) / 60000));
                    return \`
                    <div class="maint-row rounded-2xl p-6 flex items-center gap-8 text-left transition-all">
                        <div class="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500">
                            <i class="fas fa-clock text-xl animate-pulse"></i>
                        </div>
                        <div class="flex-1">
                            <h3 class="text-lg font-black text-white uppercase tracking-tighter">\${n.location || n.hostname}</h3>
                            <p class="text-[10px] text-amber-500/80 font-bold uppercase tracking-widest">Silenced // Maintenance Active</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[8px] text-neutral-500 uppercase font-black mb-1">Time Remaining</p>
                            <p class="text-xl font-black text-white">\${timeLeft} <span class="text-[10px] text-neutral-500 uppercase">Min</span></p>
                        </div>
                        <button onclick="window.setMaintenance('\${n.id}', 0)" class="px-6 py-3 bg-amber-600 hover:bg-amber-500 text-black rounded-xl font-black uppercase text-[10px] transition-all">End Session</button>
                    </div>\`;
                }).join("");
            }

            window.toggleView = (view) => {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
                activeNodeId = (view === 'dashboard' || view === 'agenda') ? null : activeNodeId;
                render();
            };

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); render(); };

            function renderTopology(devices) {
                if (!devices || devices.length === 0) return '';
                const width = 600, height = 150, centerX = width / 2, centerY = height / 2, radius = 100;
                let nodesHtml = \`<circle cx="\${centerX}" cy="\${centerY}" r="8" class="topology-center" />\`;
                let linesHtml = '';
                devices.slice(0, 12).forEach((d, i) => {
                    const angle = (i / Math.min(devices.length, 12)) * Math.PI * 2;
                    const x = centerX + radius * Math.cos(angle), y = centerY + radius * Math.sin(angle);
                    linesHtml += \`<line x1="\${centerX}" y1="\${centerY}" x2="\${x}" y2="\${y}" class="topology-line" />\`;
                    nodesHtml += \`<circle cx="\${x}" cy="\${y}" r="4" class="topology-node" />\`;
                });
                return \`<div class="bg-black/20 border border-[#444444] rounded-3xl p-4 mb-8 flex justify-center overflow-hidden"><svg width="\${width}" height="\${height}">\${linesHtml}\${nodesHtml}</svg></div>\`;
            }

            function renderExplorer() {
                const n = currentData.find(x => x.id === activeNodeId);
                const grid = document.getElementById('explorerContent');
                if(!n || !grid) return;
                const latest = n.metricsHistory?.[n.metricsHistory.length - 1] || { cpu: 0, ram: 0, disk: 0 };
                const isMaint = n.maintenanceUntil && n.maintenanceUntil > Date.now();
                
                // Multi-Period Health
                const u24h = getUptime(n.uptimeStats, 1);
                const u7d = getUptime(n.uptimeStats, 7);
                const u30d = getUptime(n.uptimeStats, 30);

                grid.innerHTML = \`
                    <div class="flex items-center justify-between mb-8">
                        <button onclick="window.toggleView('dashboard')" class="text-neutral-500 hover:text-[#f97316] font-bold text-[10px] uppercase tracking-widest transition-colors"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                        \${isMaint ? '<span class="bg-amber-600 text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase">Alerts Silenced</span>' : ''}
                    </div>
                    
                    <div class="mb-10 text-left">
                        <h2 class="text-3xl font-black text-white uppercase tracking-tighter mb-1">\${n.location || n.hostname}</h2>
                        <p class="text-neutral-500 text-[10px] font-bold uppercase tracking-widest">\${n.hostname} // Intelligent Asset Discovery</p>
                    </div>

                    \${renderTopology(n.scannedDevices)}

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden">
                            <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">CPU</span>
                            <div class="text-3xl font-black mt-2" style="color: \${getStatusColor(latest.cpu)}">\${latest.cpu}%</div>
                            <div class="mt-4">\${generateSparkline(n.metricsHistory, 'cpu', 300, 60, 'sparkline-lg')}</div>
                        </div>
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden">
                            <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">RAM</span>
                            <div class="text-3xl font-black mt-2" style="color: \${getStatusColor(latest.ram)}">\${latest.ram}%</div>
                            <div class="mt-4">\${generateSparkline(n.metricsHistory, 'ram', 300, 60, 'sparkline-lg')}</div>
                        </div>
                        <div class="card-metric rounded-3xl p-8 shadow-2xl relative overflow-hidden">
                            <span class="text-[10px] font-black text-neutral-500 uppercase tracking-widest">DISK</span>
                            <div class="text-3xl font-black mt-2" style="color: \${getStatusColor(latest.disk)}">\${latest.disk}%</div>
                            <p class="text-[8px] text-neutral-500 mt-2 font-mono uppercase font-bold">\${n.disk || 'Scanning...'}</p>
                        </div>
                    </div>

                    <div class="mb-8 p-8 bg-neutral-900 border border-neutral-800 rounded-3xl">
                         <h3 class="text-xs font-black text-white uppercase mb-6 tracking-widest">Health History</h3>
                         <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
                            <div class="border-l-2 border-[#333] pl-6">
                                <p class="text-[9px] font-black text-neutral-600 uppercase mb-2">Last 24 Hours</p>
                                <p class="text-2xl font-black" style="color: \${getStatusColor(u24h)}">\${u24h}%</p>
                            </div>
                            <div class="border-l-2 border-[#333] pl-6">
                                <p class="text-[9px] font-black text-neutral-600 uppercase mb-2">Last 7 Days</p>
                                <p class="text-2xl font-black" style="color: \${getStatusColor(u7d)}">\${u7d}%</p>
                            </div>
                            <div class="border-l-2 border-[#333] pl-6">
                                <p class="text-[9px] font-black text-neutral-600 uppercase mb-2">Last 30 Days</p>
                                <p class="text-2xl font-black" style="color: \${getStatusColor(u30d)}">\${u30d}%</p>
                            </div>
                         </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        \${(n.scannedDevices || []).map(c => {
                            let risk = '';
                            Object.keys(RISKY_PORTS).forEach(p => { if(c.description?.includes(p)) risk = \`<div class="risk-badge mb-2">Risk: \${RISKY_PORTS[p]}</div>\`; });
                            return \`<div class="bg-black border border-[#444444] p-4 rounded-xl hover:border-orange transition-all">
                                \${risk}
                                <span class="text-[9px] font-mono text-neutral-500">\${c.ip}</span>
                                <h4 class="text-xs font-black text-white uppercase truncate mt-1">\${c.name || 'Discovered'}</h4>
                            </div>\`;
                        }).join('')}
                    </div>\`;
            }

            window.setMaintenance = async (id, hours) => {
                const adminEmail = document.getElementById('adminEmailDisplay').innerText;
                await fetch('/api/set-maintenance', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nodeId: id, durationHours: hours, adminEmail }) });
                const r = await fetch('/api/status');
                const j = await r.json();
                currentData = j.nodes;
                render();
            };

            function updateBranding() {
                document.getElementById('headerTitle').innerText = currentSettings.siteTitle || "HUB";
                document.getElementById('headerLogo').src = currentSettings.logoUrl || "";
            }

            function renderAuditLogs(logs) {
                const list = document.getElementById('auditLogList');
                if (list) list.innerHTML = logs.map(l => \`<div>[\${new Date(l.timestamp).toLocaleTimeString()}] \${l.action} // \${l.target}</div>\`).join('');
            }

            function updateAdminList() {
                const list = document.getElementById('adminList');
                if (list) list.innerHTML = (currentSettings.allowedAdmins || []).map(email => \`
                    <div class="flex justify-between items-center bg-[#1a1a1a] p-3 rounded-xl border border-[#333333]">
                        <span class="text-[10px] font-bold text-neutral-400 font-mono">\${email}</span>
                        <button onclick="window.removeAdmin('\${email}')" class="text-neutral-700 hover:text-red-500"><i class="fas fa-times"></i></button>
                    </div>\`).join('');
            }

            window.addAdmin = async () => {
                const email = document.getElementById('newAdminEmail').value.trim();
                if(!email) return;
                const admins = [...(currentSettings.allowedAdmins || [])];
                if(!admins.includes(email)) admins.push(email);
                await saveSettings({ allowedAdmins: admins });
                document.getElementById('newAdminEmail').value = "";
            };

            window.removeAdmin = async (email) => {
                const admins = (currentSettings.allowedAdmins || []).filter(e => e !== email);
                await saveSettings({ allowedAdmins: admins });
            };

            async function saveSettings(extra = {}) {
                const data = { 
                    siteTitle: document.getElementById('cfgTitle').value || currentSettings.siteTitle, 
                    logoUrl: document.getElementById('cfgLogo').value || currentSettings.logoUrl,
                    webhookUrl: document.getElementById('cfgWebhook').value || currentSettings.webhookUrl,
                    ...extra 
                };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            }

            window.saveConfig = async () => { await saveSettings(); toggleView('dashboard'); };
            document.getElementById("globalFilter")?.addEventListener("input", render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
