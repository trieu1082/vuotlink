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

// ====== Mã hóa / Giải mã (optional) ======
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

// ====== GitHub API helpers ======
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
        const content = Buffer.from(res.data.content, 'base64').toString('utf8');
        return decrypt(content);
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
    const body = {
        message: 'update db',
        content: encoded,
        branch: GITHUB_BRANCH,
    };
    if (sha) body.sha = sha;
    await ghApi.put(`/contents/${filePath}`, body);
}

// ====== Database ======
const DB_PATH = 'db.json';
const DB_BACKUP_PATH = 'db.backup.json';
let DB = {
    users: {},        // key: username
    links: [],        // { id, user_id, original_url, short_code, reward_per_click, user_reward_per_click, clicks, created_at }
    clicks: [],       // { link_id, ip, user_agent, time }
    codes: [],        // { id, user_id, code, amount, status, created_at }
    nextLinkId: 1,
    nextCodeId: 1,
};

function cleanExpiredLinks() {
    const now = Date.now();
    DB.links = DB.links.filter(link => {
        const created = new Date(link.created_at).getTime();
        const expires = created + 4 * 60 * 60 * 1000; // 4 tiếng
        return now < expires;
    });
}

async function loadDB() {
    try {
        let raw = await fetchFileFromGithub(DB_PATH);
        if (raw) {
            const data = JSON.parse(raw);
            if (data && data.users) {
                DB = data;
                if (!DB.links) DB.links = [];
                if (!DB.clicks) DB.clicks = [];
                if (!DB.codes) DB.codes = [];
                if (!DB.nextLinkId) DB.nextLinkId = 1;
                if (!DB.nextCodeId) DB.nextCodeId = 1;
                cleanExpiredLinks();
                return;
            }
        }
        raw = await fetchFileFromGithub(DB_BACKUP_PATH);
        if (raw) {
            const data = JSON.parse(raw);
            if (data && data.users) {
                DB = data;
                if (!DB.links) DB.links = [];
                if (!DB.clicks) DB.clicks = [];
                if (!DB.codes) DB.codes = [];
                if (!DB.nextLinkId) DB.nextLinkId = 1;
                if (!DB.nextCodeId) DB.nextCodeId = 1;
                cleanExpiredLinks();
                return;
            }
        }
    } catch (e) {
        console.error('Lỗi load DB từ GitHub, dùng DB rỗng', e);
    }
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
            console.log('DB saved to GitHub');
        } catch (err) {
            console.error('Lỗi save DB', err);
        }
    }, 5000);
}

// ====== JWT Middleware ======
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token is required' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

function generateShortCode() {
    return crypto.randomBytes(3).toString('hex');
}

// ====== API Endpoints ======

// Đăng ký
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (DB.users[username]) return res.status(400).json({ error: 'Username already exists' });
    const id = Object.keys(DB.users).length + 1;
    DB.users[username] = { id, username, password, balance: 0, role: 'user' };
    scheduleSave();
    res.json({ id, username });
});

// Đăng nhập
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = DB.users[username];
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, role: user.role } });
});

// Tạo link rút gọn
app.post('/api/shorten', authenticateToken, (req, res) => {
    const { originalUrl, customReward, customUserReward } = req.body;
    const userId = req.user.id;
    if (!originalUrl) return res.status(400).json({ error: 'Missing originalUrl' });
    const reward = customReward || 700;
    const userReward = customUserReward || 500;
    const shortCode = generateShortCode();
    const link = {
        id: DB.nextLinkId++,
        user_id: userId,
        original_url: originalUrl,
        short_code: shortCode,
        reward_per_click: reward,
        user_reward_per_click: userReward,
        clicks: 0,
        created_at: new Date().toISOString()
    };
    DB.links.push(link);
    scheduleSave();
    const shortUrl = `${req.protocol}://${req.get('host')}/${shortCode}`;
    res.json({ shortCode, shortUrl });
});

// Danh sách link của user
app.get('/api/links', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const userLinks = DB.links.filter(link => link.user_id === userId);
    res.json(userLinks);
});

// Redirect và cộng coin
app.get('/:shortCode', (req, res) => {
    const code = req.params.shortCode;
    const link = DB.links.find(l => l.short_code === code);
    if (!link) return res.status(404).send('<h1>Link not found</h1>');
    
    // Kiểm tra hết hạn
    const createdTime = new Date(link.created_at).getTime();
    const expiresTime = createdTime + 4 * 60 * 60 * 1000;
    if (Date.now() > expiresTime) {
        DB.links = DB.links.filter(l => l.id !== link.id);
        scheduleSave();
        return res.status(410).send('<h1>Link đã hết hạn</h1>');
    }

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // Anti-bypass: không cộng tiền nếu cùng IP trong 1 giờ
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentClick = DB.clicks.find(c => c.link_id === link.id && c.ip === ip && c.time > oneHourAgo);
    if (recentClick) {
        return res.redirect(link.original_url);
    }

    // Ghi log click
    DB.clicks.push({ link_id: link.id, ip, user_agent: userAgent, time: Date.now() });
    link.clicks++;

    // Cộng coin cho chủ link
    const user = Object.values(DB.users).find(u => u.id === link.user_id);
    if (user) {
        user.balance = (user.balance || 0) + (link.user_reward_per_click || 500);
    }
    scheduleSave();
    res.redirect(link.original_url);
});

// Thông tin user
app.get('/api/user', authenticateToken, (req, res) => {
    const user = Object.values(DB.users).find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, balance: user.balance, role: user.role });
});

// Đổi coin thành code
app.post('/api/create-code', authenticateToken, (req, res) => {
    const { amount } = req.body;
    const userId = req.user.id;
    if (!amount || amount < 10000) return res.status(400).json({ error: 'Minimum withdrawal is 10,000 coin' });
    const user = Object.values(DB.users).find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const code = crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + amount;
    const newCode = {
        id: DB.nextCodeId++,
        user_id: userId,
        code,
        amount,
        status: 'pending',
        created_at: new Date().toISOString()
    };
    DB.codes.push(newCode);
    user.balance -= amount;
    scheduleSave();
    res.json({ success: true, code });
});

// Admin: lấy danh sách code
app.get('/api/admin/codes', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Access denied' });
    const search = req.query.search || '';
    const filtered = DB.codes.filter(c => c.code.includes(search));
    const result = filtered.map(c => {
        const user = Object.values(DB.users).find(u => u.id === c.user_id);
        return { ...c, username: user ? user.username : 'unknown' };
    });
    res.json(result);
});

// Admin: cập nhật trạng thái code
app.post('/api/admin/code-status', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Access denied' });
    const { codeId, status } = req.body;
    const codeEntry = DB.codes.find(c => c.id === codeId);
    if (!codeEntry) return res.status(404).json({ error: 'Code not found' });
    codeEntry.status = status;
    scheduleSave();
    res.json({ success: true });
});

// Trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pmt.html'));
});

// Dọn link hết hạn mỗi 10 phút
setInterval(() => {
    cleanExpiredLinks();
    scheduleSave();
}, 10 * 60 * 1000);

// Khởi động
loadDB().then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
    console.error('Không thể khởi động server', err);
});
