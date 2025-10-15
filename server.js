// server.js
import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { v4 as uuid } from "uuid";
import PQueue from "p-queue";
import ffmpegPath from "ffmpeg-static";

const execFileP = promisify(execFile);
const app = express();
app.use(cors()); // allow your Base44 app to call from the browser
app.use(express.json({ limit: "25mb" }));

// in-memory job table (simple)
const jobs = new Map();
const queue = new PQueue({ concurrency: 1 });

// health check
app.get("/", (req, res) => res.send("OK"));

// receive JSON and start a render job
app.post("/render", async (req, res) => {
  try {
    const jobId = uuid();
    const payload = req.body;
    // basic validation
    if (!payload?.sourceUrl || !Array.isArray(payload?.clips) || payload.clips.length === 0) {
      return res.status(400).json({ error: "Invalid payload. Need sourceUrl and non-empty clips[]" });
    }

    jobs.set(jobId, { status: "queued", progress: 0, file: null, error: null });
    queue.add(() => processJob(jobId, payload)).catch(err => {
      jobs.set(jobId, { status: "failed", progress: 0, file: null, error: String(err) });
    });

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// check status
app.get("/render/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    downloadUrl: job.file ? `/download/${req.params.jobId}` : null,
    error: job.error
  });
});

// download file when ready
app.get("/download/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.file) return res.status(404).send("Not ready");
  res.download(job.file, "export.mp4");
});

// --------------------- core job logic ---------------------

async function processJob(jobId, cfg) {
  try {
    setJob(jobId, { status: "downloading", progress: 5 });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
    const srcPath = path.join(tmpDir, "source.mp4");
    await download(cfg.sourceUrl, srcPath);

    setJob(jobId, { status: "preparing", progress: 12 });

    // build ffmpeg filter graph to trim each clip and then concat
    const filterParts = [];
    cfg.clips.forEach((c, i) => {
      requireNumber(c.start, "clip.start");
      requireNumber(c.end, "clip.end");
      if (c.end <= c.start) throw new Error("clip.end must be > clip.start");

      filterParts.push(
        `[0:v]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`
      );
    });

    const vInputs = cfg.clips.map((_, i) => `[v${i}]`).join("");
    const aInputs = cfg.clips.map((_, i) => `[a${i}]`).join("");

    // concat N segments
    filterParts.push(`${vInputs}concat=n=${cfg.clips.length}:v=1:a=0[vout]`);
    filterParts.push(`${aInputs}concat=n=${cfg.clips.length}:v=0:a=1[aout]`);

    // optional scale + fps
    const width = cfg.width || 1920;
    const height = cfg.height || 1080;
    const fps = cfg.fps || 30;
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    filterParts.push(`[vout]${scale},fps=${fps}[vfinal]`);

    const outPath = path.join(tmpDir, "out.mp4");
    setJob(jobId, { status: "rendering", progress: 20 });

    const ffArgs = [
      "-y",
      "-i", srcPath,
      "-filter_complex", filterParts.join(";"),
      "-map", "[vfinal]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      outPath
    ];

    await execFileP(ffmpegPath, ffArgs, { maxBuffer: 10 * 1024 * 1024 }); // 10MB buffer

    setJob(jobId, { status: "completed", progress: 100, file: outPath, tmpDir });
  } catch (e) {
    setJob(jobId, { status: "failed", progress: 0, error: String(e) });
  }
}

function setJob(id, patch) {
  const prev = jobs.get(id) || {};
  jobs.set(id, { ...prev, ...patch });
}

async function download(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const ws = createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    r.body.pipe(ws);
    r.body.on("error", reject);
    ws.on("finish", resolve);
  });
}

function requireNumber(v, name) {
  if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`${name} must be a number`);
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Renderer listening on :${PORT}`));
