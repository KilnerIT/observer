/**
 * Observer Node Agent
 * Features:
 * - Automated Nmap Service Discovery (-sV)
 * - Hardware Fingerprinting (Ports, Service versions)
 * - Automatic Git Synchronization
 * - Cross-Platform Metric Collection
 */

const http = require('http');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const SERVER_URL = 'http://localhost:8080/api/heartbeat';
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const SCAN_INTERVAL = 300000; // 5 minutes
const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

function log(msg, type = 'INFO') {
    console.log(`[${new Date().toLocaleTimeString()}] [${type}] ${msg}`);
}

/**
 * NMAP FINGERPRINTING LOGIC
 * Uses -F (Fast scan) and -sV (Service versions) to identify what is running
 */
function performDiscovery() {
    log("Scanning local network interface...", "NET");
    const interfaces = os.networkInterfaces();
    let targetSubnet = '192.168.1.0/24';

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                targetSubnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
            }
        }
    }

    log(`Starting Nmap fingerprinting on ${targetSubnet}...`, "NMAP");
    
    // -sn: Ping discovery
    // -oG -: Grepable output
    exec(`nmap -sn ${targetSubnet} -oG -`, (err, stdout) => {
        if (err) return log(`Scan failed: ${err.message}`, "ERROR");

        const hosts = stdout.split('\n')
            .filter(l => l.includes('Status: Up'))
            .map(l => l.match(/Host: ([0-9.]+)/)[1]);

        log(`Found ${hosts.length} online hosts. Fingerprinting services...`, "NMAP");
        
        // Pick top 5 active IPs to keep scan time reasonable for demo
        const scanTargets = hosts.slice(0, 10).join(' ');
        
        // -sV: Version detection
        // -F: Fast scan (Top 100 ports)
        // --version-light: Intensity 2 (balance between speed and accuracy)
        exec(`nmap -sV -F --version-light ${scanTargets} -oX -`, (sErr, sStdout) => {
            const results = [];
            
            // Simple XML Parser logic to find <host> entries and <service>
            const hostBlocks = sStdout.split('<host ');
            hostBlocks.shift(); // First part is header

            hostBlocks.forEach(block => {
                const ip = (block.match(/addr="([0-9.]+)"/) || [])[1];
                const serviceMatch = block.match(/service name="([^"]+)" product="([^"]+)"/);
                const name = serviceMatch ? `${serviceMatch[1]} (${serviceMatch[2]})` : "Generic Device";
                const portMatch = block.match(/portid="([0-9]+)"/);
                
                if (ip) {
                    results.push({
                        ip: ip,
                        name: name,
                        description: portMatch ? `Open Port: ${portMatch[1]}` : "Ping response only",
                        lastSeen: Date.now()
                    });
                }
            });

            log(`Discovery complete. reporting ${results.length} fingerprinted devices.`, "API");
            sendPayload(results);
        });
    });
}

function sendPayload(scannedDevices = []) {
    const diskCmd = os.platform() === 'win32' 
        ? 'powershell "Get-PSDrive C | Select-Object @{Name=\'Free\';Expression={[Math]::Round($_.Free/1GB,2)}}, @{Name=\'Total\';Expression={[Math]::Round($_.Used/1GB + $_.Free/1GB,2)}} | ConvertTo-Json"'
        : "df -h / | tail -1 | awk '{print \"{\\\"Free\\\":\\\"\"$4\"\\\",\\\"Total\\\":\\\"\"$2\"\\\"}\"}'";

    exec(diskCmd, (err, stdout) => {
        let disk = "N/A";
        try {
            const d = JSON.parse(stdout);
            disk = `${d.Free}GB Free / ${d.Total}GB`;
        } catch(e) {}

        const payload = JSON.stringify({
            id: clientId,
            hostname: os.hostname(),
            os: os.type() + ' ' + os.release(),
            uptime: os.uptime(),
            disk: disk,
            scannedDevices: scannedDevices
        });

        const url = new URL(SERVER_URL);
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => log(`Heartbeat sent. Server: ${res.statusCode}`, "API"));

        req.on('error', (e) => log(`API Failure: ${e.message}`, "ERROR"));
        req.write(payload);
        req.end();
    });
}

// Maintenance Logic
try {
    log("Checking for Git updates...", "GIT");
    execSync('git pull origin main', { stdio: 'ignore' });
} catch(e) {}

// Execution
performDiscovery();
setInterval(performDiscovery, SCAN_INTERVAL);
setInterval(() => sendPayload([]), 30000); // Send heartbeat without scan every 30s
