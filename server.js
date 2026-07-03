require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error('Missing GITHUB_TOKEN or GITHUB_REPO in .env');
    process.exit(1);
}

function encrypt(text) {
    if (!ENCRYPTION_KEY) return text;
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    return iv.toString('base64') + ':' + cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
}

function decrypt(text) {
    if (!ENCRYPTION_KEY) return text;
    const parts = text.split(':');
    if (parts.length !== 2) return text;
    try {
        const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
        const iv = Buffer.from(parts[0], 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return decipher.update(parts[1], 'base64', 'utf8') + decipher.final('utf8');
    } catch { return null; }
}

const ghApi = axios.create({
    baseURL: `https://api.github.com/repos/${GITHUB_REPO}`,
    headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
    },
});

async function fetchFileFromGithub(filePath) {
    try {
        const res = await ghApi.get(`/contents/${filePath}`, { params: { ref: GITHUB_BRANCH } });
        return decrypt(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (err) {
        if (err.response && err.response.status === 404) return null;
        throw err;
    }
}

async function pushFileToGithub(filePath, content) {
    const encrypted = encrypt(content);
    const encoded = Buffer.from(encrypted).toString('base64');
    let sha;
    try {
        const existing = await ghApi.get(`/contents/${filePath}`, { params: { ref: GITHUB_BRANCH } });
        sha = existing.data.sha;
    } catch (err) {
        if (err.response && err.response.status !== 404) throw err;
    }
    await ghApi.put(`/contents/${filePath}`, {
        message: 'update db',
        content: encoded,
        branch: GITHUB_BRANCH,
        ...(sha && { sha })
    });
}

const DB_PATH = 'db.json';
const DB_BACKUP_PATH = 'db.backup.json';
let DB = {
    users: {},
    links: [],
    clicks: [],
    codes: [],
    nextLinkId: 1,
    nextCodeId: 1,
};

function cleanExpiredLinks() {
    const now = Date.now();
    DB.links = DB.links.filter(link => {
        const created = new Date(link.created_at).getTime();
        return now < created + 4 * 60 * 60 * 1000;
    });
}

async function loadDB() {
    try {
        let raw = await fetchFileFromGithub(DB_PATH);
        if (raw && (raw = JSON.parse(raw)) && raw.users) {
            DB = { ...DB, ...raw };
            cleanExpiredLinks();
            return;
        }
    } catch {}
    try {
        let raw = await fetchFileFromGithub(DB_BACKUP_PATH);
        if (raw && (raw = JSON.parse(raw)) && raw.users) {
            DB = { ...DB, ...raw };
            cleanExpiredLinks();
            return;
        }
    } catch {}
    DB = { users: {}, links: [], clicks: [], codes: [], nextLinkId: 1, nextCodeId: 1 };
}

let saveTimeout;
function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            const data = JSON.stringify(DB);
            await pushFileToGithub(DB_PATH, data);
            await pushFileToGithub(DB_BACKUP_PATH, data);
            console.log('DB saved');
        } catch (e) { console.error('Save error:', e); }
    }, 5000);
}

function authenticateToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

function generateShortCode() {
    return crypto.randomBytes(3).toString('hex');
}

// ---------- API DỊCH VỤ TẠO LINK RÚT GỌN ----------
const serviceConfig = {
    linktot: {
        url: process.env.LINKTOT_API_URL || 'https://linktot.net/api',
        token: process.env.LINKTOT_API_TOKEN,
    },
    layma: {
        url: process.env.LAYMA_API_URL || 'https://quanly.layma.net/api',
        token: process.env.LAYMA_API_TOKEN,
    },
    link4m: {
        url: process.env.LINK4M_API_URL || 'https://my.link4m.com/api',
        token: process.env.LINK4M_API_TOKEN,
    },
};

async function createServiceShortLink(service, longUrl) {
    const cfg = serviceConfig[service];
    if (!cfg || !cfg.token) throw new Error('Service not configured');
    // Gọi API dịch vụ – giả định POST với JSON { url: longUrl, api_token: cfg.token }
    try {
        const response = await axios.post(cfg.url, {
            url: longUrl,
            api_token: cfg.token,
        }, { timeout: 10000 });
        if (response.data && response.data.short_url) {
            return response.data.short_url;
        }
        if (response.data && response.data.short) {
            return response.data.short;
        }
        throw new Error('Unexpected response format');
    } catch (err) {
        throw new Error(`Service error: ${err.message}`);
    }
}

