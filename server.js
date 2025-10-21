const express = require("express");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3010;
const HOST = "0.0.0.0";

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.options("*", cors());
app.use(express.json()); // her yerde JSON

const fivemResourcesPath = path.join(process.cwd(), "resources");
const historyFile = path.join("performanceHistory.json");

let performanceHistory = [];
let performanceData = [];

// history yükle
if (fs.existsSync(historyFile)) {
  try {
    performanceHistory = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
  } catch (e) {
    console.error("❌ Failed to parse performance history:", e.message);
    performanceHistory = [];
  }
}

// utils
function formatBytes(bytes) {
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + sizes[i];
}

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
        const st = startCpus[i].times;
        const en = cpu.times;
        const idle = en.idle - st.idle;
        const total = (en.user - st.user) + (en.nice - st.nice) + (en.sys - st.sys) + (en.irq - st.irq) + idle;
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

  const [cpuPercent, ping] = await Promise.all([
    getCpuUsage().catch(() => 0),
    getPing().catch(() => null),
  ]);

  return {
    cpuUsage: `${cpuPercent}% / 100%`,
    ramUsage: `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
    cpuPercent: cpuPercent ?? 0,
    ramPercent: parseFloat(ramPercent),
    ping: ping ?? 0,
  };
}

// basit timeout sarmalayıcı
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// saatlik kayıt (mevcut fonksiyonların aynısı; istersen tut)
async function recordPerformance() {
  const stats = await getSystemPerformance();
  const entry = { time: new Date().toISOString(), cpu: stats.cpuPercent, ram: stats.ramPercent, ping: stats.ping };
  performanceHistory.push(entry);
  fs.writeFileSync(historyFile, JSON.stringify(performanceHistory, null, 2));

  // 6 saatlik ortalama oluştur
  const ONE_HOUR = 60 * 60 * 1000;
  const SIX_HOURS = 6 * ONE_HOUR;
  const now = Date.now();
  const lastSix = performanceHistory.filter(e => now - new Date(e.time).getTime() <= SIX_HOURS);
  const hourlyData = [];

  for (let i = 5; i >= 0; i--) {
    const hourStart = now - (i + 1) * ONE_HOUR;
    const hourEnd = now - i * ONE_HOUR;
    const bucket = lastSix.filter(e => {
      const t = new Date(e.time).getTime();
      return t >= hourStart && t < hourEnd;
    });

    const avg = (key) => (bucket.length ? bucket.reduce((a, c) => a + c[key], 0) / bucket.length : 0);
    hourlyData.push({
      time: new Date(hourEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      cpu: Math.round(avg('cpu')),
      ram: Math.round(avg('ram')),
      ping: Math.round(avg('ping')),
    });
  }
  performanceData = hourlyData;

  // geçmişi temizle
  const recent = performanceHistory.filter(e => now - new Date(e.time).getTime() <= SIX_HOURS);
  if (recent.length !== performanceHistory.length) {
    performanceHistory = recent;
    fs.writeFileSync(historyFile, JSON.stringify(performanceHistory, null, 2));
  }
}
setInterval(recordPerformance, 60 * 60 * 1000);
recordPerformance();

// ---- API ----
app.get("/api/monitor", async (_req, res) => {
  try {
    const stats = await withTimeout(getSystemPerformance(), 3000, {
      cpuUsage: "N/A",
      ramUsage: "N/A",
      cpuPercent: 0,
      ramPercent: 0,
      ping: 0,
    });

    res.json({
      cpu: stats.cpuUsage,
      ram: stats.ramUsage,
      ping: stats.ping,
      performanceData,
    });
  } catch (e) {
    console.error("monitor error:", e);
    res.json({ cpu: "N/A", ram: "N/A", ping: 0, performanceData: [] });
  }
});

app.post("/api/install", (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: "Please provide name and url." });

  const resourcePath = path.join(fivemResourcesPath, name);
  if (fs.existsSync(resourcePath)) fs.rmSync(resourcePath, { recursive: true, force: true });

  exec(`git clone ${url} "${resourcePath}"`, (err, _stdout, stderr) => {
    if (err) {
      console.error("❌ Install Error:", stderr);
      return res.status(500).json({ error: "Resource could not be installed." });
    }
    res.json({ success: true, message: `✅ Resource '${name}' installed successfully.` });
  });
});


app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`[✅] API ready on http://${HOST}:${PORT}`);
});
