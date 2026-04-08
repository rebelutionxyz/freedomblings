require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Regular client for auth
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client bypasses RLS for server operations
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HEALTH ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'alive', project: 'FreedomBLiNGs' });
});

// ── SIGN UP ─────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password, bee_id } = req.body;
  if (!email || !password || !bee_id)
    return res.status(400).json({ error: 'Email, password and Bee ID required' });

  const { data: existing } = await supabaseAdmin
    .from('bees').select('bee_id').eq('bee_id', bee_id.toLowerCase()).single();
  if (existing)
    return res.status(400).json({ error: 'That Bee ID is already taken' });

  const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
  if (authError) return res.status(400).json({ error: authError.message });

  const { error: beeError } = await supabaseAdmin.from('bees').insert({
    id: authData.user.id,
    bee_id: bee_id.toLowerCase(),
    email,
    bling_balance: 0,
    hive_actions: 0
  });
  if (beeError) return res.status(400).json({ error: beeError.message });

  res.json({ success: true, bee_id: bee_id.toLowerCase() });
});

// ── LOGIN ────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data,
