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
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  const { data: bee } = await supabaseAdmin
    .from('bees').select('*').eq('id', data.user.id).single();

  res.json({ success: true, token: data.session.access_token, bee });
});

// ── BALANCE ──────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { data: bee } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();

  const { data: mintData } = await supabaseAdmin
    .from('system_state').select('value').eq('key', 'mint_price').single();

  res.json({ bee, mint_price: mintData?.value || 1.001 });
});

// ── SEND ─────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { to_bee_id, amount, memo } = req.body;
  if (!to_bee_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'Invalid send request' });

  const { data: sender } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();
  if (sender.bling_balance < amount)
    return res.status(400).json({ error: 'Insufficient BLiNG!' });

  const { data: receiver } = await supabaseAdmin
    .from('bees').select('*').eq('bee_id', to_bee_id.toLowerCase()).single();
  if (!receiver)
    return res.status(400).json({ error: 'Bee ID not found' });

  await supabaseAdmin.from('bees')
    .update({ bling_balance: sender.bling_balance - amount }).eq('id', sender.id);
  await supabaseAdmin.from('bees')
    .update({ bling_balance: receiver.bling_balance + amount }).eq('id', receiver.id);

  await supabaseAdmin.from('transactions').insert([
    { bee_id: sender.id,   type: 'sent',     amount: -amount, counterparty: to_bee_id, memo },
    { bee_id: receiver.id, type: 'received', amount:  amount, counterparty: sender.bee_id, memo }
  ]);

  res.json({ success: true, new_balance: sender.bling_balance - amount });
});

// ── TRANSACTIONS ─────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { data: txns } = await supabaseAdmin
    .from('transactions').select('*').eq('bee_id', user.id)
    .order('created_at', { ascending: false }).limit(20);

  res.json({ transactions: txns });
});

// ── ORDER BOOK ───────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const { data: orders } = await supabaseAdmin
    .from('orders').select('*').eq('status', 'open')
    .order('price', { ascending: false });

  const asks = (orders || []).filter(o => o.side === 'sell');
  const bids = (orders || []).filter(o => o.side === 'buy');

  const { data: mintData } = await supabaseAdmin
    .from('system_state').select('value').eq('key', 'mint_price').single();

  res.json({ asks, bids, mint_price: mintData?.value || 1.001 });
});

// ── PLACE ORDER ──────────────────────────────────
app.post('/api/orders', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { side, price, amount } = req.body;

  const { data: mintData } = await supabaseAdmin
    .from('system_state').select('value').eq('key', 'mint_price').single();
  const mintPrice = mintData?.value || 1.001;

  if (side === 'sell' && price > mintPrice)
    return res.status(400).json({ error: `Max sell price is ${mintPrice} BLiNG!` });

  const { data: bee } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();
  if (side === 'sell' && bee.bling_balance < amount)
    return res.status(400).json({ error: 'Insufficient BLiNG!' });

  const { data: order } = await supabaseAdmin
    .from('orders').insert({ bee_id: user.id, side, price, amount, status: 'open' })
    .select().single();

  await matchOrders(order, bee, mintPrice);

  res.json({ success: true, order });
});

// ── MATCHING ENGINE ──────────────────────────────
async function matchOrders(newOrder, bee, mintPrice) {
  if (newOrder.side === 'sell') {
    const { data: matches } = await supabaseAdmin
      .from('orders').select('*, bees(*)').eq('side', 'buy')
      .gte('price', newOrder.price).eq('status', 'open')
      .order('price', { ascending: false }).limit(1);

    if (matches?.length > 0) {
      const buyOrder = matches[0];
      const fillAmount = Math.min(newOrder.amount, buyOrder.amount);
      const fee = fillAmount * 0.01;

      await supabaseAdmin.from('bees')
        .update({ bling_balance: buyOrder.bees.bling_balance + fillAmount })
        .eq('id', buyOrder.bee_id);
      await supabaseAdmin.from('bees')
        .update({ bling_balance: bee.bling_balance + (fillAmount * newOrder.price) - fee })
        .eq('id', newOrder.bee_id);
      await supabaseAdmin.from('orders')
        .update({ status: 'filled' }).in('id', [newOrder.id, buyOrder.id]);
      await supabaseAdmin.from('transactions').insert([
        { bee_id: newOrder.bee_id,  type: 'sold',   amount: (fillAmount * newOrder.price) - fee, counterparty: buyOrder.bees.bee_id },
        { bee_id: buyOrder.bee_id,  type: 'bought', amount: fillAmount, counterparty: bee.bee_id }
      ]);
    }
  }

  if (newOrder.side === 'buy') {
    const { data: matches } = await supabaseAdmin
      .from('orders').select('*, bees(*)').eq('side', 'sell')
      .lte('price', newOrder.price).eq('status', 'open')
      .order('price', { ascending: true }).limit(1);

    if (matches?.length > 0) {
      const sellOrder = matches[0];
      const fillAmount = Math.min(newOrder.amount, sellOrder.amount);
      const fee = fillAmount * 0.01;

      await supabaseAdmin.from('bees')
        .update({ bling_balance: bee.bling_balance + fillAmount })
        .eq('id', newOrder.bee_id);
      await supabaseAdmin.from('bees')
        .update({ bling_balance: sellOrder.bees.bling_balance + (fillAmount * sellOrder.price) - fee })
        .eq('id', sellOrder.bee_id);
      await supabaseAdmin.from('orders')
        .update({ status: 'filled' }).in('id', [newOrder.id, sellOrder.id]);
      await supabaseAdmin.from('transactions').insert([
        { bee_id: newOrder.bee_id,   type: 'bought', amount: fillAmount, counterparty: sellOrder.bees.bee_id },
        { bee_id: sellOrder.bee_id,  type: 'sold',   amount: (fillAmount * sellOrder.price) - fee, counterparty: bee.bee_id }
      ]);
    }
  }
}

// ── SERVE UI — must be last ──────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'FreedomBLiNGs_v2.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FreedomBLiNGs running on port ${PORT}`));
