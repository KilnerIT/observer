/**
 * Observer Node Agent v1.5.3
 * Features:
 * - Automated Nmap Service Discovery (-sV)
 * - Hardware Fingerprinting (Ports, Service versions)
 * - Secure HTTPS communication for Render Cloud
 * - Cross-Platform Metric Collection
 */

const https = require('https');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const VERSION = '1.5.3';
const SERVER_URL = 'https://observer-sxv0.onrender.com/api/heartbeat';
const HEARTBEAT_INTERVAL = 30000;   // 30 seconds for health checks
const SCAN_INTERVAL = 300000;      // 5 minutes for full network scans
const VERBOSE = true; 

const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

let isScanning = false;
let lastDiscoveryResults = [];

function log(msg, type = 'INFO') {
    if (!VERBOSE) return;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${type}] ${msg}`);
}

/**
 * Detect local subnet
 */
function getLocalSubnet() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
            }
        }
    }
    return '192.168.1.0/24';
}

/**
 * NMAP FINGERPRINTING
 * Identifies live hosts and their running services
 */
function performDiscovery() {
    if (isScanning) return;
    isScanning = true;

    const targetSubnet = getLocalSubnet();
    log(`Starting discovery sweep on ${targetSubnet}...`, "NMAP");

    // Phase 1: Ping scan to find live hosts
    exec(`nmap -sn ${targetSubnet} -oG -`, (err, stdout) => {
        if (err) {
            isScanning = false;
            return log(`Host discovery failed: ${err.message}`, "ERROR");
        }

        const hosts = stdout.split('\n')
            .filter(l => l.includes('Status: Up'))
            .map(l => {
                const match = l.match(/Host: ([0-9.]+)/);
                return match ? match[1] : null;
            })
            .filter(ip => ip !== null);

        if (hosts.length === 0) {
            log("No live hosts found in subnet.", "NMAP");
            isScanning = false;
            return;
        }

        log(`Found ${hosts.length} live hosts. Fingerprinting services...`, "NMAP");
        
        // Phase 2: Service version detection on top 10 hosts
        const scanTargets = hosts.slice(0, 10).join(' ');
        exec(`nmap -sV -F --version-light ${scanTargets} -oX -`, (sErr, sStdout) => {
            const results = [];
            
            try {
                const hostBlocks = sStdout.split('<host ');
                hostBlocks.shift(); // Remove header

                hostBlocks.forEach(block => {
                    const ipMatch = block.match(/addr="([0-9.]+)"/);
                    const serviceMatch = block.match(/service name="([^"]+)" product="([^"]+)"/);
                    const portMatch = block.match(/portid="([0-9]+)"/);
                    
                    if (ipMatch) {
                        const ip = ipMatch[1];
                        const name = serviceMatch ? `${serviceMatch[1]} (${serviceMatch[2]})` : "Generic Device";
                        const desc = portMatch ? `Open Port: ${portMatch[1]}` : "Online (No Open Ports)";
                        
                        results.push({
                            ip: ip,
                            name: name,
                            description: desc,
                            lastSeen: Date.now()
                        });
                    }
                });
            } catch (parseError) {
                log("Error parsing Nmap XML output", "ERROR");
            }

            lastDiscoveryResults = results;
            isScanning = false;
            log(`Discovery complete. Found ${results.length} fingerprinted devices.`, "OK");
            
            // Immediately send updated data
            sendHeartbeat();
        });
    });
}

/**
 * Reports metrics to Render server
 */
function sendHeartbeat() {
    const diskCmd = os.platform() === 'win32' 
        ? 'powershell "Get-PSDrive C | Select-Object @{Name=\'Free\';Expression={[Math]::Round($_.Free/1GB,2)}}, @{Name=\'Total\';Expression={[Math]::Round($_.Used/1GB + $_.Free/1GB,2)}} | ConvertTo-Json"'
        : "df -h / | tail -1 | awk '{print \"{\\\"Free\\\":\\\"\"$4\"\\\",\\\"Total\\\":\\\"\"$2\"\\\"}\"}'";

    exec(diskCmd, (err, stdout) => {
        let disk = "N/A";
        try {
            const d = JSON.parse(stdout);
            disk = `${d.Free || d.FreeGB}GB Free / ${d.Total || d.SizeGB}`;
        } catch(e) {}

        const payload = JSON.stringify({
            id: clientId,
            version: VERSION,
            hostname: os.hostname(),
            os: os.type() + ' ' + os.release(),
            uptime: os.uptime(),
            disk: disk,
            scannedDevices: lastDiscoveryResults,
            timestamp: Date.now()
        });

        const url = new URL(SERVER_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': Buffer.byteLength(payload) 
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 200) {
                log(`Check-in successful (HTTP ${res.statusCode})`, "API");
            } else {
                log(`Server rejected heartbeat (HTTP ${res.statusCode})`, "WARN");
            }
        });

        req.on('error', (e) => log(`Connection failed: ${e.message}`, "ERROR"));
        req.write(payload);
        req.end();
    });
}

// Initialization
console.log("==========================================");
console.log(` OBSERVER AGENT v${VERSION}`);
console.log(` Node ID: ${clientId}`);
console.log(` Target: ${SERVER_URL}`);
console.log("==========================================");

// Periodic Execution
performDiscovery();
sendHeartbeat();

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
setInterval(performDiscovery, SCAN_INTERVAL);

// Maintenance: Attempt git pull
try {
    execSync('git pull origin main', { stdio: 'ignore' });
} catch(e) {}
