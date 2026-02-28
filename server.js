/**
 * Remote Monitor Server
 * * Features:
 * - REST API for heartbeats & SNMP data.
 * - Persistent Storage: Saves node data to Firestore.
 * - Auto-sync with GitHub on startup.
 * - Advanced Infrastructure Dashboard.
 */

const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

// Firebase Requirements (Standard Node.js Compatibility)
const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } = require('firebase/auth');
const { getFirestore, doc, setDoc, collection, getDocs } = require('firebase/firestore');

// --- CONFIGURATION ---
const PORT = 8080; 
const OFFLINE_THRESHOLD_MS = 60000; 
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';

/**
 * FIREBASE CONFIGURATION (CRITICAL)
 * 1. Go to Firebase Console > Project Settings > General.
 * 2. Scroll to "Your apps" > "Web apps" (Create one if missing).
 * 3. Copy the 'firebaseConfig' object and paste it below.
 */
let firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;

if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY") {
    firebaseConfig = {
        apiKey: "YOUR_API_KEY", // <--- REPLACE THIS
        authDomain: "YOUR_PROJECT.firebaseapp.com",
        projectId: "YOUR_PROJECT_ID",
        storageBucket: "YOUR_PROJECT.appspot.com",
        messagingSenderId: "YOUR_SENDER_ID",
        appId: "YOUR_APP_ID"
    };
}

const appId = typeof __app_id !== 'undefined' ? __app_id : 'observer-default';
const initialToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Initialize Firebase
// We wrap this in a try-block to prevent the server from crashing if keys are still missing
let app, auth, db;
try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (e) {
    console.error("\n[CRITICAL] Firebase failed to initialize. Did you enter your API key?");
}

// State: Local cache for fast dashboard serving
const clients = new Map();
let currentUser = null;

/**
 * Auth Logic - MANDATORY RULE 3
 */
const initAuth = async () => {
    if (!auth) return;
    try {
        if (initialToken) {
            await signInWithCustomToken(auth, initialToken);
        } else {
            await signInAnonymously(auth);
        }
    } catch (err) {
        console.error("\n[AUTH ERROR] Could not sign in to Firebase.");
        console.error("Reason:", err.message);
        console.error("Check that 'Anonymous Authentication' is enabled in your Firebase Console.\n");
    }
};

/**
 * Load all clients from Firestore on startup
 */
async function loadPersistedClients() {
    if (!currentUser || !db) return;
    console.log("[DB] Synchronizing state from cloud...");
    try {
        // Path: /artifacts/{appId}/public/data/{collectionName} - RULE 1
        const nodesCol = collection(db, 'artifacts', appId, 'public', 'data', 'nodes');
        const querySnapshot = await getDocs(nodesCol);
        
        querySnapshot.forEach((doc) => {
            clients.set(doc.id, doc.data());
        });
        
        console.log(`[DB] Successfully restored ${clients.size} nodes from persistence.`);
    } catch (err) {
        console.error("[DB] Failed to load nodes from Firestore:", err.message);
    }
}

// Listen for Auth Changes to trigger data loading
if (auth) {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (user) {
            console.log(`[AUTH] Session active for UID: ${user.uid}`);
            await loadPersistedClients();
        }
    });
}

/**
 * Synchronizes the Server code with the GitHub repository.
 */
function syncWithGithub() {
    console.log(`[GIT] Checking for server updates from ${GITHUB_REPO}...`);
    try {
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
        const output = execSync('git pull origin main', { encoding: 'utf8' });
        if (output.includes('Already up to date')) {
            console.log("[GIT] Server code is up to date.");
        } else {
            console.log("[GIT] Server updates downloaded successfully!");
            // Note: If keys were in this file, git pull might have overwritten them!
        }
    } catch (error) {
        console.log("[GIT] Auto-update skipped (not a git repo).");
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    // API: Receive Heartbeats
    if (req.url === '/api/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const nodeData = {
                    ...data,
                    lastSeen: Date.now(),
                    ip: req.socket.remoteAddress
                };

                // Update local memory
                clients.set(data.id, nodeData);

                // Persist to Firestore - RULE 1
                if (currentUser && db) {
                    const nodeRef = doc(db, 'artifacts', appId, 'public', 'data', 'nodes', data.id);
                    setDoc(nodeRef, nodeData).catch(err => console.error("[DB] Save failed:", err.message));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) {
                res.writeHead(400); res.end('Invalid JSON');
            }
        });
    } 
    
    // UI: Dashboard
    else if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateDashboardHTML());
    }

    // API: Get Status
    else if (req.url === '/api/status' && req.method === 'GET') {
        const clientList = Array.from(clients.values()).map(c => ({
            ...c,
            status: (Date.now() - c.lastSeen) < OFFLINE_THRESHOLD_MS ? 'Online' : 'Offline'
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientList));
    }

    else {
        res.writeHead(404); res.end('Not Found');
    }
});

