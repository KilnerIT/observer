/**
 * Observer Central - Enterprise Infrastructure Hub
 * Features:
 * - Nmap Fingerprint Processing (Service & Version detection)
 * - Persistent Storage (Firestore)
 * - Discovery Explorer (Drill-down per Node)
 * - Client Management (Delete/Prune devices)
 * - Real-time Filtering
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
const PORT = 8080; 
const OFFLINE_THRESHOLD = 60000;
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const CONFIG_PATH = path.join(__dirname, 'config.json');

let firebaseConfig = null;
if (fs.existsSync(CONFIG_PATH)) {
    firebaseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const appId = typeof __app_id !== 'undefined' ? __app_id : 'observer-prod';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const nodes = new Map();
let currentUser = null;

// Auth & Data Recovery
signInAnonymously(auth).catch(e => console.error("[AUTH] Error:", e.message));
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        console.log(`[SYSTEM] Authenticated. Loading persistence...`);
        const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'nodes'));
        snapshot.forEach(d => nodes.set(d.id, d.data()));
        console.log(`[SYSTEM] Restored ${nodes.size} nodes.`);
    }
});

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
            const data = JSON.parse(body);
            const existing = nodes.get(data.id) || { scannedDevices: [] };
            
            // Merge scanned devices logic
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
        });
    }

    // API: Delete Discovered Client
    else if (url.pathname === '/api/delete-client' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
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
        <title>Observer Central</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen font-sans">
        <div id="app" class="p-6 max-w-7xl mx-auto">
            <!-- Header -->
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4">
                <div>
                    <h1 class="text-3xl font-black text-white flex items-center gap-3">
                        <i class="fas fa-satellite-dish text-blue-500"></i> OBSERVER <span class="text-blue-500">CENTRAL</span>
                    </h1>
                    <p class="text-slate-500 text-sm font-medium mt-1">Infrastructure Command & Discovery</p>
                </div>
                <div class="flex items-center gap-4">
                    <input type="text" id="globalFilter" placeholder="Filter nodes/clients..." 
                           class="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64">
                    <div class="px-4 py-2 bg-slate-900 border border-slate-800 rounded-xl flex items-center gap-3">
                        <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">System Live</span>
                    </div>
                </div>
            </div>

            <!-- View Switcher (Router) -->
            <div id="mainView">
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" id="nodeGrid"></div>
            </div>

            <div id="explorerView" class="hidden">
                <button onclick="showMain()" class="mb-6 flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
                    <i class="fas fa-arrow-left text-xs"></i> Back to Fleet
                </button>
                <div id="explorerContent"></div>
            </div>
        </div>

        <script>
            let currentData = [];
            let activeNodeId = null;

            async function fetchData() {
                const res = await fetch('/api/status');
                currentData = await res.json();
                render();
            }

            function render() {
                const filter = document.getElementById('globalFilter').value.toLowerCase();
                
                if (activeNodeId) {
                    renderExplorer(filter);
                } else {
                    renderGrid(filter);
                }
            }

            function renderGrid(filter) {
                const grid = document.getElementById('nodeGrid');
                const filteredNodes = currentData.filter(n => 
                    n.hostname.toLowerCase().includes(filter) || n.id.toLowerCase().includes(filter)
                );

                grid.innerHTML = filteredNodes.map(node => \`
                    <div class="bg-slate-900/50 border \${node.isOnline ? 'border-slate-800' : 'border-red-900/30'} rounded-3xl p-6 hover:shadow-2xl transition-all group">
                        <div class="flex justify-between items-start mb-6">
                            <div class="p-3 bg-blue-500/10 rounded-2xl">
                                <i class="fas fa-server text-blue-400 text-xl"></i>
                            </div>
                            <span class="px-2 py-1 rounded-lg text-[10px] font-black tracking-widest uppercase \${node.isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">
                                \${node.isOnline ? 'Online' : 'Offline'}
                            </span>
                        </div>
                        <h3 class="text-xl font-bold text-white mb-1">\${node.hostname}</h3>
                        <p class="text-xs text-slate-500 font-mono mb-6 uppercase tracking-tighter">Node ID: \${node.id}</p>
                        
                        <div class="grid grid-cols-2 gap-3 mb-6">
                            <div class="bg-black/20 p-3 rounded-xl border border-slate-800/50">
                                <span class="text-[9px] uppercase text-slate-500 block">Discovery</span>
                                <span class="text-sm font-bold text-blue-400">\${node.scannedDevices.length} Clients</span>
                            </div>
                            <div class="bg-black/20 p-3 rounded-xl border border-slate-800/50">
                                <span class="text-[9px] uppercase text-slate-500 block">Storage</span>
                                <span class="text-sm font-bold text-slate-300">\${node.disk.split(' ')[0]}</span>
                            </div>
                        </div>

                        <button onclick="launchExplorer('\${node.id}')" 
                                class="w-full py-3 bg-slate-800 hover:bg-blue-600 text-white rounded-2xl font-bold text-sm transition-all flex items-center justify-center gap-2">
                            Launch Explorer <i class="fas fa-external-link-alt text-[10px]"></i>
                        </button>
                    </div>
                \`).join('');
            }

            function renderExplorer(filter) {
                const node = currentData.find(n => n.id === activeNodeId);
                const content = document.getElementById('explorerContent');
                if (!node) return;

                const clients = (node.scannedDevices || []).filter(c => 
                    c.ip.includes(filter) || (c.name || '').toLowerCase().includes(filter)
                );

                content.innerHTML = \`
                    <div class="bg-slate-900/50 border border-slate-800 rounded-3xl p-8 mb-8">
                        <h2 class="text-2xl font-bold text-white mb-2">\${node.hostname} Discovery Log</h2>
                        <p class="text-slate-500 text-sm">Managing results for subnet \${node.ip}</p>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        \${clients.map(c => {
                            const isOld = (Date.now() - c.lastSeen) > 300000; // 5 mins
                            return \`
                                <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl relative group">
                                    <div class="flex justify-between items-start mb-3">
                                        <span class="text-blue-400 font-mono font-bold text-sm">\${c.ip}</span>
                                        <button onclick="deleteClient('\${node.id}', '\${c.ip}')" class="text-slate-600 hover:text-red-500 transition-colors">
                                            <i class="fas fa-trash-alt text-xs"></i>
                                        </button>
                                    </div>
                                    <h4 class="text-white font-bold mb-1 truncate">\${c.name || 'Generic Device'}</h4>
                                    <p class="text-[10px] text-slate-500 mb-3 truncate">\${c.description || 'No fingerprint data available'}</p>
                                    <div class="flex justify-between items-center text-[9px] font-mono text-slate-600 uppercase pt-3 border-t border-slate-800">
                                        <span>Seen: \${new Date(c.lastSeen).toLocaleTimeString()}</span>
                                        <span class="\${isOld ? 'text-orange-500' : 'text-emerald-500'} font-black">
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
                render();
            }

            function showMain() {
                activeNodeId = null;
                document.getElementById('mainView').classList.remove('hidden');
                document.getElementById('explorerView').classList.add('hidden');
                render();
            }

            async function deleteClient(nodeId, clientIp) {
                if (!confirm(\`Remove \${clientIp} from persistence?\`)) return;
                await fetch('/api/delete-client', {
                    method: 'POST',
                    body: JSON.stringify({ nodeId, clientIp })
                });
                fetchData();
            }

            document.getElementById('globalFilter').addEventListener('input', render);
            setInterval(fetchData, 5000);
            fetchData();
        </script>
    </body>
    </html>
    `;
}

server.listen(PORT, () => console.log(\`Observer Hub @ http://localhost:\${PORT}\`));
