/**
 * Observer Node Agent v2.4.0
 * Features:
 * - Telemetry: Real-time CPU & RAM capture for Hub Sparklines
 * - Storage: Optimized disk reporting for Server-side gauge parsing
 * - Discovery: Advanced Nmap OS Fingerprinting (-O)
 * - Security: Provides port descriptions for Automated Vulnerability Analysis
 * - Requirements: Run with Sudo (Linux) or Administrator (Windows) for Nmap -O
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const VERSION = '2.4.0'; 
// Replace with your actual Render/Server URL
const SERVER_URL = 'https://observer-sxv0.onrender.com/api/heartbeat';
const SCAN_INTERVAL = 300000; // Deep scan every 5 minutes
const HEARTBEAT_INTERVAL = 30000; // Heartbeat every 30 seconds
const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

function log(msg, type = 'INFO') {
    console.log(`[${new Date().toLocaleTimeString()}] [${type}] ${msg}`);
}

/**
 * Metric Collection
 * Captures system load for the Server's sparkline trends
 */
function getPerformanceMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const cpuLoad = Math.min(Math.round((os.loadavg()[0] / os.cpus().length) * 100), 100);
    return { cpu: cpuLoad, ram: ramUsage };
}

/**
 * Discovery Logic
 * Performs Nmap scan with OS detection (-O)
 */
function performDiscovery() {
    log("Identifying local subnet...", "NET");
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

    log(`Scanning ${targetSubnet} with OS Fingerprinting...`, "NMAP");
    
    // -O: OS detection, -sV: Service detection, -F: Fast scan (top 100 ports)
    const sudoPrefix = os.platform() === 'win32' ? '' : 'sudo ';
    exec(`${sudoPrefix}nmap -sn ${targetSubnet} -oG -`, (err, stdout) => {
        if (err) return log(`Ping sweep failed: ${err.message}`, "ERROR");

        const hosts = stdout.split('\n')
            .filter(l => l.includes('Status: Up'))
            .map(l => l.match(/Host: ([0-9.]+)/)?.[1])
            .filter(Boolean);

        if (hosts.length === 0) return log("No active hosts detected.", "NMAP");

        // Scan first 12 hosts to prevent timeout/high load
        const scanTargets = hosts.slice(0, 12).join(' ');
        exec(`${sudoPrefix}nmap -sV -O -F --version-light ${scanTargets} -oX -`, (sErr, sStdout) => {
            const results = [];
            if (sErr || !sStdout) return log("Deep scan failed or returned no data.", "ERROR");

            const hostBlocks = sStdout.split('<host ');
            hostBlocks.shift(); 

            hostBlocks.forEach(block => {
                const ip = (block.match(/addr="([0-9.]+)"/) || [])[1];
                const osMatch = block.match(/osclass vendor="([^"]+)" osfamily="([^"]+)"/);
                const osFingerprint = osMatch ? `${osMatch[1]} ${osMatch[2]}` : "Generic Device";
                
                const serviceMatch = block.match(/service name="([^"]+)"/);
                const portMatch = block.match(/portid="([0-9]+)"/);
                
                if (ip) {
                    results.push({
                        ip,
                        name: serviceMatch ? `Service: ${serviceMatch[1]}` : "Unidentified Device",
                        os_fingerprint: osFingerprint,
                        description: portMatch ? `Active Port: ${portMatch[1]}` : "ICMP Active",
                        lastSeen: Date.now()
                    });
                }
            });

            log(`Discovery complete. reporting ${results.length} assets.`, "API");
            sendPayload(results);
        });
    });
}

function sendPayload(scannedDevices = []) {
    const metrics = getPerformanceMetrics();
    const diskCmd = os.platform() === 'win32' 
        ? 'powershell "Get-PSDrive C | Select-Object @{Name=\'Free\';Expression={[Math]::Round($_.Free/1GB,2)}}, @{Name=\'Total\';Expression={[Math]::Round($_.Used/1GB + $_.Free/1GB,2)}} | ConvertTo-Json"'
        : "df -h / | tail -1 | awk '{print \"{\\\"Free\\\":\\\"\"$4\"\\\",\\\"Total\\\":\\\"\"$2\"\\\"}\"}'";

    exec(diskCmd, (err, stdout) => {
        let disk = "0/100";
        try {
            const d = JSON.parse(stdout);
            // Formatted for Server-side parsing: "FREE / TOTAL"
            disk = `${parseFloat(d.Free)} / ${parseFloat(d.Total)}`;
        } catch(e) {}

        const payload = JSON.stringify({
            id: clientId,
            hostname: os.hostname(),
            os: os.type() + ' ' + os.release(),
            uptime: os.uptime(),
            cpu: metrics.cpu,
            ram: metrics.ram,
            disk: disk,
            scannedDevices: scannedDevices
        });

        const url = new URL(SERVER_URL);
        const requestModule = url.protocol === 'https:' ? https : http;
        
        const req = requestModule.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            if (res.statusCode === 200) log("Heartbeat accepted.", "API");
        });

        req.on('error', (e) => log(`Heartbeat failed: ${e.message}`, "ERROR"));
        req.write(payload);
        req.end();
    });
}

// Initiation
console.log(`\x1b[38;5;208m`); // Set color to Safety Orange
console.log(`==========================================`);
console.log(` OBSERVER NODE AGENT v${VERSION}`);
console.log(` ClientID: ${clientId}`);
console.log(` Status:   INITIALIZING ENGINE...`);
console.log(`==========================================\x1b[0m`);

performDiscovery();
setInterval(performDiscovery, SCAN_INTERVAL);
setInterval(() => sendPayload([]), HEARTBEAT_INTERVAL);

// Self-update awareness
try {
    execSync('git pull origin main', { stdio: 'ignore' });
} catch(e) {}
