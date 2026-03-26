require('express-async-errors');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3001;

// Init DB
initDb();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || ['http://localhost:5173', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/styles', require('./routes/styles'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/render', require('./routes/render'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/projects', require('./routes/transcribe'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
const fs = require('fs');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 HNTR Automation Server running on http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/health`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}\n`);
});
