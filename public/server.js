const express = require("express");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MB = Math.min(Math.max(Number(process.env.MAX_VIDEO_MB || 100), 1), 250);
const MAX_BYTES = MAX_MB * 1024 * 1024;
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.MAX_CONVERSION_SECONDS || 120), 30), 180) * 1000;

const allowedHosts = (process.env.ALLOWED_VIDEO_HOSTS || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split(".").map(Number);
    return !(a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return !(v === "::1" || v === "::" || v.startsWith("fc") ||
      v.startsWith("fd") || v.startsWith("fe8") ||
      v.startsWith("fe9") || v.startsWith("fea") ||
      v.startsWith("feb") || v.startsWith("::ffff:"));
  }
  return false;
}

function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Please enter a valid HTTPS video-file URL.");
  }

  if (u.protocol !== "https:" || (u.port && u.port !== "443") ||
      u.username || u.password) {
    throw new Error("Only standard HTTPS video-file URLs are supported.");
  }

  if (!allowedHosts.length || !allowedHosts.includes(u.hostname.toLowerCase())) {
    throw new Error("This video host is not enabled by the site owner yet.");
  }

  return u;
}

function downloadToFile(url, dest, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let addresses;

    try {
      addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some(a => !isPublicIp(a.address))) {
        throw new Error("This host cannot be used for downloads.");
      }
    } catch (e) {
      return reject(e);
    }

    const chosen = addresses[0];

    const req = https.request({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: "GET",
      servername: url.hostname,
      lookup: (_hostname, _opts, cb) =>
        cb(null, chosen.address, chosen.family),
      headers: {
        "User-Agent": "AuthorizedMediaConverter/1.0",
        "Accept": "video/*,application/octet-stream"
      }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("Video host did not return a downloadable file."));
      }

      const type = String(res.headers["content-type"] || "").toLowerCase();

      if (!(type.startsWith("video/") || type === "application/octet-stream")) {
        res.resume();
        return reject(new Error("Use a direct video-file URL."));
      }

      const declared = Number(res.headers["content-length"] || 0);

      if (declared > MAX_BYTES) {
        res.resume();
        return reject(new Error("Video exceeds the " + MAX_MB + " MB limit."));
      }

      let total = 0;
      const out = fs.createWriteStream(dest, { flags: "wx" });

      res.on("data", chunk => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          req.destroy(new Error("Video exceeds the " + MAX_MB + " MB limit."));
          out.destroy();
        }
      });

      res.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      res.on("error", reject);
    });

    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error("Download timed out. Try a smaller video file."))
    );

    req.on("error", reject);
    req.end();
  });
}

const recent = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const entry = recent.get(ip) || { count: 0, start: now };

  if (now - entry.start > 10 * 60 * 1000) {
    entry.count = 0;
    entry.start = now;
  }

  entry.count++;
  recent.set(ip, entry);

  if (entry.count > 5) {
    return res.status(429).json({
      error: "Too many conversions. Please wait a few minutes."
    });
  }

  next();
}

app.post("/api/convert", rateLimit, async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp3-convert-"));
  const inputPath = path.join(dir, "source-video");
  const outputPath = path.join(
    dir,
    "converted-" + crypto.randomBytes(5).toString("hex") + ".mp3"
  );

  let timer;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  };

  res.on("close", cleanup);

  try {
    const url = validateUrl(String(req.body?.url || "").trim());

    await downloadToFile(url, inputPath, TIMEOUT_MS);

    const child = spawn(ffmpegPath, [
      "-nostdin", "-y", "-i", inputPath,
      "-vn", "-codec:a", "libmp3lame",
      "-b:a", "192k", outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] });

    timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);

    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    if (code !== 0 || !fs.existsSync(outputPath)) {
      throw new Error("Could not convert this video. Check that it has an audio track.");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="converted-audio.mp3"');
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outputPath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end("Download failed.");
    });
    stream.on("close", cleanup);
    stream.pipe(res);

  } catch (err) {
    cleanup();
    if (!res.headersSent) {
      res.status(400).json({ error: err.message || "Conversion failed." });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("MP3 converter listening on port " + PORT);
});
                      
