/**
 * Observer Node Agent v1.6.3
 * Features:
 * - Automated Nmap Service Discovery (-sV)
 * - Robust XML Fingerprinting (Attribute-order independent)
 * - Secure HTTPS communication for Render Cloud
 * - Location Tagging for Node Identification
 * - String Sanitization (Fixes HTTP 400 parsing errors)
 * - Null-safety guards for scan results
 */

const https = require('https');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const VERSION = '1.6.3';
const SERVER_URL = 'https://observer-sxv0.onrender.com/api/heartbeat';
const HEARTBEAT_INTERVAL = 30000;   // 30 seconds for health checks
const SCAN_INTERVAL = 300000;      // 5 minutes for full network scans
const VERBOSE = true; 

// LOCATION TAG: Set this via environment variable 'OBSERVER_LOCATION'
const LOCATION = process.env.OBSERVER_LOCATION || 'Remote Site';

const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

let isScanning = false;
let lastDiscoveryResults = [];

function log(msg, type = 'INFO') {
    if (!VERBOSE) return;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${type}] ${msg}`);
}

/**
 * Sanitizes strings to prevent JSON parsing errors on the server
 */
function clean(str) {
    if (typeof str !== 'string') return "";
    // Remove non-printable characters and extra whitespace
    return str.replace(/[^\x20-\x7E]/g, '').trim();
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
    log(`Starting discovery sweep on ${targetSubnet} (${LOCATION})...`, "NMAP");

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
        
        // Phase 2: Service version detection
        const scanTargets = hosts.slice(0, 10).join(' ');
        exec(`nmap -sV -F --version-light ${scanTargets} -oX -`, (sErr, sStdout) => {
            const results = [];
            
            if (!sErr && sStdout) {
                try {
                    const hostBlocks = sStdout.split('<host ');
                    hostBlocks.shift(); 

                    hostBlocks.forEach(block => {
                        const ip = (block.match(/addr="([0-9.]+)" addrtype="ipv4"/) || block.match(/addr="([0-9.]+)"/))?.[1];
                        if (!ip) return;

                        const serviceName = block.match(/service name="([^"]+)"/)?.[1] || "unknown";
                        const product = block.match(/product="([^"]+)"/)?.[1] || "";
                        const version = block.match(/version="([^"]+)"/)?.[1] || "";
                        const port = block.match(/portid="([0-9]+)"/)?.[1];
                        
                        results.push({
                            ip: clean(ip),
                            name: clean(product ? `${serviceName} (${product})` : serviceName),
                            description: clean((version || port) ? `${version ? 'v'+version : ''} ${port ? 'Port: '+port : ''}` : "Online"),
                            lastSeen: Date.now()
                        });
                    });
                } catch (parseError) {
                    log("Error parsing Nmap XML: " + parseError.message, "ERROR");
                }
            }

            lastDiscoveryResults = results;
            isScanning = false;
            log(`Discovery complete. reporting ${results.length} devices.`, "OK");
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
            disk = `${d.Free || d.FreeGB || '0'}GB Free / ${d.Total || d.SizeGB || '0'}GB`;
        } catch(e) {}

        const payload = JSON.stringify({
            id: clean(clientId),
            version: clean(VERSION),
            location: clean(LOCATION),
            hostname: clean(os.hostname()),
            os: clean(os.type() + ' ' + os.release()),
            uptime: os.uptime(),
            disk: clean(disk),
            scannedDevices: Array.isArray(lastDiscoveryResults) ? lastDiscoveryResults : [],
            timestamp: Date.now()
        });

        const body = Buffer.from(payload, 'utf8');
        const url = new URL(SERVER_URL);
        
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': body.length 
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    log(`Check-in successful (HTTP 200)`, "API");
                } else {
                    log(`Server Error (HTTP ${res.statusCode}): ${resData}`, "WARN");
                }
            });
        });

        req.on('error', (e) => log(`Connection failed: ${e.message}`, "ERROR"));
        req.write(body);
        req.end();
    });
}

// Initialization
console.log("==========================================");
console.log(` OBSERVER AGENT v${VERSION}`);
console.log(` Location: ${LOCATION}`);
console.log(` Node ID: ${clientId}`);
console.log("==========================================");

performDiscovery();
sendHeartbeat();

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
setInterval(performDiscovery, SCAN_INTERVAL);

try {
    execSync('git pull origin main', { stdio: 'ignore' });
} catch(e) {}
