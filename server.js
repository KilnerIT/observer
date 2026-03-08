/**
 * Observer Central - Enterprise Infrastructure Hub v2.4.1
 * Features:
 * - Maintenance Windows: 2-hour alert silencing with UI toggle and visual indicator
 * - Network Topology: Hub-and-spoke SVG visualization for asset relationships
 * - Vulnerability Analysis: Automated flagging of risky ports (RDP, FTP, Telnet, etc.)
 * - Industrial Palette: Obsidian and Carbon Greys with Safety Orange highlights
 * - Access Control: Persistent MFA/OAuth administrator management
 * - Bugfix: Added safety guards for IP detection and Uptime calculation to prevent GUI crashes
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
const VERSION = '2.4.1'; 
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
                if (!data.id) throw new Error("Missing Node ID");

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

                const clientIp = (req.socket.remoteAddress || req.headers['x-forwarded-for'] || '').replace('::ffff:', '');
                const nodeUpdate = { ...existing, ...data, isArchived: false, uptimeStats, metricsHistory, scannedDevices: mergedDevices, lastSeen: Date.now(), ip: clientIp };
                
                nodes.set(data.id, nodeUpdate);
                if (currentUser) setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id), nodeUpdate);
                res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) { 
                console.error("Heartbeat error:", e.message);
                res.writeHead(400); res.end('Error'); 
            }
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
        let auditLogs = [];
        if (currentUser) {
            try {
                const logsSnap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), limit(15)));
                logsSnap.forEach(l => auditLogs.push(l.data()));
                auditLogs.sort((a,b) => b.timestamp - a.timestamp);
            } catch (e) {
                console.error("Audit recovery failed, continuing with nodes only:", e.message);
            }
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
            body { font-family: 'Inter', sans-serif; background-color: #1a1a1a; color: #e5e5e5; }
            .node-row { background: #262626; border: 1px solid #333333; transition: all 0.2s ease; }
            .node-row:hover { border-color: #f97316; background: #2d2d2d; }
            .nav-blur { background: rgba(26, 26, 26, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid #333333; }
            .uptime-bar { height: 3px; border-radius: 2px; background: #333333; overflow: hidden; }
            .uptime-fill { height: 100%; background: #f97316; opacity: 0.8; }
            .hidden { display: none !important; }
            .sparkline { stroke: #404040; stroke-width: 1.5; fill: none; }
            .sparkline-active { stroke: #f97316; stroke-width: 1.5; fill: none; }
            .sparkline-lg { stroke-width: 2.5; fill: none; }
            input:focus { outline: none; border-color: #f97316 !important; }
            .card-metric { background: #262626; border: 1px solid #333333; transition: border-color 0.3s ease; }
            .btn-primary { background: #f97316; color: #000; }
            .btn-primary:hover { background: #fb923c; }
            .accent-orange { color: #f97316; }
            .border-orange { border-color: #f97316 !important; }
            .risk-badge { background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-size: 7px; font-weight: 900; text-transform: uppercase; }
            .topology-line { stroke: #333333; stroke-width: 1; stroke-dasharray: 4; }
            .topology-node { fill: #262626; stroke: #f97316; stroke-width: 2; }
            .topology-center { fill: #f97316; }
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
                <div id="backdoorView" class="hidden bg-[#262626] border border-[#333333] p-8 rounded-3xl">
                    <input type="text" id="bdUser" placeholder="ID" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-xl px-4 py-3 text-sm mb-3">
                    <input type="password" id="bdPass" placeholder="Token" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-xl px-4 py-3 text-sm mb-6">
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
                <input type="text" id="globalFilter" placeholder="Filter nodes..." class="w-full bg-neutral-900/50 border border-neutral-800 rounded-full pl-10 pr-4 py-1.5 text-xs text-neutral-300 focus:ring-0">
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
            <div id="configView" class="view-section hidden text-left">
                <button onclick="toggleView('dashboard')" class="mb-6 text-neutral-500 hover:text-[#f97316] font-bold text-[10px] uppercase tracking-widest"><i class="fas fa-arrow-left mr-2"></i> Dashboard</button>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                    <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Identity & Alerts</h2>
                        <div class="space-y-4">
                            <input type="text" id="cfgTitle" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Network Alias">
                            <input type="text" id="cfgLogo" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Logo URL">
                            <input type="text" id="cfgWebhook" class="w-full bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="Webhook">
                            <button onclick="saveConfig()" class="w-full py-3 btn-primary rounded-lg font-black uppercase text-[10px]">Apply Global Changes</button>
                        </div>
                    </div>
                    <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                        <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Access Control (MFA)</h2>
                        <div class="space-y-4">
                            <div class="flex gap-2">
                                <input type="email" id="newAdminEmail" class="flex-1 bg-[#1a1a1a] border border-[#333333] rounded-lg px-4 py-2 text-xs text-white" placeholder="user@domain.com">
                                <button onclick="window.addAdmin()" class="px-4 bg-[#333333] hover:bg-[#444] text-white rounded-lg text-xs transition-all"><i class="fas fa-plus"></i></button>
                            </div>
                            <div id="adminList" class="space-y-2 max-h-[160px] overflow-y-auto pr-2"></div>
                        </div>
                    </div>
                </div>
                <div class="bg-[#262626] border border-[#333333] rounded-2xl p-8">
                    <h2 class="text-xs font-black text-white mb-6 uppercase tracking-widest">Administrative Audit Trail</h2>
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

            // Light Vulnerability Database
            const RISKY_PORTS = {
                "21": "FTP (Plaintext Credentials)",
                "23": "Telnet (Unencrypted Admin Access)",
                "3389": "RDP (Potential Remote Execution)",
                "445": "SMB (Vulnerable to EternalBlue)",
                "139": "NetBIOS (Credential Harvest Risk)",
                "5900": "VNC (Remote Control Risk)"
            };

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
                if (!stats || !stats.buckets || !stats.firstSeen) return 0;
                const now = new Date();
                let active = 0, possible = 0;
                const regDate = new Date(stats.firstSeen);
                
                // Safety check for Invalid Date
                if (isNaN(regDate.getTime())) return 0;

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
                if (val >= 95) return '#ef4444';
                if (val >= 75) return '#f59e0b';
                return '#f97316';
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

            function updateAdminList() {
                const list = document.getElementById('adminList');
                if (!list) return;
                list.innerHTML = (currentSettings.allowedAdmins || []).map(email => \`
                    <div class="flex justify-between items-center bg-[#1a1a1a] p-3 rounded-xl border border-[#333333]">
                        <span class="text-[10px] font-bold text-neutral-400 font-mono">\${email}</span>
                        <button onclick="window.removeAdmin('\${email}')" class="text-neutral-700 hover:text-red-500 transition-colors"><i class="fas fa-times"></i></button>
                    </div>
                \`).join('');
            }

            window.setMaintenance = async (id, hours) => {
                const adminEmail = document.getElementById('adminEmailDisplay').innerText;
                await fetch('/api/set-maintenance', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nodeId: id, durationHours: hours, adminEmail }) });
                const r = await fetch('/api/status');
                const j = await r.json();
                currentData = j.nodes;
                render();
            };

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                if (!list) return;
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => {
                    const isMaint = n.maintenanceUntil && n.maintenanceUntil > Date.now();
                    return \`
                    <div class="node-row rounded-xl p-4 flex items-center gap-6 text-left relative">
                        <div class="w-1.5 h-1.5 rounded-full \${n.isOnline ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500'}"></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-black text-white uppercase">\${n.location || n.hostname} \${isMaint ? '<span class="ml-2 text-[8px] text-amber-500 font-black tracking-widest">[MAINTENANCE]</span>' : ''}</h3>
                            <p class="text-[8px] text-neutral-500 uppercase">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-6">
                            \${generateSparkline(n.metricsHistory, 'cpu')}
                            <div class="text-center min-w-[40px]">
                                <p class="text-[7px] text-neutral-600 uppercase">7D Health</p>
                                <p class="text-[9px] font-black accent-orange">\${getUptime(n.uptimeStats, 7)}%</p>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.setMaintenance('\${n.id}', \${isMaint ? 0 : 2})" class="p-2 bg-neutral-900 border border-[#333333] rounded-lg text-neutral-600 hover:text-amber-500 transition-colors">
                                <i class="fas \${isMaint ? 'fa-bell' : 'fa-bell-slash'} text-[10px]"></i>
                            </button>
                            <button onclick="window.launchExplorer('\${n.id}')" class="px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-[8px] font-black uppercase hover:border-orange transition-colors">Explore</button>
                        </div>
                    </div>\`;
                }).join("");
            }

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); renderExplorer(); };

            function renderTopology(devices) {
                if (!devices || devices.length === 0) return '';
                const width = 600;
                const height = 150;
                const centerX = width / 2;
                const centerY = height / 2;
                const radius = 100;
                
                let nodesHtml = \`<circle cx="\${centerX}" cy="\${centerY}" r="8" class="topology-center" />\`;
                let linesHtml = '';

                devices.slice(0, 12).forEach((d, i) => {
                    const angle = (i / Math.min(devices.length, 12)) * Math.PI * 2;
                    const x = centerX + radius * Math.cos(angle);
                    const y = centerY + radius * Math.sin(angle);
                    
                    linesHtml += \`<line x1="\${centerX}" y1="\${centerY}" x2="\${x}" y2="\${y}" class="topology-line" />\`;
                    nodesHtml += \`<circle cx="\${x}" cy="\${y}" r="4" class="topology-node" />\`;
                });

                return \`
                <div class="bg-black/50 border border-[#333333] rounded-3xl p-4 mb-8 flex justify-center overflow-hidden">
                    <svg width="\${width}" height="\${height}" viewBox="0 0 \${width} \${height}">
                        \${linesHtml}
                        \${nodesHtml}
                    </svg>
                </div>\`;
            }

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

                    \${renderTopology(n.scannedDevices)}

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

                    <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 mb-4">
                        <h3 class="text-xs font-black text-white uppercase mb-6 tracking-widest">Network Asset Map</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            \${(n.scannedDevices || []).map(c => {
                                let riskHtml = '';
                                Object.keys(RISKY_PORTS).forEach(port => {
                                    if (c.description && c.description.includes(port)) {
                                        riskHtml = \`<div class="risk-badge mb-2"><i class="fas fa-exclamation-triangle mr-1"></i> Risk: \${RISKY_PORTS[port]}</div>\`;
                                    }
                                });

                                return \`
                                <div class="bg-black border border-neutral-800 p-4 rounded-xl hover:border-orange transition-colors">
                                    \${riskHtml}
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-[9px] font-mono text-neutral-500 font-bold">\${c.ip}</span>
                                        \${c.os_fingerprint ? '<span class="text-[7px] text-neutral-400 font-black uppercase">' + c.os_fingerprint + '</span>' : ''}
                                    </div>
                                    <h4 class="text-xs font-black text-white uppercase truncate mt-1">\${c.name}</h4>
                                    <p class="text-[8px] text-neutral-600 uppercase font-bold mt-1">\${c.description}</p>
                                </div>\`;
                            }).join('')}
                        </div>
                    </div>\`;
            }

            async function saveSettings(extra = {}) {
                const adminEmail = document.getElementById('adminEmailDisplay').innerText;
                const data = { 
                    siteTitle: document.getElementById('cfgTitle').value || currentSettings.siteTitle, 
                    logoUrl: document.getElementById('cfgLogo').value || currentSettings.logoUrl,
                    webhookUrl: document.getElementById('cfgWebhook').value || currentSettings.webhookUrl,
                    adminEmail,
                    ...extra 
                };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            }

            function render() {
                const filter = (document.getElementById('globalFilter').value || "").toLowerCase();
                if (activeNodeId) renderExplorer();
                else renderList(filter);
            }

            window.saveConfig = async () => { await saveSettings(); toggleView('dashboard'); };
            window.addAdmin = async () => {
                const emailInput = document.getElementById('newAdminEmail');
                const email = emailInput.value.trim();
                if(!email) return;
                const admins = [...(currentSettings.allowedAdmins || [])];
                if(!admins.includes(email)) admins.push(email);
                await saveSettings({ allowedAdmins: admins });
                emailInput.value = "";
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                updateAdminList();
            };
            window.removeAdmin = async (email) => {
                const admins = (currentSettings.allowedAdmins || []).filter(e => e !== email);
                await saveSettings({ allowedAdmins: admins });
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                updateAdminList();
            };
            document.getElementById("globalFilter").addEventListener("input", render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
