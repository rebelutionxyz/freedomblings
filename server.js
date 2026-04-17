require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

// ── STRIPE WEBHOOK — must use raw body, BEFORE express.json() ──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bee_id  = session.metadata.bee_id;
    const bling   = parseFloat(session.metadata.bling_amount);

    // Credit BLiNG! to bee
    const { data: bee } = await supabaseAdmin
      .from('bees').select('*').eq('bee_id', bee_id).single();

    if (bee) {
      // Use mint function — fills from sell orders first, then mints from curve
      await mintBling(bee, bling, 1.001);
      console.log(`Minted/credited ${bling} BLiNG! to @${bee_id} via Stripe`);
    }
  }

  res.json({ received: true });
});

// ── JSON body parsing — after webhook route ──
app.use(express.json());

// Supabase clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
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
        { bee_id: newOrder.bee_id, type: 'sold',   amount: (fillAmount * newOrder.price) - fee, counterparty: buyOrder.bees.bee_id },
        { bee_id: buyOrder.bee_id, type: 'bought', amount: fillAmount, counterparty: bee.bee_id }
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
        { bee_id: newOrder.bee_id,  type: 'bought', amount: fillAmount, counterparty: sellOrder.bees.bee_id },
        { bee_id: sellOrder.bee_id, type: 'sold',   amount: (fillAmount * sellOrder.price) - fee, counterparty: bee.bee_id }
      ]);
    }
  }
}

// ── STRIPE — CREATE CHECKOUT SESSION ────────────
app.post('/api/stripe/create-checkout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { data: bee } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();

  const { bling_amount } = req.body;
  if (!bling_amount || bling_amount < 1)
    return res.status(400).json({ error: 'Minimum purchase is 1 BLiNG!' });

  // BLiNG! is $1 USD each (at floor price)
  const usd_cents = Math.round(bling_amount * 100);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${bling_amount} BLiNG! ⬡`,
          description: `FreedomBLiNGs · Credited to @${bee.bee_id}`,
        },
        unit_amount: usd_cents,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${req.headers.origin || 'https://www.freedomblings.com'}/?buy=success`,
    cancel_url:  `${req.headers.origin || 'https://www.freedomblings.com'}/?buy=cancelled`,
    metadata: {
      bee_id:       bee.bee_id,
      bling_amount: bling_amount.toString(),
      user_id:      user.id,
    },
    customer_email: bee.email,
  });

  res.json({ url: session.url });
});

// ── MINT BLiNG! FROM BONDING CURVE ─────────────────
// Called when a buy order has no matching sell orders
// Mints new BLiNG! at current curve price, credits buyer, updates mint_price
async function mintBling(bee, amount, mintPrice) {
  const CURVE_INCREMENT = 0.01;  // $0.01 per billion sold
  const CURVE_CEILING   = 101;
  const BLING_CAP       = 11222333222111;

  // Get current total supply from system_state
  const { data: supplyData } = await supabaseAdmin
    .from('system_state').select('value').eq('key', 'total_supply').single();
  const currentSupply = parseFloat(supplyData?.value || 0);

  if (currentSupply + amount > BLING_CAP)
    return { error: 'BLiNG! hard cap reached' };

  const newSupply   = currentSupply + amount;
  const newMintPrice = Math.min(
    CURVE_CEILING,
    1 + CURVE_INCREMENT * Math.floor(newSupply / 1e9)
  );

  // Credit BLiNG! to buyer
  const newBalance = parseFloat(bee.bling_balance) + amount;
  await supabaseAdmin.from('bees')
    .update({ bling_balance: newBalance }).eq('id', bee.id);

  // Update system state
  await supabaseAdmin.from('system_state')
    .upsert([
      { key: 'total_supply', value: newSupply.toString() },
      { key: 'mint_price',   value: newMintPrice.toString() }
    ], { onConflict: 'key' });

  // Record transaction
  await supabaseAdmin.from('transactions').insert({
    bee_id: bee.id,
    type:   'bought',
    amount: amount,
    memo:   `Minted ${amount} BLiNG! @ ${mintPrice.toFixed(4)} ⬡ · new supply: ${newSupply.toFixed(3)}`
  });

  console.log(`Minted ${amount} BLiNG! for @${bee.bee_id} · new price: ${newMintPrice}`);
  return { success: true, new_balance: newBalance, new_mint_price: newMintPrice };
}

// ── BUY ENDPOINT — fills from order book or mints ───
app.post('/api/buy', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const { amount } = req.body;
  if (!amount || amount < 0.001)
    return res.status(400).json({ error: 'Minimum buy is 0.001 BLiNG!' });

  const { data: bee } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();

  const { data: mintData } = await supabaseAdmin
    .from('system_state').select('value').eq('key', 'mint_price').single();
  const mintPrice = parseFloat(mintData?.value || 1.001);

  // Check for open sell orders at or below mint price
  const { data: sellOrders } = await supabaseAdmin
    .from('orders').select('*, bees(*)')
    .eq('side', 'sell').eq('status', 'open')
    .lte('price', mintPrice)
    .order('price', { ascending: true });

  let remaining = amount;
  let filled    = 0;

  // Fill from existing sell orders first (cheapest first)
  if (sellOrders?.length > 0) {
    for (const order of sellOrders) {
      if (remaining <= 0) break;
      const fillAmt = Math.min(remaining, parseFloat(order.amount));
      const fee     = fillAmt * 0.01;

      // Credit buyer
      await supabaseAdmin.from('bees')
        .update({ bling_balance: parseFloat(bee.bling_balance) + filled + fillAmt })
        .eq('id', bee.id);

      // Credit seller (minus 1% fee)
      await supabaseAdmin.from('bees')
        .update({ bling_balance: parseFloat(order.bees.bling_balance) + (fillAmt * order.price) - fee })
        .eq('id', order.bee_id);

      // Update order status
      const newOrderAmt = parseFloat(order.amount) - fillAmt;
      await supabaseAdmin.from('orders')
        .update({ status: newOrderAmt <= 0 ? 'filled' : 'open', amount: newOrderAmt })
        .eq('id', order.id);

      await supabaseAdmin.from('transactions').insert([
        { bee_id: bee.id,      type: 'bought', amount:  fillAmt, counterparty: order.bees.bee_id },
        { bee_id: order.bee_id, type: 'sold',  amount: (fillAmt * order.price) - fee, counterparty: bee.bee_id }
      ]);

      filled    += fillAmt;
      remaining -= fillAmt;
    }
  }

  // Mint remaining from bonding curve
  if (remaining > 0) {
    const mintResult = await mintBling(bee, remaining, mintPrice);
    if (mintResult.error) return res.status(400).json({ error: mintResult.error });
    filled += remaining;
  }

  // Refresh bee balance
  const { data: updatedBee } = await supabaseAdmin
    .from('bees').select('*').eq('id', user.id).single();

  res.json({ success: true, filled, new_balance: updatedBee.bling_balance, new_mint_price: mintPrice });
});

// ── SERVE UI — must be last ──────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'FreedomBLiNGs_v3.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FreedomBLiNGs running on port ${PORT}`));
