const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'spc-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';

// 부팅 시 기본 관리자 보장: admin@spc.local / demo1234
async function ensureDefaultAdmin() {
  try {
    const { rows } = await query('SELECT id FROM account WHERE email = $1', ['admin@spc.local']);
    if (rows.length === 0) {
      const hash = await bcrypt.hash('demo1234', 10);
      await query(
        `INSERT INTO account (email, password_hash, name, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')`,
        ['admin@spc.local', hash, '관리자'],
      );
      console.log('[AUTH] 기본 관리자 생성: admin@spc.local / demo1234');
    }
  } catch (err) {
    console.error('[AUTH] 기본 관리자 보장 실패:', err.message);
  }
}

function signToken(account) {
  return jwt.sign(
    { id: account.id, email: account.email, role: account.role, name: account.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  );
}

async function login(email, password) {
  const { rows } = await query('SELECT * FROM account WHERE email = $1', [email]);
  const acc = rows[0];
  if (!acc || acc.status !== 'active') return null;
  const ok = await bcrypt.compare(password, acc.password_hash);
  if (!ok) return null;
  await query('UPDATE account SET last_login_at = now() WHERE id = $1', [acc.id]);
  return {
    token: signToken(acc),
    account: { id: acc.id, email: acc.email, name: acc.name, role: acc.role },
  };
}

// 인증 미들웨어
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED', message: '토큰이 없습니다' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHENTICATED', message: '토큰이 유효하지 않습니다' });
  }
}

// 역할 제한 미들웨어
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '권한이 부족합니다' });
    }
    next();
  };
}

async function createAccount({ email, password, name, role }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO account (email, password_hash, name, role, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, email, name, role, status, created_at`,
    [email, hash, name, role || 'viewer'],
  );
  return rows[0];
}

module.exports = { ensureDefaultAdmin, login, authenticate, requireRole, createAccount };
