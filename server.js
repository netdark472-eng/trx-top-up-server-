
/*************************************************
 * TRON AUTO TOP-UP SERVER (RAILWAY READY)
 * Fixes TronGrid 429 using HttpProvider + API KEY
 *************************************************/

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWeb = require('tronweb');
const axios = require('axios');
require('dotenv').config();

/* =========================
   BASIC APP SETUP
========================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
  })
);

/* =========================
   REQUIRED ENV CHECK
========================= */

const REQUIRED_ENVS = [
  'TRON_PRIVATE_KEY',
  'TRON_ADDRESS',
  'TRON_API_KEY'
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing ENV: ${key}`);
    process.exit(1);
  }
}

/* =========================
   TRONGRID AXIOS (API KEY)
========================= */

const tronAxios = axios.create({
  baseURL: 'https://api.trongrid.io',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'TRON-PRO-API-KEY': process.env.TRON_API_KEY
  }
});

/* =========================
   TRONWEB (CORRECT WAY)
========================= */

const HttpProvider = TronWeb.providers.HttpProvider;

const fullNode = new HttpProvider(
  'https://api.trongrid.io',
  30000,
  false,
  { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
);

const solidityNode = new HttpProvider(
  'https://api.trongrid.io',
  30000,
  false,
  { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
);

const eventServer = new HttpProvider(
  'https://api.trongrid.io',
  30000,
  false,
  { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
);

const tronWeb = new TronWeb(
  fullNode,
  solidityNode,
  eventServer,
  process.env.TRON_PRIVATE_KEY
);

/* =========================
   SERVER CONFIG
========================= */

const SERVER_CONFIG = {
  address: process.env.TRON_ADDRESS,
  autoSendAmount: Number(process.env.AUTO_SEND_AMOUNT || 12),
  minimumBalance: Number(process.env.MINIMUM_BALANCE || 11)
};

/* =========================
   TELEGRAM CONFIG (OPTIONAL)
========================= */

const TELEGRAM_CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || null,
  chatId: process.env.TELEGRAM_CHAT_ID || null
};

/* =========================
   HELPERS
========================= */

function isValidAddress(addr) {
  return TronWeb.isAddress(addr);
}

/* =========================
   TELEGRAM NOTIFY
========================= */

async function notifyTelegram(amount, to, txid) {
  if (!TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
      {
        chat_id: TELEGRAM_CONFIG.chatId,
        text:
          `🔔 TRX SENT\n\n` +
          `Amount: ${amount} TRX\n` +
          `To: ${to}\n` +
          `TXID: ${txid}`,
        parse_mode: 'Markdown'
      }
    );
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

/* =========================
   ROUTES
========================= */

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    tronApiKeyLoaded: true,
    address: SERVER_CONFIG.address
  });
});

/* ---------- CHECK BALANCE ---------- */

app.post('/check-balance', async (req, res) => {
  const { userAddress } = req.body;

  if (!userAddress || !isValidAddress(userAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid address' });
  }

  try {
    const balanceSun = await tronWeb.trx.getBalance(userAddress);
    const balance = tronWeb.fromSun(balanceSun);

    res.json({
      success: true,
      balance,
      needsFunding: balance < SERVER_CONFIG.minimumBalance,
      autoSendAmount: SERVER_CONFIG.autoSendAmount
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ---------- SEND TRX ---------- */

app.post('/send-trx', async (req, res) => {
  const { userAddress } = req.body;

  if (!userAddress || !isValidAddress(userAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid address' });
  }

  try {
    const userBal = tronWeb.fromSun(
      await tronWeb.trx.getBalance(userAddress)
    );

    if (userBal >= SERVER_CONFIG.minimumBalance) {
      return res.json({ success: true, sent: false });
    }

    const tx = await tronWeb.transactionBuilder.sendTrx(
      userAddress,
      tronWeb.toSun(SERVER_CONFIG.autoSendAmount),
      SERVER_CONFIG.address
    );

    const signed = await tronWeb.trx.sign(tx);
    const result = await tronWeb.trx.sendRawTransaction(signed);

    if (!result.result) throw new Error('Transaction failed');

    await notifyTelegram(
      SERVER_CONFIG.autoSendAmount,
      userAddress,
      result.txid
    );

    res.json({
      success: true,
      sent: true,
      txid: result.txid
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log('🚀 TRON Auto Top-Up Server Started');
  console.log('🌐 Port:', PORT);
  console.log('🔑 TronGrid API Key: OK');
  console.log('💰 Auto Send:', SERVER_CONFIG.autoSendAmount, 'TRX');
  console.log('📊 Minimum Balance:', SERVER_CONFIG.minimumBalance, 'TRX');
});

/* =========================
   SHUTDOWN
========================= */

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  process.exit(0);
});

module.exports = app;