// ---------- ENDPOINTS ----------
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (DB.users[username]) return res.status(400).json({ error: 'Username exists' });
    const id = Object.keys(DB.users).length + 1;
    DB.users[username] = { id, username, password, balance: 0, role: 'user' };
    scheduleSave();
    res.json({ id, username });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = DB.users[username];
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, role: user.role } });
});

app.post('/api/shorten', authenticateToken, async (req, res) => {
    const { service, url, userReward } = req.body;
    const userId = req.user.id;
    if (!service || !url) return res.status(400).json({ error: 'Missing service or url' });
    if (!['linktot', 'layma', 'link4m'].includes(service)) return res.status(400).json({ error: 'Invalid service' });

    try {
        const shortUrl = await createServiceShortLink(service, url);
        const shortCode = generateShortCode();
        const link = {
            id: DB.nextLinkId++,
            user_id: userId,
            service,
            original_url: shortUrl,
            short_code: shortCode,
            reward_per_click: 700,
            user_reward_per_click: userReward || 500,
            clicks: 0,
            created_at: new Date().toISOString()
        };
        DB.links.push(link);
        scheduleSave();
        res.json({ shortCode, shortUrl: `${req.protocol}://${req.get('host')}/${shortCode}` });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

app.get('/api/links', authenticateToken, (req, res) => {
    res.json(DB.links.filter(l => l.user_id === req.user.id));
});

app.get('/:shortCode', (req, res) => {
    const code = req.params.shortCode;
    const link = DB.links.find(l => l.short_code === code);
    if (!link) return res.status(404).send('<h1>Link not found</h1>');

    const created = new Date(link.created_at).getTime();
    if (Date.now() > created + 4 * 60 * 60 * 1000) {
        DB.links = DB.links.filter(l => l.id !== link.id);
        scheduleSave();
        return res.status(410).send('<h1>Link expired</h1>');
    }

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const oneHourAgo = Date.now() - 3600000;
    if (DB.clicks.some(c => c.link_id === link.id && c.ip === ip && c.time > oneHourAgo)) {
        return res.redirect(link.original_url);
    }

    DB.clicks.push({ link_id: link.id, ip, user_agent: ua, time: Date.now() });
    link.clicks++;
    const user = Object.values(DB.users).find(u => u.id === link.user_id);
    if (user) user.balance = (user.balance || 0) + (link.user_reward_per_click || 500);
    scheduleSave();
    res.redirect(link.original_url);
});

app.get('/api/user', authenticateToken, (req, res) => {
    const user = Object.values(DB.users).find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, balance: user.balance, role: user.role });
});

app.post('/api/create-code', authenticateToken, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 10000) return res.status(400).json({ error: 'Min 10k' });
    const user = Object.values(DB.users).find(u => u.id === req.user.id);
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const code = crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + amount;
    DB.codes.push({
        id: DB.nextCodeId++,
        user_id: req.user.id,
        code,
        amount,
        status: 'pending',
        created_at: new Date().toISOString()
    });
    user.balance -= amount;
    scheduleSave();
    res.json({ success: true, code });
});

app.get('/api/admin/codes', authenticateToken, (req, res) => {
    if (!['admin','owner'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const search = req.query.search || '';
    const result = DB.codes
        .filter(c => c.code.includes(search))
        .map(c => ({ ...c, username: Object.values(DB.users).find(u => u.id === c.user_id)?.username || 'unknown' }));
    res.json(result);
});

app.post('/api/admin/code-status', authenticateToken, (req, res) => {
    if (!['admin','owner'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    const { codeId, status } = req.body;
    const entry = DB.codes.find(c => c.id === codeId);
    if (!entry) return res.status(404).json({ error: 'Code not found' });
    entry.status = status;
    scheduleSave();
    res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pmt.html')));

setInterval(() => {
    cleanExpiredLinks();
    scheduleSave();
}, 10 * 60 * 1000);

loadDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)));
