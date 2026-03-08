/**
 * Observer Node Agent v2.0.0
 * Features:
 * - Performance Collection: Captures CPU & RAM utilization
 * - Advanced OS Fingerprinting: Uses 'nmap -O' for deep detection
 * - Automated Maintenance Awareness
 * - Git Synchronization
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const SERVER_URL = 'https://observer-sxv0.onrender.com/api/heartbeat';
const SCAN_INTERVAL = 300000; // 5 minutes
const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

function log(msg, type = 'INFO') {
    console.log(`[${new Date().toLocaleTimeString()}] [${type}] ${msg}`);
}

/**
 * Metric Collection
 * Calculates CPU load and RAM percentage
 */
function getPerformanceMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
    
    // Simplistic CPU load based on loadavg (1-min)
    const cpuLoad = Math.min(Math.round((os.loadavg()[0] / os.cpus().length) * 100), 100);
    
    return { cpu: cpuLoad, ram: ramUsage };
}

/**
 * NMAP FINGERPRINTING LOGIC
 * Includes -O for OS Fingerprinting (Requires root/admin privileges)
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

    log(`Starting deep OS discovery on ${targetSubnet}...`, "NMAP");
    
    // Phase 1: Rapid Ping Sweep
    exec(`nmap -sn ${targetSubnet} -oG -`, (err, stdout) => {
        if (err) return log(`Scan failed: ${err.message}`, "ERROR");

        const hosts = stdout.split('\n')
            .filter(l => l.includes('Status: Up'))
            .map(l => l.match(/Host: ([0-9.]+)/)?.[1])
            .filter(Boolean);

        if (hosts.length === 0) return log("No hosts found.", "NMAP");

        log(`Fingerprinting services and OS for ${hosts.length} targets...`, "NMAP");
        
        // Phase 2: Deep fingerprinting on discovered hosts
        // -O: OS detection
        // -sV: Service detection
        const scanTargets = hosts.slice(0, 10).join(' ');
        
        // Note: Running nmap -O usually requires sudo/Administrative rights
        const sudoPrefix = os.platform() === 'win32' ? '' : 'sudo ';
        exec(`${sudoPrefix}nmap -sV -O -F --version-light ${scanTargets} -oX -`, (sErr, sStdout) => {
            const results = [];
            
            if (sErr || !sStdout) return log(`Deep scan failed: ${sErr ? sErr.message : "No data"}`, "ERROR");

            const hostBlocks = sStdout.split('<host ');
            hostBlocks.shift(); 

            hostBlocks.forEach(block => {
                const ip = (block.match(/addr="([0-9.]+)"/) || [])[1];
                const osMatch = block.match(/osclass vendor="([^"]+)" osfamily="([^"]+)"/);
                const osFingerprint = osMatch ? `${osMatch[1]} ${osMatch[2]}` : null;
                
                const serviceMatch = block.match(/service name="([^"]+)" product="([^"]+)"/);
                const name = serviceMatch ? `${serviceMatch[1]} (${serviceMatch[2]})` : "Generic Device";
                const portMatch = block.match(/portid="([0-9]+)"/);
                
                if (ip) {
                    results.push({
                        ip,
                        name,
                        os_fingerprint: osFingerprint,
                        description: portMatch ? `Port: ${portMatch[1]}` : "Online",
                        lastSeen: Date.now()
                    });
                }
            });

            log(`Deep discovery complete. Reporting ${results.length} endpoints.`, "API");
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
        let disk = "N/A";
        try {
            const d = JSON.parse(stdout);
            disk = `${d.Free}GB / ${d.Total}GB`;
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
        }, (res) => log(`Sync completed. HTTP ${res.statusCode}`, "API"));

        req.on('error', (e) => log(`Sync failed: ${e.message}`, "ERROR"));
        req.write(payload);
        req.end();
    });
}

// Execution
performDiscovery();
setInterval(performDiscovery, SCAN_INTERVAL);
setInterval(() => sendPayload([]), 30000); 

try {
    execSync('git pull origin main', { stdio: 'ignore' });
} catch(e) {}
