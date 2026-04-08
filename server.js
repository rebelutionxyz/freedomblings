require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'FreedomBLiNGs_v2.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'alive', project: 'FreedomBLiNGs' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FreedomBLiNGs running on port ${PORT}`);
});
