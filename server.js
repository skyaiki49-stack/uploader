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

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = { users: {}, history: [], limits: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkAndUseLimit(userId) {
    let db = readDB();
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (!db.limits[userId]) {
        db.limits[userId] = { count: 0, resetTime: now + TWENTY_FOUR_HOURS };
    }
    if (now > db.limits[userId].resetTime) {
        db.limits[userId].count = 0;
        db.limits[userId].resetTime = now + TWENTY_FOUR_HOURS;
    }
    writeDB(db);
    return db.limits[userId];
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

app.post('/api/connect', async (req, res) => {
    const { userId, apiKey } = req.body;
    if (!userId || !apiKey) return res.status(400).json({ success: false, message: 'User ID dan API Key wajib diisi.' });
    try {
        const userRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
        if (!userRes.ok) return res.status(400).json({ success: false, message: 'User ID Roblox tidak ditemui.' });
        const userData = await userRes.json();
        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
        const thumbData = await thumbRes.json();
        const avatarUrl = thumbData.data && thumbData.data.length > 0 ? thumbData.data[0].imageUrl : 'https://tr.rbxcdn.com/3941443493e947d5ce177894f6f7093b/150/150/Image/Png';

        let db = readDB();
        db.users[userId] = { userId, apiKey, username: userData.name, displayName: userData.displayName, avatar: avatarUrl };
        writeDB(db);
        res.json({ success: true, profile: { userId, username: userData.name, displayName: userData.displayName, avatar: avatarUrl } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal menyambungkan ke akaun Roblox.' });
    }
});

app.get('/api/limit/:userId', (req, res) => {
    const { userId } = req.params;
    const limitInfo = checkAndUseLimit(userId);
    const remaining = Math.max(0, 10 - limitInfo.count);
    res.json({ success: true, remaining, totalUsed: limitInfo.count });
});

async function getOrRestoreUser(userId, apiKey, db) {
    if (db.users[userId]) return db.users[userId];
    if (apiKey) {
        try {
            const userRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
            if (userRes.ok) {
                const userData = await userRes.json();
                const newUser = { userId, apiKey, username: userData.name, displayName: userData.displayName, avatar: '' };
                db.users[userId] = newUser;
                writeDB(db);
                return newUser;
            }
        } catch (e) {}
    }
    return null;
}

app.post('/api/upload-audio', upload.array('audios', 20), async (req, res) => {
    const { userId, apiKey } = req.body;
    const files = req.files;
    let customNames = req.body.customNames;
    if (!userId || !files || files.length === 0) return res.status(400).json({ success: false, message: 'Fail audio tidak lengkap.' });
    if (typeof customNames === 'string') customNames = [customNames];

    let db = readDB();
    let user = await getOrRestoreUser(userId, apiKey, db);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Akaun belum tersambung atau API Key hilang. Sila sambung semula di Setting.' });
    }

    const limitInfo = checkAndUseLimit(userId);
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
                headers: { 'x-api-key': user.apiKey, ...formData.getHeaders() },
                body: formData
            });
            const responseData = await response.json();
            fs.unlinkSync(file.path);

            if (response.ok && responseData.path) {
                const pollResult = await pollOperationStatus(responseData.path, user.apiKey);
                if (pollResult.success) {
                    results.push({ name: displayName, type: 'Audio', assetId: pollResult.assetId, status: 'Success', time: new Date().toLocaleString() });
                    db.limits[userId].count += 1;
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
    db.history.unshift(...results.map(r => ({ ...r, userId })));
    writeDB(db);
    res.json({ success: true, results, remainingLimit: 10 - db.limits[userId].count });
});

app.post('/api/upload-image', upload.array('images', 10), async (req, res) => {
    const { userId, apiKey } = req.body;
    const files = req.files;
    let customNames = req.body.customNames;
    if (!userId || !files || files.length === 0) return res.status(400).json({ success: false, message: 'Fail gambar tidak lengkap.' });
    if (typeof customNames === 'string') customNames = [customNames];

    let db = readDB();
    let user = await getOrRestoreUser(userId, apiKey, db);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Akaun belum tersambung atau API Key hilang.' });
    }

    const limitInfo = checkAndUseLimit(userId);
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
                headers: { 'x-api-key': user.apiKey, ...formData.getHeaders() },
                body: formData
            });
            const responseData = await response.json();
            fs.unlinkSync(file.path);

            if (response.ok && responseData.path) {
                const pollResult = await pollOperationStatus(responseData.path, user.apiKey);
                if (pollResult.success) {
                    results.push({ name: fileNameJpg, type: 'Image', assetId: pollResult.assetId, status: 'Success', time: new Date().toLocaleString() });
                    db.limits[userId].count += 1;
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
    db.history.unshift(...results.map(r => ({ ...r, userId })));
    writeDB(db);
    res.json({ success: true, results, remainingLimit: 10 - db.limits[userId].count });
});

app.get('/api/history/:userId', (req, res) => {
    const { userId } = req.params;
    let db = readDB();
    const userHistory = db.history.filter(h => h.userId === userId);
    const limitInfo = checkAndUseLimit(userId);
    res.json({ success: true, history: userHistory, totalUpload: userHistory.length, remainingLimit: Math.max(0, 10 - limitInfo.count) });
});

app.listen(PORT, () => { console.log(`Server berjalan di port ${PORT}`); });
