const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { extractPdfContent } = require('./services/pdfService');
const { analyzeStructure } = require('./services/claudeService');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// In-memory job store (production would use Redis/DB)
const jobs = {};

// Multer config for PDF uploads
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
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// POST /api/upload
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    const jobId = req.jobId || path.basename(req.file.filename, '.pdf');
    const filePath = req.file.path;

    jobs[jobId] = {
      id: jobId,
      filePath,
      status: 'uploaded',
      progress: 0,
      progressStep: 'File received',
      structure: null,
      confirmedStructure: null,
      error: null,
      createdAt: Date.now()
    };

    // Start async processing
    processJob(jobId, filePath);

    // Quick initial parse to get page count and title
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer, { max: 1 });
    const pageCount = pdfData.numpages;
    const titleGuess = pdfData.info?.Title || req.file.originalname.replace('.pdf', '');

    jobs[jobId].pageCount = pageCount;
    jobs[jobId].titleGuess = titleGuess;

    res.json({ jobId, pageCount, title: titleGuess });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/job/:id/status
app.get('/api/job/:id/status', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    status: job.status,
    progress: job.progress,
    progressStep: job.progressStep,
    error: job.error
  });
});

// GET /api/job/:id/structure
app.get('/api/job/:id/structure', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'analyzed' && job.status !== 'confirmed') {
    return res.status(400).json({ error: 'Structure not ready yet', status: job.status });
  }
  res.json(job.structure);
});

// POST /api/job/:id/confirm
app.post('/api/job/:id/confirm', async (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  job.confirmedStructure = req.body.structure;
  job.status = 'confirmed';

  res.json({ success: true, message: 'Structure confirmed. Ready to generate report.' });
});

// Async job processor
async function processJob(jobId, filePath) {
  const job = jobs[jobId];
  try {
    job.status = 'processing';
    job.progress = 10;
    job.progressStep = 'Extracting text from PDF...';

    const { text, pageCount, images } = await extractPdfContent(filePath, jobId);

    job.progress = 40;
    job.progressStep = 'Analyzing document structure with AI...';

    const structure = await analyzeStructure(text, images, jobId);

    job.progress = 90;
    job.progressStep = 'Finalizing structure...';

    job.structure = structure;
    job.status = 'analyzed';
    job.progress = 100;
    job.progressStep = 'Analysis complete';

  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    job.status = 'error';
    job.error = err.message;
  }
}

// Serve frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`PDF Converter server running on http://localhost:${PORT}`);
});
