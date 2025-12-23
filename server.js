
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWeb = require('tronweb');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   Security & Middleware
========================= */

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
   TronGrid Axios (API KEY)
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
   TronWeb (CORRECT WAY)
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
   Server Config (FROM ENV)
========================= */

const SERVER_CONFIG = {
  address: process.env.TRON_ADDRESS,
  autoSendAmount: Number(process.env.AUTO_SEND_AMOUNT || 12),
  minimumBalance: Number(process.env.MINIMUM_BALANCE || 11)
};

const TELEGRAM_CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID
};

const processedTransactions = new Set();

/* =========================
   Telegram
========================= */

async function sendTelegramNotification(amount, to, txid) {
  if (!TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId) return;

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
    {
      chat_id: TELEGRAM_CONFIG.chatId,
      text: `🔔 TRX Sent\n\nAmount: ${amount} TRX\nTo: ${to}\nTXID: ${txid}`,
      parse_mode: 'Markdown'
    }
  );
}

/* =========================
   Scan Outgoing TX
========================= */

async function checkForTopUps(address, limit = 20) {
  try {
    const res = await tronAxios.get(
      `/v1/accounts/${address}/transactions`,
      { params: { limit, only_confirmed: true, only_from: true } }
    );

    const list = [];

    for (const tx of res.data?.data || []) {
      if (processedTransactions.has(tx.txID)) continue;

      for (const c of tx.raw_data.contract || []) {
        if (c.type !== 'TransferContract') continue;

        const p = c.parameter.value;
        const from = tronWeb.address.fromHex(p.owner_address);
        if (from !== address) continue;

        processedTransactions.add(tx.txID);
        list.push({
          txid: tx.txID,
          to: tronWeb.address.fromHex(p.to_address),
          amount: tronWeb.fromSun(p.amount)
        });
      }
    }

    return list;
  } catch {
    return [];
  }
}

/* =========================
   Validators
========================= */

function validateRequest(req, res, next) {
  if (!req.body.userAddress || !TronWeb.isAddress(req.body.userAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid address' });
  }
  next();
}

/* =========================
   Routes
========================= */

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    tronApiKeyLoaded: !!process.env.TRON_API_KEY
  });
});

app.post('/check-balance', validateRequest, async (req, res) => {
  const bal = tronWeb.fromSun(
    await tronWeb.trx.getBalance(req.body.userAddress)
  );

  res.json({
    success: true,
    balance: bal,
    needsFunding: bal < SERVER_CONFIG.minimumBalance
  });
});

app.post('/send-trx', validateRequest, async (req, res) => {
  const user = req.body.userAddress;
  const bal = tronWeb.fromSun(await tronWeb.trx.getBalance(user));

  if (bal >= SERVER_CONFIG.minimumBalance) {
    return res.json({ success: true, sent: false });
  }

  const tx = await tronWeb.transactionBuilder.sendTrx(
    user,
    tronWeb.toSun(SERVER_CONFIG.autoSendAmount),
    SERVER_CONFIG.address
  );

  const signed = await tronWeb.trx.sign(tx);
  const result = await tronWeb.trx.sendRawTransaction(signed);

  if (!result.result) throw new Error('TX failed');

  await sendTelegramNotification(
    SERVER_CONFIG.autoSendAmount,
    user,
    result.txid
  );

  res.json({ success: true, sent: true, txid: result.txid });
});

/* =========================
   Background Polling
========================= */

setInterval(async () => {
  if (!TELEGRAM_CONFIG.botToken) return;
  const txs = await checkForTopUps(SERVER_CONFIG.address, 10);
  for (const t of txs) {
    await sendTelegramNotification(t.amount, t.to, t.txid);
  }
}, 30000);

/* =========================
   Start Server
========================= */

app.listen(PORT, () => {
  console.log('🚀 Server running');
  console.log('🔑 TronGrid API Key:', !!process.env.TRON_API_KEY);
});
