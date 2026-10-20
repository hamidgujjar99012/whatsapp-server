require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, getDocs } = require('firebase/firestore');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// --- 1. FIREBASE SETUP ---
const firebaseConfig = {
  apiKey: "AIzaSyAbOSA-JI8yrJDJBScsiQxnohWOLowyGTY",
  authDomain: "quick-layout-pmn89.firebaseapp.com",
  projectId: "quick-layout-pmn89",
  storageBucket: "quick-layout-pmn89.firebasestorage.app",
  messagingSenderId: "111040364657",
  appId: "1:111040364657:web:570feb58b15db4ea9d9bd0"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp); 

async function loginBot() {
    try {
        await signInWithEmailAndPassword(auth, process.env.BOT_EMAIL, process.env.BOT_PASSWORD);
        console.log("🤖 Bot successfully logged into Firebase!");
    } catch (error) {
        console.error("❌ Bot login failed:", error.message);
    }
}
loginBot();

// --- 2. EXPRESS SETUP ---
const app = express();
// YEH SABSE ZAROORI LINE HAI (CORS FIX)
app.use(cors({ origin: '*' })); 
app.use(express.json({ limit: '50mb' }));

// --- 3. WHATSAPP MULTI-TENANT SESSIONS ---
const sessions = new Map();

async function connectToWhatsApp(ispId) {
    if (sessions.has(ispId) && sessions.get(ispId).isConnected) {
        return sessions.get(ispId).sock;
    }

    const sessionDir = path.join(__dirname, 'sessions', ispId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
    });

    sessions.set(ispId, { sock, isConnected: false, qr: null });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrDataUrl = await qrcode.toDataURL(qr);
            sessions.get(ispId).qr = qrDataUrl;
            console.log(`[ISP: ${ispId}] QR Code Ready.`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            sessions.get(ispId).isConnected = false;
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(ispId), 3000);
            } else {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                sessions.delete(ispId);
            }
        } else if (connection === 'open') {
            console.log(`[ISP: ${ispId}] WhatsApp Connected!`);
            sessions.get(ispId).isConnected = true;
            sessions.get(ispId).qr = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// --- 4. API ROUTES ---
app.get('/api/whatsapp/qr/:ispId', async (req, res) => {
    const { ispId } = req.params;
    if (sessions.has(ispId) && sessions.get(ispId).isConnected) {
        return res.json({ status: 'connected' });
    }
    if (!sessions.has(ispId)) {
        await connectToWhatsApp(ispId);
        await new Promise(r => setTimeout(r, 2000)); 
    }
    const session = sessions.get(ispId);
    if (session && session.qr) {
        res.json({ status: 'qr', qr: session.qr });
    } else {
        res.json({ status: 'initializing' });
    }
});

app.get('/api/whatsapp/status/:ispId', (req, res) => {
    const { ispId } = req.params;
    const session = sessions.get(ispId);
    res.json({ connected: session ? session.isConnected : false });
});

app.post('/api/whatsapp/send', async (req, res) => {
    const { ispId, phone, message, imageBase64 } = req.body;
    if (!sessions.has(ispId) || !sessions.get(ispId).isConnected) {
        return res.status(400).json({ error: 'WhatsApp connected nahi hai.' });
    }
    const sock = sessions.get(ispId).sock;
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '92' + cleanPhone.slice(1);
    const jid = `${cleanPhone}@s.whatsapp.net`;

    try {
        if (imageBase64) {
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
            const imageBuffer = Buffer.from(base64Data, 'base64');
            await sock.sendMessage(jid, { image: imageBuffer, caption: message });
        } else {
            await sock.sendMessage(jid, { text: message });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Send fail ho gaya.' });
    }
});

// --- 5. 24/7 AUTO REMINDER CRON JOB ---
cron.schedule('0 10 * * *', async () => {
    console.log('⏰ Running Daily 3-Day Expiry Reminder Job...');
    if (!auth.currentUser) await loginBot();
    try {
        const targetDate = new Date(); targetDate.setDate(targetDate.getDate() + 3);
        const targetStr = targetDate.toISOString().slice(0, 10);
        const snap = await getDocs(collection(db, 'customers'));
        for (const doc of snap.docs) {
            const c = doc.data();
            if (c.expiryDate === targetStr && (c.status === 'Active' || c.paymentStatus === 'Unpaid')) {
                const isp = c.operator_id;
                if (sessions.has(isp) && sessions.get(isp).isConnected) {
                    let p = c.phone.replace(/\D/g, '');
                    if (p.startsWith('0')) p = '92' + p.slice(1);
                    await sessions.get(isp).sock.sendMessage(`${p}@s.whatsapp.net`, { 
                        text: `Dear ${c.fullName}, your package expires on ${c.expiryDate}. Please pay Rs. ${c.outstandingBalance || c.monthlyFee}.` 
                    });
                }
            }
        }
    } catch (err) { console.error(err); }
});

// --- 6. SERVER START ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server 24/7 Mode par chal raha hai. Port: ${PORT}`);
});
