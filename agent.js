/**
 * Production-Ready Test Agent
 * Connects to the secure Render endpoint: https://observer-sxv0.onrender.com
 */
const https = require('https'); // Use HTTPS for the secure cloud endpoint
const os = require('os');
const { execSync } = require('child_process');

const SERVER_URL = 'https://observer-sxv0.onrender.com/api/heartbeat';
const MOCK_CLIENTS = [
    { id: 'lx-prod-01', hostname: 'PROD-NODE-01', os: 'Linux Enterprise', active: true },
    { id: 'lx-prod-02', hostname: 'PROD-NODE-02', os: 'Linux Enterprise', active: true }
];

function getDiskInfo() {
    try {
        if (os.platform() === 'win32') {
            return "C: 120GB Free / 500GB";
        } else {
            const output = execSync("df -h / | tail -1 | awk '{print $4 \" Free / \" $2}'").toString().trim();
            return output || "Unknown Space";
        }
    } catch (e) {
        return "N/A";
    }
}

function sendHeartbeat(client) {
    if (!client.active) return;

    const data = JSON.stringify({
        id: client.id,
        version: '1.5.1', // Match server versioning
        hostname: client.hostname,
        os: client.os,
        uptime: os.uptime(),
        disk: getDiskInfo(),
        scannedDevices: [], // Mocking empty discovery for now
        timestamp: Date.now()
    });

    const url = new URL(SERVER_URL);
    const options = {
        hostname: url.hostname,
        port: 443, // Default for HTTPS
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        },
        timeout: 5000
    };

    const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
            console.log(`[${client.hostname}] Check-in Successful (HTTP 200)`);
        } else {
            console.log(`[${client.hostname}] Warning: Received HTTP ${res.statusCode}`);
        }
    });

    req.on('error', (e) => {
        console.error(`[${client.hostname}] Connection Error: ${e.message}`);
    });

    req.write(data);
    req.end();
}

console.log(`==========================================`);
console.log(` OBSERVER AGENT STARTING`);
console.log(` TARGET: ${SERVER_URL}`);
console.log(`==========================================`);

setInterval(() => {
    MOCK_CLIENTS.forEach(sendHeartbeat);
}, 30000); // Check in every 30 seconds for production

// Initial check-in
MOCK_CLIENTS.forEach(sendHeartbeat);
