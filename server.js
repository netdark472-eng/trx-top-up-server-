const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWeb = require('tronweb');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
    origin: true, // Allow all origins
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json());

// TronWeb configuration
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: process.env.TRON_PRIVATE_KEY
});

// Your server wallet configuration
const SERVER_CONFIG = {
    privateKey: process.env.TRON_PRIVATE_KEY,
    address: process.env.TRON_ADDRESS,
    autoSendAmount: 13, // TRX to send automatically
    minimumBalance: 11 // Minimum TRX to keep in user wallet
};

// Telegram Bot Configuration
const TELEGRAM_CONFIG = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
};

// Store processed transactions to avoid duplicate notifications
const processedTransactions = new Set();

// Function to send Telegram notification
async function sendTelegramNotification(amount, walletAddress, transactionId) {
    try {
        if (!TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId) {
            console.warn('Telegram bot token or chat ID not configured. Skipping notification.');
            return false;
        }

        const message = `🔔 *TRX Top-Up Detected*\n\n` +
                       `💰 *Amount:* ${amount} TRX\n` +
                       `👤 *Wallet Address:* \`${walletAddress}\`\n` +
                       `🔗 *Transaction ID:* \`${transactionId}\`\n` +
                       `⏰ *Time:* ${new Date().toLocaleString()}`;

        const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`;
        
        const response = await axios.post(url, {
            chat_id: TELEGRAM_CONFIG.chatId,
            text: message,
            parse_mode: 'Markdown'
        });

        if (response.data.ok) {
            console.log(`✅ Telegram notification sent successfully for ${amount} TRX to ${walletAddress}`);
            return true;
        } else {
            console.error('Failed to send Telegram notification:', response.data);
            return false;
        }
    } catch (error) {
        console.error('Error sending Telegram notification:', error.message);
        return false;
    }
}

// Function to check for incoming TRX transactions (top-ups)
async function checkForTopUps(walletAddress, limit = 20) {
    try {
        // Use TronGrid API to get incoming TRX transactions
        const trxTransactionsUrl = `https://api.trongrid.io/v1/accounts/${walletAddress}/transactions`;
        const trxResponse = await axios.get(trxTransactionsUrl, {
            params: {
                limit: limit,
                only_confirmed: true,
                only_to: true
            }
        });
        
        const topUps = [];
        
        // Process regular TRX transactions
        if (trxResponse.data && trxResponse.data.data) {
            for (const tx of trxResponse.data.data) {
                if (processedTransactions.has(tx.txID)) {
                    continue;
                }
                
                // Check if this is an incoming TRX transaction
                if (tx.raw_data && tx.raw_data.contract) {
                    for (const contract of tx.raw_data.contract) {
                        if (contract.type === 'TransferContract') {
                            const parameter = contract.parameter?.value;
                            
                            if (parameter) {
                                const toAddress = tronWeb.address.fromHex(parameter.to_address);
                                
                                // Check if this is an incoming transaction to our monitored address
                                if (toAddress === walletAddress) {
                                    const fromAddress = tronWeb.address.fromHex(parameter.owner_address);
                                    const amount = parameter.amount || 0;
                                    const amountInTRX = tronWeb.fromSun(amount);
                                    
                                    if (amountInTRX > 0) {
                                        topUps.push({
                                            transactionId: tx.txID,
                                            fromAddress: fromAddress,
                                            toAddress: toAddress,
                                            amount: amountInTRX,
                                            timestamp: tx.raw_data.timestamp
                                        });
                                        
                                        processedTransactions.add(tx.txID);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        return topUps;
    } catch (error) {
        console.error('Error checking for top-ups:', error);
        // Fallback: try using TronWeb directly if available
        try {
            // Try alternative method using getAccountTransactions
            const accountInfo = await tronWeb.trx.getAccount(walletAddress);
            const transactions = await tronWeb.trx.getTransactionsToAddress(walletAddress, limit);
            const topUps = [];
            
            for (const tx of transactions) {
                if (processedTransactions.has(tx.txID)) {
                    continue;
                }
                
                if (tx.raw_data && tx.raw_data.contract) {
                    for (const contract of tx.raw_data.contract) {
                        if (contract.type === 'TransferContract') {
                            const parameter = contract.parameter?.value;
                            
                            if (parameter) {
                                const toAddress = tronWeb.address.fromHex(parameter.to_address);
                                
                                if (toAddress === walletAddress) {
                                    const fromAddress = tronWeb.address.fromHex(parameter.owner_address);
                                    const amount = parameter.amount || 0;
                                    const amountInTRX = tronWeb.fromSun(amount);
                                    
                                    if (amountInTRX > 0) {
                                        topUps.push({
                                            transactionId: tx.txID,
                                            fromAddress: fromAddress,
                                            toAddress: toAddress,
                                            amount: amountInTRX,
                                            timestamp: tx.raw_data.timestamp
                                        });
                                        
                                        processedTransactions.add(tx.txID);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            return topUps;
        } catch (fallbackError) {
            console.error('Fallback method also failed:', fallbackError);
            // Return empty array instead of throwing to prevent server crash
            return [];
        }
    }
}

// Middleware to validate requests
const validateRequest = (req, res, next) => {
    const { userAddress } = req.body;
    
    if (!userAddress) {
        return res.status(400).json({ 
            error: 'User address is required',
            success: false 
        });
    }
    
    if (!TronWeb.isAddress(userAddress)) {
        return res.status(400).json({ 
            error: 'Invalid TRON address',
            success: false 
        });
    }
    
    next();
};

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        message: 'TRON Scanner Backend is running',
        timestamp: new Date().toISOString(),
        serverAddress: SERVER_CONFIG.address
    });
});

// Check user balance
app.post('/check-balance', validateRequest, async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        console.log(`Checking balance for: ${userAddress}`);
        
        // Get user balance
        const balance = await tronWeb.trx.getBalance(userAddress);
        const balanceInTRX = tronWeb.fromSun(balance);
        
        res.json({
            success: true,
            address: userAddress,
            balance: balanceInTRX,
            needsFunding: balanceInTRX < SERVER_CONFIG.minimumBalance,
            autoSendAmount: SERVER_CONFIG.autoSendAmount
        });
        
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check balance',
            message: error.message
        });
    }
});

// Send TRX automatically if user needs funding
app.post('/send-trx', validateRequest, async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        console.log(`Sending TRX to: ${userAddress}`);
        
        // Check if user already has enough balance
        const balance = await tronWeb.trx.getBalance(userAddress);
        const balanceInTRX = tronWeb.fromSun(balance);
        
        if (balanceInTRX >= SERVER_CONFIG.minimumBalance) {
            return res.json({
                success: true,
                message: 'User already has sufficient balance',
                balance: balanceInTRX,
                sent: false
            });
        }
        
        // Check server balance
        const serverBalance = await tronWeb.trx.getBalance(SERVER_CONFIG.address);
        const serverBalanceInTRX = tronWeb.fromSun(serverBalance);
        
        if (serverBalanceInTRX < SERVER_CONFIG.autoSendAmount) {
            return res.status(500).json({
                success: false,
                error: 'Server has insufficient funds',
                serverBalance: serverBalanceInTRX,
                required: SERVER_CONFIG.autoSendAmount
            });
        }
        
        // Send TRX to user
        const transaction = await tronWeb.transactionBuilder.sendTrx(
            userAddress,
            tronWeb.toSun(SERVER_CONFIG.autoSendAmount),
            SERVER_CONFIG.address
        );
        
        const signedTransaction = await tronWeb.trx.sign(transaction);
        const result = await tronWeb.trx.sendRawTransaction(signedTransaction);
        
        if (result.result) {
            console.log(`Successfully sent ${SERVER_CONFIG.autoSendAmount} TRX to ${userAddress}`);
            console.log(`Transaction ID: ${result.txid}`);
            
            res.json({
                success: true,
                message: `Sent ${SERVER_CONFIG.autoSendAmount} TRX successfully`,
                transactionId: result.txid,
                amount: SERVER_CONFIG.autoSendAmount,
                recipient: userAddress,
                sent: true
            });
        } else {
            throw new Error('Transaction failed');
        }
        
    } catch (error) {
        console.error('Send TRX error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send TRX',
            message: error.message
        });
    }
});

// Get transaction status
app.post('/transaction-status', async (req, res) => {
    try {
        const { transactionId } = req.body;
        
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: 'Transaction ID is required'
            });
        }
        
        const transaction = await tronWeb.trx.getTransaction(transactionId);
        
        res.json({
            success: true,
            transactionId: transactionId,
            status: transaction.ret ? 'success' : 'failed',
            confirmed: transaction.ret ? true : false,
            transaction: transaction
        });
        
    } catch (error) {
        console.error('Transaction status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get transaction status',
            message: error.message
        });
    }
});

