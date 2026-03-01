/**
 * Observer Central - Enterprise Infrastructure Hub v1.9.2
 * Features:
 * - Dynamic Admin Management: Add/Remove authorized emails via UI
 * - Firestore Persistence: Admin list saved to cloud settings
 * - Emergency Backdoor: Username/Password bypass (Observer / !0bserver!)
 * - Admin Utility Bar: Shows active session type (Google or Emergency)
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
const VERSION = '1.9.2'; 
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
    allowedAdmins: [] // Now managed via Database
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
            const setDocRef = await getDoc(doc(db, 'artifacts', appId, 'public', 'settings', 'config'));
            if (setDocRef.exists()) {
                const data = setDocRef.data();
                settings = { ...settings, ...data, allowedAdmins: data.allowedAdmins || [] };
            }
        } catch(e) { console.error("Recovery failed:", e.message); }
    }
});

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
        </style>
    </head>
    <body class="text-slate-200 min-h-screen antialiased">
        <!-- Auth Screen -->
        <div id="authView" class="fixed inset-0 z-[100] bg-[#0f172a] flex items-center justify-center p-6">
            <div class="max-w-md w-full text-center">
                <div id="loginBranding" class="mb-10">
                    <div class="w-20 h-20 bg-blue-600/10 rounded-3xl flex items-center justify-center mx-auto mb-6 border border-blue-600/20">
                        <i class="fas fa-satellite-dish text-blue-500 text-3xl"></i>
                    </div>
                    <h1 class="text-3xl font-black text-white tracking-tighter uppercase mb-2">Observer Access</h1>
                    <p class="text-slate-500 text-xs font-bold uppercase tracking-widest">Authorized Personnel Only</p>
                </div>
                
                <div id="loginActions">
                    <button onclick="login()" class="btn-google w-full flex items-center justify-center gap-3 py-4 rounded-2xl font-bold shadow-2xl mb-6">
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" class="w-5 h-5">
                        Sign in with Google
                    </button>
                    
                    <button onclick="showBackdoor()" class="text-[10px] text-slate-600 font-bold uppercase tracking-widest hover:text-blue-500 transition-colors">
                        Emergency Access
                    </button>
                    
                    <p id="authError" class="mt-6 text-red-400 text-xs font-bold uppercase hidden">Access Denied</p>
                </div>

                <!-- Backdoor Form -->
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

        <!-- Admin Utility Bar -->
        <div id="adminBar" class="hidden sticky top-0 z-50 bg-slate-900/90 backdrop-blur border-b border-slate-800 px-4 md:px-6 py-2.5 flex justify-between items-center">
            <div class="flex items-center gap-3">
                <span id="adminStatusDot" class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"></span>
                <span id="adminEmailDisplay" class="text-[10px] font-black text-slate-400 uppercase tracking-widest truncate">Admin: Loading...</span>
            </div>
            <button onclick="logout()" class="flex items-center gap-2 px-3 py-1 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all">
                <i class="fas fa-sign-out-alt"></i> Logout
            </button>
        </div>

        <div id="mainApp" class="hidden p-4 md:p-6 max-w-7xl mx-auto text-left">
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
                    <button onclick="toggleView('config')" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all">
                        <i class="fas fa-cog"></i>
                    </button>
                    <input type="text" id="globalFilter" placeholder="Search Fleet..." class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px]">
                </div>
            </header>

            <div id="dashboardView" class="view-section">
                <div class="flex flex-col gap-3" id="nodeList"></div>
            </div>

            <div id="explorerView" class="view-section hidden">
                <div class="flex justify-between items-center mb-6 bg-slate-800/50 p-4 rounded-2xl border border-slate-800">
                    <button onclick="toggleView('dashboard')" class="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold text-xs uppercase tracking-widest">
                        <i class="fas fa-chevron-left text-[10px]"></i> Dashboard
                    </button>
                    <label class="flex items-center gap-2 text-[10px] font-black text-slate-500 cursor-pointer uppercase tracking-widest">
                        <input type="checkbox" id="showOnlyImportant" class="rounded border-slate-800 bg-slate-900 text-amber-500 focus:ring-amber-500">
                        Priority Only
                    </label>
                </div>
                <div id="explorerContent"></div>
            </div>

            <div id="configView" class="view-section hidden">
                <button onclick="toggleView('dashboard')" class="mb-6 text-slate-400 hover:text-white font-bold text-xs uppercase tracking-widest">
                    <i class="fas fa-arrow-left mr-2"></i> Back
                </button>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <!-- Basic Config -->
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-8 shadow-2xl">
                        <h2 class="text-xl font-black text-white mb-6 uppercase">Environment Settings</h2>
                        <div class="space-y-5">
                            <div>
                                <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Interface Title</label>
                                <input type="text" id="cfgTitle" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white">
                            </div>
                            <div>
                                <label class="block text-[10px] font-black text-slate-500 uppercase mb-2">Logo Asset URL</label>
                                <input type="text" id="cfgLogo" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white">
                            </div>
                            <button onclick="saveConfig()" class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold uppercase tracking-widest text-[10px]">
                                Save Changes
                            </button>
                        </div>
                    </div>

                    <!-- Admin Management -->
                    <div class="bg-slate-800 border border-slate-700 rounded-3xl p-8 shadow-2xl">
                        <h2 class="text-xl font-black text-white mb-6 uppercase">Authorized Admins</h2>
                        <div class="space-y-5">
                            <div class="flex gap-2">
                                <input type="email" id="newAdminEmail" placeholder="Email address" class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white outline-none">
                                <button onclick="addAdmin()" class="bg-blue-600 px-4 rounded-xl text-white"><i class="fas fa-plus"></i></button>
                            </div>
                            <div id="adminList" class="space-y-2 max-h-[200px] overflow-y-auto pr-2">
                                <!-- List populated by JS -->
                            </div>
                        </div>
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
            const authError = document.getElementById('authError');
            const authLoading = document.getElementById('authLoading');
            const loginActions = document.getElementById('loginActions');
            const adminEmailDisplay = document.getElementById('adminEmailDisplay');
            const backdoorView = document.getElementById('backdoorView');

            window.showBackdoor = () => { loginActions.classList.add('hidden'); backdoorView.classList.remove('hidden'); };
            window.hideBackdoor = () => { loginActions.classList.remove('hidden'); backdoorView.classList.add('hidden'); };

            window.tryBackdoor = () => {
                const u = document.getElementById('bdUser').value;
                const p = document.getElementById('bdPass').value;
                if (u === "${BACKDOOR_USER}" && p === "${BACKDOOR_PASS}") {
                    sessionStorage.setItem('observer_bypass', 'true');
                    location.reload();
                } else {
                    alert("Invalid Credentials");
                }
            };

            window.login = async () => {
                authError.classList.add('hidden');
                authLoading.classList.remove('hidden');
                loginActions.classList.add('hidden');
                try {
                    await signInWithPopup(auth, provider);
                } catch (e) {
                    authError.innerText = "Login Failed: " + e.message;
                    authError.classList.remove('hidden');
                    authLoading.classList.add('hidden');
                    loginActions.classList.remove('hidden');
                }
            };

            window.logout = () => {
                sessionStorage.removeItem('observer_bypass');
                signOut(auth);
            };

            onAuthStateChanged(auth, async (user) => {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentSettings = json.settings;
                const allowedEmails = currentSettings.allowedAdmins || [];

                if (backdoorActive) {
                    authView.classList.add('hidden');
                    mainApp.classList.remove('hidden');
                    adminBar.classList.remove('hidden');
                    adminBar.classList.replace('bg-slate-900/90', 'bg-amber-900/50');
                    document.getElementById('adminStatusDot').classList.replace('bg-emerald-500', 'bg-amber-500');
                    adminEmailDisplay.innerText = "Emergency Mode: Root Access";
                    initApp(json);
                    return;
                }

                if (user) {
                    if (allowedEmails.includes(user.email)) {
                        authView.classList.add('hidden');
                        mainApp.classList.remove('hidden');
                        adminBar.classList.remove('hidden');
                        adminEmailDisplay.innerText = "Admin: " + user.email;
                        initApp(json);
                    } else {
                        await signOut(auth);
                        authError.innerText = "Access Denied: " + user.email + " unauthorized.";
                        authError.classList.remove('hidden');
                        authLoading.classList.add('hidden');
                        loginActions.classList.remove('hidden');
                    }
                } else {
                    authView.classList.remove('hidden');
                    mainApp.classList.add('hidden');
                    adminBar.classList.add('hidden');
                    authLoading.classList.add('hidden');
                    loginActions.classList.remove('hidden');
                }
            });

            function initApp(json) {
                currentData = json.nodes;
                updateBranding();
                updateStats();
                updateAdminList();
                render();
                setInterval(refreshData, 5000);
            }

            async function refreshData() {
                const res = await fetch('/api/status');
                const json = await res.json();
                currentData = json.nodes;
                currentSettings = json.settings;
                updateStats();
                render();
            }

            window.toggleView = (view) => {
                document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
                document.getElementById(view + 'View').classList.remove('hidden');
            };

            function updateBranding() {
                document.getElementById('headerTitle').innerText = currentSettings.siteTitle;
                document.getElementById('headerLogo').src = currentSettings.logoUrl;
                document.getElementById('cfgTitle').value = currentSettings.siteTitle;
                document.getElementById('cfgLogo').value = currentSettings.logoUrl;
            }

            function updateAdminList() {
                const list = document.getElementById('adminList');
                list.innerHTML = (currentSettings.allowedAdmins || []).map(email => \`
                    <div class="flex justify-between items-center bg-slate-900 p-3 rounded-xl border border-slate-700">
                        <span class="text-xs font-bold">\${email}</span>
                        <button onclick="removeAdmin('\${email}')" class="text-red-500 p-1"><i class="fas fa-times"></i></button>
                    </div>
                \`).join('');
            }

            window.addAdmin = async () => {
                const email = document.getElementById('newAdminEmail').value.trim();
                if (!email) return;
                const admins = currentSettings.allowedAdmins || [];
                if (!admins.includes(email)) admins.push(email);
                await saveSettings({ allowedAdmins: admins });
                document.getElementById('newAdminEmail').value = "";
                refreshData().then(updateAdminList);
            };

            window.removeAdmin = async (email) => {
                const admins = (currentSettings.allowedAdmins || []).filter(e => e !== email);
                await saveSettings({ allowedAdmins: admins });
                refreshData().then(updateAdminList);
            };

            async function saveSettings(extraData = {}) {
                const data = { 
                    siteTitle: document.getElementById('cfgTitle').value, 
                    logoUrl: document.getElementById('cfgLogo').value,
                    ...extraData
                };
                await fetch('/api/update-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            }

            window.saveConfig = async () => { await saveSettings(); toggleView('dashboard'); fetchData(); };

            function updateStats() {
                const totalNodes = currentData.filter(n => !n.isArchived).length;
                const totalFleet = currentData.filter(n => !n.isArchived).reduce((acc, n) => acc + (n.scannedDevices?.length || 0), 0);
                const totalPriority = currentData.filter(n => !n.isArchived).reduce((acc, n) => acc + (n.scannedDevices?.filter(d => d.isImportant).length || 0), 0);
                document.getElementById('statNodes').innerText = totalNodes;
                document.getElementById('statFleet').innerText = totalFleet;
                document.getElementById('statPriority').innerText = totalPriority;
            }

            function render() {
                const filter = (document.getElementById('globalFilter')?.value || "").toLowerCase();
                if (activeNodeId) renderExplorer(filter);
                else renderList(filter);
            }

            function renderList(filter) {
                const list = document.getElementById('nodeList');
                const filtered = currentData.filter(n => !n.isArchived && ((n.hostname || "").toLowerCase().includes(filter) || (n.location || "").toLowerCase().includes(filter)))
                    .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));

                list.innerHTML = filtered.map(n => {
                    const statusColor = n.isOnline ? 'bg-emerald-500' : 'bg-red-500';
                    return \`
                    <div class="node-row rounded-2xl p-4 flex flex-col md:flex-row items-center gap-6">
                        <div class="flex items-center gap-4 min-w-[140px]">
                            <div class="w-3 h-3 rounded-full \${statusColor}"></div>
                            <span class="text-[10px] font-black uppercase tracking-widest \${n.isOnline ? 'text-emerald-400' : 'text-red-400'}">
                                \${n.isOnline ? 'Active' : 'Offline'}
                            </span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-xl font-black text-white uppercase tracking-tighter truncate">\${n.location || n.hostname}</h3>
                            <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest truncate opacity-80">\${n.hostname} // \${n.ip}</p>
                        </div>
                        <div class="flex items-center gap-6">
                            <div class="text-center min-w-[60px]"><p class="text-[8px] text-slate-500 font-black uppercase">Fleet</p><p class="text-sm font-black text-blue-400 font-mono">\${n.scannedDevices.length}</p></div>
                            <div class="text-center min-w-[60px]"><p class="text-[8px] text-slate-500 font-black uppercase">Priority</p><p class="text-sm font-black text-amber-500 font-mono">\${n.scannedDevices.filter(d => d.isImportant).length}</p></div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="window.launchExplorer('\${n.id}')" class="px-5 py-2.5 bg-slate-800 hover:bg-blue-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all">EXPLORE</button>
                        </div>
                    </div>\`;
                }).join("");
            }

            window.launchExplorer = (id) => { activeNodeId = id; toggleView('explorer'); render(); };

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
                        \${devices.map(c => \`
                            <div class="bg-slate-800/80 border border-slate-700 p-5 rounded-2xl shadow-lg relative \${c.isImportant ? 'important-glow' : ''}">
                                <div class="flex justify-between items-start mb-4">
                                    <span class="text-blue-400 font-mono font-black text-[10px]">\${c.ip}</span>
                                    <button onclick="window.toggleImportant('\${node.id}', '\${c.ip}')" class="p-1.5 \${c.isImportant ? 'text-amber-400' : 'text-slate-600 hover:text-white'}"><i class="fas fa-star text-xs"></i></button>
                                </div>
                                <h4 class="text-white font-black mb-1 truncate text-sm uppercase tracking-tight">\${c.name}</h4>
                                <p class="text-[9px] text-slate-500 mb-5 truncate font-bold uppercase tracking-widest opacity-60">\${c.description}</p>
                            </div>\`).join("")}
                    </div>\`;
            }

            window.toggleImportant = async (nodeId, clientIp) => {
                await fetch("/api/toggle-important", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nodeId, clientIp }) });
                refreshData();
            };

            document.getElementById("globalFilter")?.addEventListener("input", render);
            document.getElementById('showOnlyImportant')?.addEventListener('change', render);
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(`Observer Central v${VERSION} running on port ${PORT}`));
