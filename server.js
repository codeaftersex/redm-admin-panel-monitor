const express = require("express");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3010;
const fivemResourcesPath = path.join(process.cwd(), "resources");
const historyFile = path.join("performanceHistory.json");

let performanceHistory = [];
let performanceData = [];

// Load previous history if exists
if (fs.existsSync(historyFile)) {
    try {
        performanceHistory = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
    } catch (e) {
        console.error("❌ Failed to parse performance history:", e.message);
        performanceHistory = [];
    }
}

// Format bytes to human readable
function formatBytes(bytes) {
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0B";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + sizes[i];
}

// Get ping
function getPing() {
    return new Promise((resolve) => {
        const platform = os.platform();
        const cmd = platform === "win32" ? "ping -n 1 8.8.8.8" : "ping -c 1 8.8.8.8";
        exec(cmd, (err, stdout) => {
            if (err) return resolve(null);
            const regex = platform === "win32" ? /time[=<]([\d.]+)ms/ : /time=([\d.]+) ms/;
            const match = stdout.match(regex);
            resolve(match ? parseFloat(match[1]) : null);
        });
    });
}


function getCpuUsage() {
    return new Promise((resolve) => {
        const startCpus = os.cpus();

        setTimeout(() => {
            const endCpus = os.cpus();
            let totalIdle = 0;
            let totalTick = 0;

            endCpus.forEach((cpu, i) => {
                const startCpu = startCpus[i];
                const startTimes = startCpu.times;
                const endTimes = cpu.times;

                // Calculate the delta for each mode
                const idle = endTimes.idle - startTimes.idle;
                const total = (endTimes.user - startTimes.user) + 
                              (endTimes.nice - startTimes.nice) + 
                              (endTimes.sys - startTimes.sys) + 
                              (endTimes.irq - startTimes.irq) + 
                              idle;

                totalIdle += idle;
                totalTick += total;
            });

            const usage = 100 - (totalIdle / totalTick) * 100;
            resolve(parseFloat(usage.toFixed(2)));
        }, 1000);
    });
}

async function getSystemPerformance() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercent = ((usedMem / totalMem) * 100).toFixed(2);

    // Yeni fonksiyonları burada kullanıyoruz
    const cpuPercent = await getCpuUsage();
    const ping = await getPing();

    return {
        cpuUsage: `${cpuPercent}% / 100%`,
        ramUsage: `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
        cpuPercent: cpuPercent,
        ramPercent: parseFloat(ramPercent),
        ping: ping ?? 0
    };
}


// Save history to JSON file
function saveHistory() {
    fs.writeFileSync(historyFile, JSON.stringify(performanceHistory, null, 2));
}

// Record performance every 1 minute
async function recordPerformance() {
    const stats = await getSystemPerformance();
    const entry = {
        time: new Date().toISOString(),
        cpu: stats.cpuPercent,
        ram: stats.ramPercent,
        ping: stats.ping
    };

    performanceHistory.push(entry);
    saveHistory();

    // Calculate 1-hour averages for graph
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const lastHour = performanceHistory.filter(e => now - new Date(e.time).getTime() <= ONE_HOUR);

    if (lastHour.length > 0) {
        const avgCpu = lastHour.reduce((acc, cur) => acc + cur.cpu, 0) / lastHour.length;
        const avgRam = lastHour.reduce((acc, cur) => acc + cur.ram, 0) / lastHour.length;
        const avgPing = lastHour.reduce((acc, cur) => acc + cur.ping, 0) / lastHour.length;

        // Keep only a reasonable amount of data for the graph (e.g., last 24 hours)
        if (performanceData.length > 24) {
            performanceData.shift(); 
        }

        performanceData.push({
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            cpu: Math.round(avgCpu),
            ram: Math.round(avgRam),
            ping: Math.round(avgPing),
        });

        // Cleanup old history that is older than an hour to save space
        const recentHistory = performanceHistory.filter(e => now - new Date(e.time).getTime() <= ONE_HOUR);
        if (performanceHistory.length !== recentHistory.length) {
            performanceHistory = recentHistory;
            saveHistory();
        }
    }
}


setInterval(recordPerformance, 60 * 1000 * 30); // 30 minute
recordPerformance(); // Run once on start

// ==================== MONITOR API ====================
app.get("/api/monitor", async (_req, res) => { // async olarak değiştirildi
    const stats = await getSystemPerformance(); // await eklendi
    res.json({
        cpu: stats?.cpuUsage ?? "N/A",
        ram: stats?.ramUsage ?? "N/A",
        ping: stats?.ping ?? 0,
        performanceData // averages for graph
    });
});

// ==================== INSTALL RESOURCE API ====================
app.post("/api/install", express.json(), (req, res) => {
    const { name, url } = req.body;

    if (!name || !url) {
        return res.status(400).json({ error: "Please provide name and url." });
    }

    const resourcePath = path.join(fivemResourcesPath, name);

    if (fs.existsSync(resourcePath)) {
        fs.rmSync(resourcePath, { recursive: true, force: true });
    }

    exec(`git clone ${url} "${resourcePath}"`, (err, stdout, stderr) => {
        if (err) {
            console.error("❌ Install Error:", stderr);
            return res.status(500).json({ error: "Resource could not be installed." });
        }

        res.json({
            success: true,
            message: `✅ Resource '${name}' installed successfully.`,
        });
    });
});

app.listen(PORT, () => {
    console.log(`[✅] Monitor & Installer API ready`);
});