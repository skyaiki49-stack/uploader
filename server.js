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
        const initial = { users: {}, discordUsers: {}, history: [], limits: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.discordUsers) data.discordUsers = {};
    if (!data.limits) data.limits = {};
    return data;
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkAndUseLimit(discordId) {
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
    const maxRetries = 15;
    const delayMs = 3000;
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
        res.json({ success: true, user });
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
        db.users[discordId] = { discordId, userId, apiKey, username: userData.name, displayName: userData.displayName, avatar: avatarUrl };
        writeDB(db);
        res.json({ success: true, profile: { userId, username: userData.name, displayName: userData.displayName, avatar: avatarUrl } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal menyambungkan ke akaun Roblox.' });
    }
});

app.get('/api/history/:discordId', (req, res) => {
    const { discordId } = req.params;
    let db = readDB();
    const userHistory = db.history.filter(h => h.discordId === discordId);
    const limitInfo = checkAndUseLimit(discordId);
    res.json({ success: true, history: userHistory, totalUpload: userHistory.length, remainingLimit: Math.max(0, 10 - limitInfo.count) });
});

app.post('/api/upload-audio', upload.array('audios', 20), async (req, res) => {
    const { discordId, userId, apiKey } = req.body;
    const files = req.files;
    let customNames = req.body.customNames;
    if (!discordId || !userId || !files || files.length === 0) return res.status(400).json({ success: false, message: 'Fail atau sesi tidak lengkap.' });
    if (typeof customNames === 'string') customNames = [customNames];

    let db = readDB();
    let robloxUser = db.users[discordId];
    if (!robloxUser && apiKey) {
        robloxUser = { discordId, userId, apiKey };
        db.users[discordId] = robloxUser;
        writeDB(db);
    }
    if (!robloxUser) return res.status(401).json({ success: false, message: 'Akaun Roblox belum tersambung.' });

    const limitInfo = checkAndUseLimit(discordId);
    if (limitInfo.count + files.length > 10) return res.status(400).json({ success: false, message: `Had harian terlampaui. Baki had: ${10 - limitInfo.count}` });

    let results = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const displayName = (customNames && customNames[i]) ? customNames[i] : file.originalname;
        try {
            const fileStream = fs.createReadStream(file.path);
            const stats = fs.statSync(file.path);
            const formData = new FormData();
            formData.append('request', JSON.stringify({
                assetType: "Audio",
                displayName: displayName,
                description: "MCHLERN UPLOADER",
                creationContext: { creator: { userId: Number(userId) } }
            }));
            formData.append('fileContent', fileStream, { filename: file.originalname, knownLength: stats.size });

            const response = await fetch('https://apis.roblox.com/assets/v1/assets', {
                method: 'POST',
                headers: { 'x-api-key': robloxUser.apiKey, ...formData.getHeaders() },
                body: formData
            });
            const responseData = await response.json();
            fs.unlinkSync(file.path);

            if (response.ok && responseData.path) {
                const pollResult = await pollOperationStatus(responseData.path, robloxUser.apiKey);
                if (pollResult.success) {
                    results.push({ name: displayName, type: 'Audio', assetId: pollResult.assetId, status: 'Success', time: new Date().toLocaleString() });
                    // MENAMBAHKAN COUNTER LIMIT HARIAN SETIAP BERHASIL UPLOAD AUDIO
                    db.limits[discordId].count += 1;
                } else {
                    results.push({ name: displayName, type: 'Audio', assetId: 'Gagal', status: pollResult.message, time: new Date().toLocaleString() });
                }
            } else {
                results.push({ name: displayName, type: 'Audio', assetId: 'Gagal', status: responseData.message || 'Error API', time: new Date().toLocaleString() });
            }
        } catch (err) {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            results.push({ name: displayName, type: 'Audio', assetId: 'Gagal', status: err.message, time: new Date().toLocaleString() });
        }
    }
    db.history.unshift(...results.map(r => ({ ...r, discordId })));
    writeDB(db);
    res.json({ success: true, results, remainingLimit: Math.max(0, 10 - db.limits[discordId].count) });
});

app.post('/api/upload-image', upload.array('images', 10), async (req, res) => {
    const { discordId, userId, apiKey } = req.body;
    const files = req.files;
    let customNames = req.body.customNames;
    if (!discordId || !userId || !files || files.length === 0) return res.status(400).json({ success: false, message: 'Fail atau sesi tidak lengkap.' });
    if (typeof customNames === 'string') customNames = [customNames];

    let db = readDB();
    let robloxUser = db.users[discordId];
    if (!robloxUser && apiKey) {
        robloxUser = { discordId, userId, apiKey };
        db.users[discordId] = robloxUser;
        writeDB(db);
    }
    if (!robloxUser) return res.status(401).json({ success: false, message: 'Akaun Roblox belum tersambung.' });

    const limitInfo = checkAndUseLimit(discordId);
    if (limitInfo.count + files.length > 10) return res.status(400).json({ success: false, message: `Had harian terlampaui. Baki had: ${10 - limitInfo.count}` });

    let results = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const baseName = (customNames && customNames[i]) ? customNames[i] : file.originalname.substring(0, file.originalname.lastIndexOf('.')) || file.originalname;
        const fileNameJpg = baseName + '.jpg';
        try {
            const fileStream = fs.createReadStream(file.path);
            const stats = fs.statSync(file.path);
            const formData = new FormData();
            formData.append('request', JSON.stringify({
                assetType: "Decal",
                displayName: fileNameJpg,
                description: "MCHLERN UPLOADER",
                creationContext: { creator: { userId: Number(userId) } }
            }));
            formData.append('fileContent', fileStream, { filename: fileNameJpg, knownLength: stats.size });

            const response = await fetch('https://apis.roblox.com/assets/v1/assets', {
                method: 'POST',
                headers: { 'x-api-key': robloxUser.apiKey, ...formData.getHeaders() },
                body: formData
            });
            const responseData = await response.json();
            fs.unlinkSync(file.path);

            if (response.ok && responseData.path) {
                const pollResult = await pollOperationStatus(responseData.path, robloxUser.apiKey);
                if (pollResult.success) {
                    results.push({ name: fileNameJpg, type: 'Image', assetId: pollResult.assetId, status: 'Success', time: new Date().toLocaleString() });
                    // MENAMBAHKAN COUNTER LIMIT HARIAN SETIAP BERHASIL UPLOAD GAMBAR
                    db.limits[discordId].count += 1;
                } else {
                    results.push({ name: fileNameJpg, type: 'Image', assetId: 'Gagal', status: pollResult.message, time: new Date().toLocaleString() });
                }
            } else {
                results.push({ name: fileNameJpg, type: 'Image', assetId: 'Gagal', status: responseData.message || 'Error API', time: new Date().toLocaleString() });
            }
        } catch (err) {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            results.push({ name: fileNameJpg, type: 'Image', assetId: 'Gagal', status: err.message, time: new Date().toLocaleString() });
        }
    }
    db.history.unshift(...results.map(r => ({ ...r, discordId })));
    writeDB(db);
    res.json({ success: true, results, remainingLimit: Math.max(0, 10 - db.limits[discordId].count) });
});

app.listen(PORT, () => { console.log(`Server berjalan di port ${PORT}`); });
