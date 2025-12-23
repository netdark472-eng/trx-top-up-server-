
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWeb = require('tronweb');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

/* ===========================
   Security & Middleware
=========================== */

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

/* ===========================
   TronGrid Axios (WITH API KEY)
=========================== */

const tronAxios = axios.create({
    baseURL: 'https://api.trongrid.io',
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'TRON-PRO-API-KEY': process.env.TRON_API_KEY
    }
});

/* ===========================
   TronWeb Configuration
=========================== */

const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: process.env.TRON_PRIVATE_KEY,
    headers: {
        'TRON-PRO-API-KEY': process.env.TRON_API_KEY
    }
});

/* ===========================
   Server Config
=========================== */

const SERVER_CONFIG = {
    privateKey: process.env.TRON_PRIVATE_KEY,
    address: process.env.TRON_ADDRESS,
    autoSendAmount: 13,
    minimumBalance: 11
};

const TELEGRAM_CONFIG = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
};

const processedTransactions = new Set();

/* ===========================
   Telegram Notification
=========================== */

async function sendTelegramNotification(amount, userWalletAddress, transactionId) {
    if (!TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId) return;

    try {
        const message =
            `🔔 *TRX Top-Up Sent*\n\n` +
            `💰 *Amount:* ${amount} TRX\n` +
            `👤 *User:* \`${userWalletAddress}\`\n` +
            `🔗 *TXID:* \`${transactionId}\`\n` +
            `⏰ *Time:* ${new Date().toLocaleString()}`;

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
            {
                chat_id: TELEGRAM_CONFIG.chatId,
                text: message,
                parse_mode: 'Markdown'
            }
        );
    } catch (err) {
        console.error('Telegram error:', err.message);
    }
}

/* ===========================
   Fetch Outgoing Transactions
=========================== */

async function checkForTopUps(serverAddress, limit = 20) {
    try {
        const res = await tronAxios.get(
            `/v1/accounts/${serverAddress}/transactions`,
            {
                params: {
                    limit,
                    only_confirmed: true,
                    only_from: true
                }
            }
        );

        const topUps = [];

        for (const tx of res.data?.data || []) {
            if (processedTransactions.has(tx.txID)) continue;

            for (const contract of tx.raw_data?.contract || []) {
                if (contract.type !== 'TransferContract') continue;

                const p = contract.parameter?.value;
                if (!p) continue;

                const from = tronWeb.address.fromHex(p.owner_address);
                if (from !== serverAddress) continue;

                const to = tronWeb.address.fromHex(p.to_address);
                const amountTRX = tronWeb.fromSun(p.amount || 0);

                if (amountTRX > 0) {
                    processedTransactions.add(tx.txID);
                    topUps.push({
                        transactionId: tx.txID,
                        toAddress: to,
                        amount: amountTRX
                    });
                }
            }
        }

        return topUps;
    } catch (err) {
        console.error('Top-up scan error:', err.message);
        return [];
    }
}

/* ===========================
   Validators
=========================== */

const validateRequest = (req, res, next) => {
    const { userAddress } = req.body;
    if (!userAddress || !TronWeb.isAddress(userAddress)) {
        return res.status(400).json({ success: false, error: 'Invalid TRON address' });
    }
    next();
};

/* ===========================
   Routes
=========================== */

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        tronApiKeyLoaded: !!process.env.TRON_API_KEY,
        serverAddress: SERVER_CONFIG.address
    });
});

app.post('/check-balance', validateRequest, async (req, res) => {
    try {
        const balance = await tronWeb.trx.getBalance(req.body.userAddress);
        const trx = tronWeb.fromSun(balance);

        res.json({
            success: true,
            balance: trx,
            needsFunding: trx < SERVER_CONFIG.minimumBalance
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/send-trx', validateRequest, async (req, res) => {
    try {
        const user = req.body.userAddress;
        const balance = tronWeb.fromSun(await tronWeb.trx.getBalance(user));

        if (balance >= SERVER_CONFIG.minimumBalance) {
            return res.json({ success: true, sent: false });
        }

        const tx = await tronWeb.transactionBuilder.sendTrx(
            user,
            tronWeb.toSun(SERVER_CONFIG.autoSendAmount),
            SERVER_CONFIG.address
        );

        const signed = await tronWeb.trx.sign(tx);
        const result = await tronWeb.trx.sendRawTransaction(signed);

        if (!result.result) throw new Error('Transaction failed');

        await sendTelegramNotification(
            SERVER_CONFIG.autoSendAmount,
            user,
            result.txid
        );

        res.json({
            success: true,
            sent: true,
            txid: result.txid
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ===========================
   Background Polling
=========================== */

function startTopUpPolling() {
    if (!SERVER_CONFIG.address) return;

    const interval = parseInt(process.env.TOP_UP_POLL_INTERVAL || '30000');

    setInterval(async () => {
        const topUps = await checkForTopUps(SERVER_CONFIG.address, 10);
        for (const t of topUps) {
            await sendTelegramNotification(t.amount, t.toAddress, t.transactionId);
        }
    }, interval);

    console.log(`🔄 Top-up polling every ${interval / 1000}s`);
}

/* ===========================
   Start Server
=========================== */

app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
    console.log(`🔑 TronGrid API key loaded: ${!!process.env.TRON_API_KEY}`);
    startTopUpPolling();
});

/* ===========================
   Graceful Shutdown
=========================== */

process.on('SIGTERM', () => process.exit(0));

module.exports = app;