// Check for TRX top-ups endpoint
app.post('/check-top-ups', async (req, res) => {
    try {
        const { walletAddress } = req.body;
        const addressToCheck = walletAddress || SERVER_CONFIG.address;
        
        if (!TronWeb.isAddress(addressToCheck)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid TRON address'
            });
        }
        
        console.log(`Checking for top-ups to: ${addressToCheck}`);
        
        const topUps = await checkForTopUps(addressToCheck);
        
        // Send notifications for each top-up
        const notifications = [];
        for (const topUp of topUps) {
            const notified = await sendTelegramNotification(
                topUp.amount,
                topUp.fromAddress,
                topUp.transactionId
            );
            notifications.push({
                transactionId: topUp.transactionId,
                amount: topUp.amount,
                fromAddress: topUp.fromAddress,
                notificationSent: notified
            });
        }
        
        res.json({
            success: true,
            topUpsFound: topUps.length,
            topUps: notifications,
            address: addressToCheck
        });
        
    } catch (error) {
        console.error('Check top-ups error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check for top-ups',
            message: error.message
        });
    }
});

// Server info endpoint
app.get('/server-info', (req, res) => {
    res.json({
        success: true,
        serverAddress: SERVER_CONFIG.address,
        autoSendAmount: SERVER_CONFIG.autoSendAmount,
        minimumBalance: SERVER_CONFIG.minimumBalance,
        network: 'Mainnet',
        apiVersion: '1.0.0',
        telegramConfigured: !!(TELEGRAM_CONFIG.botToken && TELEGRAM_CONFIG.chatId)
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Background polling for top-ups (checks every 30 seconds)
let pollingInterval = null;

function startTopUpPolling() {
    if (!SERVER_CONFIG.address) {
        console.warn('⚠️  Server address not configured. Top-up polling disabled.');
        return;
    }
    
    if (!TELEGRAM_CONFIG.botToken || !TELEGRAM_CONFIG.chatId) {
        console.warn('⚠️  Telegram bot not configured. Top-up polling disabled.');
        return;
    }
    
    const pollInterval = parseInt(process.env.TOP_UP_POLL_INTERVAL) || 30000; // Default 30 seconds
    
    pollingInterval = setInterval(async () => {
        try {
            const topUps = await checkForTopUps(SERVER_CONFIG.address, 10);
            
            for (const topUp of topUps) {
                await sendTelegramNotification(
                    topUp.amount,
                    topUp.fromAddress,
                    topUp.transactionId
                );
            }
            
            if (topUps.length > 0) {
                console.log(`📬 Detected ${topUps.length} new top-up(s)`);
            }
        } catch (error) {
            console.error('Error in top-up polling:', error.message);
        }
    }, pollInterval);
    
    console.log(`🔄 Top-up polling started (checking every ${pollInterval / 1000} seconds)`);
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 TRON Scanner Backend running on port ${PORT}`);
    console.log(`🔑 Server Address: ${SERVER_CONFIG.address}`);
    console.log(`💰 Auto-send Amount: ${SERVER_CONFIG.autoSendAmount} TRX`);
    console.log(`📊 Minimum Balance: ${SERVER_CONFIG.minimumBalance} TRX`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    
    // Start top-up polling
    startTopUpPolling();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    process.exit(0);
});

module.exports = app;