function generateDashboardHTML() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Observer Central</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            .custom-scrollbar::-webkit-scrollbar { width: 4px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background: #374151; border-radius: 10px; }
        </style>
    </head>
    <body class="bg-[#0f172a] text-gray-100 font-sans p-4 md:p-8">
        <div class="max-w-7xl mx-auto">
            <header class="mb-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 class="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
                        Observer Central
                    </h1>
                    <p class="text-gray-400 mt-1">Infrastructure Persistence Dashboard</p>
                </div>
                <div class="flex items-center gap-3 bg-gray-800/50 p-3 rounded-xl border border-gray-700">
                    <div class="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse"></div>
                    <span class="text-xs font-mono text-gray-300 tracking-tighter uppercase">Cloud Persistence Sync Active</span>
                </div>
            </header>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-8" id="client-grid">
                <!-- Node Cards -->
            </div>
        </div>

        <script>
            function formatUptime(seconds) {
                if (!seconds) return '0s';
                const days = Math.floor(seconds / (3600*24));
                const hrs = Math.floor((seconds % (3600*24)) / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                return \`\${days}d \${hrs}h \${mins}m\`;
            }

            async function refreshStatus() {
                try {
                    const response = await fetch('/api/status');
                    const data = await response.json();
                    const grid = document.getElementById('client-grid');
                    
                    if (data.length === 0) {
                        grid.innerHTML = '<div class="col-span-full text-center py-32 text-gray-600 border-2 border-dashed border-gray-800 rounded-3xl text-xl italic font-medium">Awaiting node check-in...</div>';
                        return;
                    }

                    grid.innerHTML = data.map(node => {
                        const isOnline = node.status === 'Online';
                        const scanCount = node.scannedDevices ? node.scannedDevices.length : 0;
                        
                        return \`
                            <div class="bg-gray-900/40 backdrop-blur-md border \${isOnline ? 'border-gray-800' : 'border-red-900/50'} rounded-3xl p-6 shadow-2xl relative group transition-all duration-500">
                                <div class="flex justify-between items-start mb-8">
                                    <div class="flex items-center gap-4">
                                        <div class="p-3 bg-blue-500/10 rounded-2xl border border-blue-500/20">
                                            <svg class="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg>
                                        </div>
                                        <div>
                                            <h3 class="text-2xl font-bold text-white group-hover:text-blue-400 transition-colors">\${node.hostname}</h3>
                                            <div class="flex items-center gap-2 mt-1">
                                                <span class="text-[10px] bg-gray-800 text-gray-400 px-2 py-0.5 rounded font-mono border border-gray-700">ID: \${node.id}</span>
                                                <span class="text-[10px] text-gray-500 font-mono">\${node.os}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="text-right">
                                        <div class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border \${isOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}">
                                            \${node.status.toUpperCase()}
                                        </div>
                                        <p class="text-[10px] text-gray-500 mt-2 font-mono uppercase tracking-tighter">
                                            \${isOnline ? 'Last Beat: ' + Math.floor((Date.now() - node.lastSeen)/1000) + 's ago' : 'OFFLINE'}
                                        </p>
                                    </div>
                                </div>

                                <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8 text-center">
                                    <div class="bg-black/20 p-4 rounded-2xl border border-gray-800">
                                        <p class="text-[10px] uppercase text-gray-500 font-bold mb-1 tracking-widest">Uptime</p>
                                        <p class="text-blue-400 font-mono font-bold">\${formatUptime(node.uptime)}</p>
                                    </div>
                                    <div class="bg-black/20 p-4 rounded-2xl border border-gray-800">
                                        <p class="text-[10px] uppercase text-gray-500 font-bold mb-1 tracking-widest">Storage</p>
                                        <p class="text-emerald-400 font-mono font-bold text-sm">\${node.disk}</p>
                                    </div>
                                    <div class="bg-black/20 p-4 rounded-2xl border border-gray-800 col-span-2 md:col-span-1">
                                        <p class="text-[10px] uppercase text-gray-500 font-bold mb-1 tracking-widest">Public IP</p>
                                        <p class="text-amber-400 font-mono font-bold text-xs truncate">\${node.ip.replace('::ffff:', '')}</p>
                                    </div>
                                </div>

                                <div class="bg-gray-800/30 rounded-3xl p-5 border border-gray-700/50">
                                    <h4 class="text-xs font-bold uppercase text-gray-400 mb-4 flex items-center gap-2">
                                        <svg class="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                                        Network Inventory (\${scanCount})
                                    </h4>
                                    
                                    <div class="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                                        \${scanCount > 0 
                                            ? node.scannedDevices.map(dev => \`
                                                <div class="bg-gray-900/60 p-3 rounded-xl border border-gray-800 flex flex-col gap-0.5 transition-all hover:bg-gray-900">
                                                    <div class="flex justify-between items-center">
                                                        <span class="text-xs font-mono font-bold text-blue-300">\${dev.ip}</span>
                                                        <span class="text-[9px] font-bold uppercase \${dev.name !== 'Unresponsive' ? 'text-emerald-500' : 'text-gray-600'}">
                                                            \${dev.name !== 'Unresponsive' ? 'SNMP' : 'Down'}
                                                        </span>
                                                    </div>
                                                    <span class="text-[11px] font-medium text-white truncate text-left">\${dev.name}</span>
                                                    <span class="text-[9px] text-gray-500 italic truncate text-left">\${dev.description}</span>
                                                </div>
                                            \`).join('')
                                            : '<div class="text-center py-8 text-gray-600 text-xs italic">Awaiting discovery scan...</div>'
                                        }
                                    </div>
                                </div>
                            </div>
                        \`;
                    }).join('');
                } catch (err) { console.error('Dashboard Error:', err); }
            }

            setInterval(refreshStatus, 3000);
            refreshStatus();
        </script>
    </body>
    </html>
    `;
}

// Startup Sequence
syncWithGithub();
initAuth();

server.listen(PORT, () => {
    console.log(`\n==========================================`);
    console.log(` OBSERVER CENTRAL PERSISTENCE ACTIVE`);
    console.log(` DASHBOARD: http://localhost:${PORT}`);
    console.log(`==========================================\n`);
});
