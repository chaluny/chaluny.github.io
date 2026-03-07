require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { convertPdfWithMarker } = require('./services/markerService');
const { generateSectionSummaries } = require('./services/claudeService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// In-memory job store
const jobs = {};

// Multer — save uploads to disk as <jobId>.pdf
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const jobId = uuidv4();
    req.jobId = jobId;
    cb(null, `${jobId}.pdf`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

// ─── POST /api/upload ─────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    const jobId = req.jobId || path.basename(req.file.filename, '.pdf');
    const filePath = req.file.path;
    // Optional flag: generate AI summaries after marker conversion
    const aiSummaries = req.body.aiSummaries === 'true';

    jobs[jobId] = {
      id: jobId,
      filePath,
      aiSummaries,
      status: 'uploaded',
      progress: 0,
      progressStep: 'File received',
      structure: null,
      confirmedStructure: null,
      error: null,
      createdAt: Date.now()
    };

    // Start async processing (fire-and-forget)
    processJob(jobId, filePath, aiSummaries);

    // Quick page-count estimate using pdf-parse (fast, no ML models)
    let pageCount = null;
    let titleGuess = req.file.originalname.replace(/\.pdf$/i, '');
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const pdfData = await pdfParse(buf, { max: 1 });
      pageCount = pdfData.numpages;
      titleGuess = pdfData.info?.Title || titleGuess;
    } catch (_) { /* non-fatal */ }

    jobs[jobId].pageCount = pageCount;
    jobs[jobId].titleGuess = titleGuess;

    res.json({ jobId, pageCount, title: titleGuess });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/job/:id/status ──────────────────────────────────────────────────
app.get('/api/job/:id/status', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, progressStep: job.progressStep, error: job.error });
});

// ─── GET /api/job/:id/structure ───────────────────────────────────────────────
app.get('/api/job/:id/structure', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'analyzed' && job.status !== 'confirmed') {
    return res.status(400).json({ error: 'Structure not ready', status: job.status });
  }
  res.json(job.structure);
});

// ─── POST /api/job/:id/confirm ────────────────────────────────────────────────
app.post('/api/job/:id/confirm', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.confirmedStructure = req.body.structure;
  job.status = 'confirmed';
  res.json({ success: true });
});

// ─── Async job processor ──────────────────────────────────────────────────────
async function processJob(jobId, filePath, aiSummaries) {
  const job = jobs[jobId];
  try {
    job.status = 'processing';
    job.progress = 10;
    job.progressStep = 'Starting Marker conversion...';

    const structure = await convertPdfWithMarker(filePath, jobId, (pct, msg) => {
      job.progress = pct;
      job.progressStep = msg;
    });

    if (aiSummaries) {
      job.progress = 80;
      job.progressStep = 'Generating AI summaries...';
      await generateSectionSummaries(structure, (pct, msg) => {
        job.progress = pct;
        job.progressStep = msg;
      });
    }

    job.structure = structure;
    job.status = 'analyzed';
    job.progress = 100;
    job.progressStep = 'Complete';

  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    job.status = 'error';
    job.error = err.message;
  }
}

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`PDF Converter server running on http://localhost:${PORT}`);
});
