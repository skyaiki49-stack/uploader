const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'database.json');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = { users: {}, discordUsers: {}, history: [], limits: {}, queue: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!data.users) data.users = {};
        if (!data.discordUsers) data.discordUsers = {};
        if (!data.limits) data.limits = {};
        if (!data.history) data.history = [];
        if (!data.queue) data.queue = [];
        return data;
    } catch (e) {
        return { users: {}, discordUsers: {}, history: [], limits: {}, queue: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkAndUseLimit(discordId, countToAdd = 1) {
    let db = readDB();
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (!db.limits[discordId]) {
        db.limits[discordId] = { count: 0, resetTime: now + TWENTY_FOUR_HOURS };
    }
    if (now > db.limits[discordId].resetTime) {
        db.limits[discordId].count = 0;
        db.limits[discordId].resetTime = now + TWENTY_FOUR_HOURS;
    }
    writeDB(db);
    return db.limits[discordId];
}

async function pollOperationStatus(operationPath, apiKey) {
    const maxRetries = 30;
    const delayMs = 4000;
    for (let i = 0; i < maxRetries; i++) {
        try {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            const res = await fetch(`https://apis.roblox.com/${operationPath}`, {
                headers: { 'x-api-key': apiKey }
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (data.done) {
                if (data.response && data.response.assetId) {
                    return { success: true, assetId: data.response.assetId };
                } else if (data.error) {
                    return { success: false, message: data.error.message || 'Gagal diproses Roblox' };
                }
            }
        } catch (e) {}
    }
    return { success: false, message: 'Timeout menunggu proses Roblox' };
}

app.get('/auth/discord', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
        return res.status(500).send('Konfigurasi Discord Client ID / Redirect URI belum diatur.');
    }
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=nodiscordcode');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect('/?error=discordtokenfailed');

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();
        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` 
            : 'https://cdn.discordapp.com/embed/avatars/0.png';

        let db = readDB();
        db.discordUsers[userData.id] = {
            id: userData.id,
            username: userData.username,
            globalName: userData.global_name || userData.username,
            avatar: avatarUrl
        };
        writeDB(db);

        res.redirect(`/?discordId=${userData.id}`);
    } catch (err) {
        res.redirect('/?error=discordservererror');
    }
});

app.get('/api/discord/user/:discordId', (req, res) => {
    const { discordId } = req.params;
    let db = readDB();
    const user = db.discordUsers[discordId];
    if (user) {
        const robloxUser = db.users[discordId] || null;
        res.json({ success: true, user, robloxUser });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/connect', async (req, res) => {
    const { discordId, userId, apiKey } = req.body;
    if (!discordId || !userId || !apiKey) return res.status(400).json({ success: false, message: 'Data tidak lengkap.' });
    try {
        const userRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
        if (!userRes.ok) return res.status(400).json({ success: false, message: 'User ID Roblox tidak ditemui.' });
        const userData = await userRes.json();
        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
        const thumbData = await thumbRes.json();
        const avatarUrl = thumbData.data && thumbData.data.length > 0 ? thumbData.data[0].imageUrl : 'https://tr.rbxcdn.com/3941443493e947d5ce177894f6f7093b/150/150/Image/Png';

        let db = readDB();
        const profile = { discordId, userId, apiKey, username: userData.name, displayName: userData.displayName, avatar: avatarUrl };
        db.users[discordId] = profile;
        writeDB(db);
        res.json({ success: true, profile });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal menyambungkan ke akaun Roblox.' });
    }
});

app.get('/api/history/:discordId', (req, res) => {
    const { discordId } = req.params;
    let db = readDB();
    const userHistory = db.history.filter(h => h.discordId === discordId);
    const limitInfo = checkAndUseLimit(discordId, 0);
    res.json({ success: true, history: userHistory, totalUpload: userHistory.length, remainingLimit: Math.max(0, 10 - limitInfo.count) });
});

app.post('/api/fetch-media', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL tidak boleh kosong.' });

    try {
        let title = "Audio Mchlern Media";
        let thumbnail = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop";

        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            if (oembedRes.ok) {
                const data = await oembedRes.json();
                title = data.title || title;
                thumbnail = data.thumbnail_url || thumbnail;
            }
        } else if (url.includes('tiktok.com')) {
            const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
            if (oembedRes.ok) {
                const data = await oembedRes.json();
                title = data.title || title;
                thumbnail = data.thumbnail_url || thumbnail;
            }
        }

        res.json({ success: true, media: { title, thumbnail, originalUrl: url } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal mengambil metadata media.' });
    }
});

// Endpoint untuk memasukkan tugas ke antrean (Queue) dari web panel
app.post('/api/upload-batch-url', async (req, res) => {
    const { discordId, items, speed, pitch, volume } = req.body;
    if (!discordId || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Data batch tidak lengkap.' });
    }

    let db = readDB();
    let robloxUser = db.users[discordId];
    if (!robloxUser) return res.status(401).json({ success: false, message: 'Akaun Roblox belum tersambung.' });

    const limitInfo = checkAndUseLimit(discordId, 0);
    if (limitInfo.count + items.length > 10) {
        return res.status(400).json({ success: false, message: `Had harian terlampaui. Baki had: ${10 - limitInfo.count}` });
    }

    // Masukkan ke database queue agar bisa diambil oleh worker Termux kamu
    for (let item of items) {
        db.limits[discordId].count += 1;
        db.queue.push({
            id: 'job_' + Date.now() + Math.random().toString(36.substring(2, 7)),
            discordId,
            userId: robloxUser.userId,
            apiKey: robloxUser.apiKey,
            originalUrl: item.originalUrl,
            customTitle: item.customTitle || 'Converted_Audio',
            speed: speed || 1.0,
            pitch: pitch || 1.0,
            volume: volume || 1.0
        });
    }

    writeDB(db);
    res.json({ success: true, message: `${items.length} audio dimasukkan ke antrean worker Termux.` });
});

// --- API KHUSUS UNTUK WORKER TERMUX ---
// 1. Ambil tugas antrean yang pending
app.get('/api/worker/pending', (req, res) => {
    let db = readDB();
    if (db.queue && db.queue.length > 0) {
        const job = db.queue.shift(); // Ambil tugas pertama
        writeDB(db);
        res.json({ success: true, job });
    } else {
        res.json({ success: false, message: 'Tiada antrean.' });
    }
});

// 2. Laporkan hasil upload dari Termux ke history web
app.post('/api/worker/report', upload.single('audio'), async (req, res) => {
    const { discordId, userId, apiKey, customTitle, assetIdStatus, statusMsg } = req.body;
    const file = req.file;

    let db = readDB();
    const resultItem = {
        name: customTitle || 'Converted_Audio',
        type: 'Audio',
        assetId: assetIdStatus || 'Gagal',
        status: statusMsg || 'Success',
        time: new Date().toLocaleString(),
        discordId
    };

    db.history.unshift(resultItem);
    writeDB(db);

    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`Server berjalan di port ${PORT}`); });
