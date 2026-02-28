const http = require('http');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// --- CONFIGURATION ---
const SERVER_URL = 'http://localhost:8080/api/heartbeat';
const GITHUB_REPO = 'https://github.com/KilnerIT/observer.git';
const HEARTBEAT_INTERVAL = 30000; 
const SCAN_INTERVAL = 300000;    
const SNMP_COMMUNITY = 'public'; 
const VERBOSE = true; // Enable detailed console output

const clientId = crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 8);

let lastScanResult = [];
let snmpData = {}; 
let isScanning = false;

function log(msg, type = 'INFO') {
    if (!VERBOSE) return;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${type}] ${msg}`);
}

/**
 * Synchronizes the local code with the GitHub repository.
 * Requires 'git' to be installed and the folder to be a cloned repo.
 */
function syncWithGithub() {
    log(`Checking for updates from ${GITHUB_REPO}...`, "GIT");
    try {
        // Check if we are in a git repo
        execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
        
        // Fetch and Pull
        const output = execSync('git pull origin main', { encoding: 'utf8' });
        
        if (output.includes('Already up to date')) {
            log("Code is already at the latest version.", "GIT-OK");
        } else {
            log("Updates downloaded successfully!", "GIT-UPDATE");
            log("Note: You may need to restart the agent to apply logic changes.", "WARN");
        }
    } catch (error) {
        log("Auto-update failed. Ensure 'git' is installed and this is a cloned repository.", "GIT-ERROR");
    }
}

/**
 * Automatically detects the local IPv4 subnet
 */
function getLocalSubnet() {
    log("Checking local network interfaces...", "NET");
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
                log(`Found active interface: ${name} (${iface.address}) -> Target Subnet: ${subnet}`, "NET");
                return subnet;
            }
        }
    }
    log("Could not auto-detect subnet. Defaulting to 192.168.1.0/24", "WARN");
    return '192.168.1.0/24';
}

const TARGET_SUBNET = getLocalSubnet();

/**
 * Performs an SNMP walk on a specific IP
 */
function walkDevice(ip) {
    return new Promise((resolve) => {
        log(`Querying SNMP on ${ip}...`, "SNMP");
        const cmd = `snmpwalk -v 2c -c ${SNMP_COMMUNITY} ${ip} .1.3.6.1.2.1.1.1.0 .1.3.6.1.2.1.1.5.0`;
        
        exec(cmd, { timeout: 5000 }, (error, stdout) => {
            if (error || !stdout) {
                log(`Failed to get SNMP data from ${ip} (Timeout or Disabled)`, "SNMP-FAIL");
                return resolve(null);
            }
            
            const info = {
                ip: ip,
                name: (stdout.match(/sysName.*= STRING: (.*)/) || [])[1] || "Unknown",
                description: (stdout.match(/sysDescr.*= STRING: (.*)/) || [])[1] || "No description"
            };
            log(`Success: Resolved name '${info.name}' for ${ip}`, "SNMP-OK");
            resolve(info);
        });
    });
}

/**
 * Executes an Nmap ping scan and then walks discovered devices
 */
function performNetworkScan() {
    if (isScanning) return;
    isScanning = true;
    
    log(`Starting network discovery sweep on ${TARGET_SUBNET}...`, "SCAN");
    
    exec(`nmap -sn ${TARGET_SUBNET} -oG -`, async (error, stdout) => {
        if (error) {
            isScanning = false;
            log(`Nmap Execution Error: ${error.message}`, "ERROR");
            return;
        }

        const lines = stdout.split('\n');
        const foundIps = [];
        
        lines.forEach(line => {
            if (line.includes('Status: Up')) {
                const match = line.match(/Host: ([0-9.]+)/);
                if (match) foundIps.push(match[1]);
            }
        });

        lastScanResult = foundIps;
        log(`Discovery finished. ${foundIps.length} hosts are 'Up'. Proceeding to SNMP data collection...`, "SCAN");

        const newSnmpData = {};
        for (const ip of foundIps) {
            const data = await walkDevice(ip);
            if (data) {
                newSnmpData[ip] = data;
            }
        }
        
        snmpData = newSnmpData;
        isScanning = false;
        log(`Inventory updated. Found ${Object.keys(snmpData).length} SNMP-capable devices. Next scan in 5 minutes.`, "SCAN");
    });
}

/**
 * Reports system health and scan results to central server
 */
function sendHeartbeat() {
    log("Collecting local system health metrics...", "SYS");
    
    const diskCmd = os.platform() === 'win32' 
        ? 'powershell "Get-PSDrive C | Select-Object @{Name=\'FreeGB\';Expression={[Math]::Round($_.Free/1GB,2)}}, @{Name=\'SizeGB\';Expression={[Math]::Round($_.Used/1GB + $_.Free/1GB,2)}} | ConvertTo-Json"'
        : "df -h / | tail -1 | awk '{print \"{\\\"FreeGB\\\":\\\"\"$4\"\\\",\\\"SizeGB\\\":\\\"\"$2\"\\\"}\"}'";

    exec(diskCmd, (err, stdout) => {
        let diskInfo = "N/A";
        try {
            const disk = JSON.parse(stdout);
            diskInfo = os.platform() === 'win32' 
                ? `${disk.FreeGB}GB Free / ${disk.SizeGB}GB`
                : `${disk.FreeGB} Free / ${disk.SizeGB}`;
            log(`Disk Status: ${diskInfo}`, "SYS");
        } catch(e) {
            log("Error parsing disk output", "WARN");
            diskInfo = "Calculated next cycle...";
        }

        const enrichedDevices = lastScanResult.map(ip => {
            return snmpData[ip] || { ip: ip, name: "Unresponsive", description: "SNMP Disabled" };
        });

        const payload = {
            id: clientId,
            hostname: os.hostname(),
            os: os.type() + ' ' + os.release(),
            uptime: os.uptime(),
            disk: diskInfo,
            scannedDevices: enrichedDevices,
            timestamp: Date.now()
        };

        log(`Pushing heartbeat report to ${SERVER_URL}...`, "API");

        const dataString = JSON.stringify(payload);
        const url = new URL(SERVER_URL);
        const options = {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': Buffer.byteLength(dataString) 
            }
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 200) {
                log(`Server received heartbeat successfully (HTTP ${res.statusCode})`, "API-OK");
            } else {
                log(`Server rejected heartbeat (HTTP ${res.statusCode})`, "API-WARN");
            }
        });

        req.on('error', (e) => {
            log(`Failed to reach dashboard server: ${e.message}`, "API-ERROR");
        });

        req.write(dataString);
        req.end();
    });
}

// Initialization
console.log("==========================================");
console.log(`  NODE AGENT: ${clientId} @ ${os.hostname()}`);
console.log("==========================================");

// Run GitHub update check first
syncWithGithub();

// Start monitoring logic
performNetworkScan();
sendHeartbeat();

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
setInterval(performNetworkScan, SCAN_INTERVAL);
