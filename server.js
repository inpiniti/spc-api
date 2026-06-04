const express = require('express');
const http = require('http');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const { query } = require('./db');
const { ensureDefaultAdmin, login, authenticate, requireRole, createAccount } = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const GATEWAY_HTTP_PORT = parseInt(process.env.GATEWAY_HTTP_PORT || '3001', 10);
const DEVICE_HOST = process.env.DEVICE_HOST || '127.0.0.1';
const DEVICE_PORT = parseInt(process.env.DEVICE_PORT || '3002', 10);

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 작은 HTTP 요청 헬퍼 (gateway/device 프록시용)
function httpPost(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host, port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(data); } catch { /* noop */ }
          resolve({ status: res.statusCode, data: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── 헬스 ──────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /health:
 *   get: { summary: 서버 상태, tags: [Health], responses: { 200: { description: ok } } }
 */
app.get('/health', async (req, res) => {
  let db = false;
  try { await query('SELECT 1'); db = true; } catch { /* noop */ }
  res.json({ status: 'ok', db, timestamp: new Date().toISOString() });
});

// ── 인증 ──────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: 로그인 (JWT 발급)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { email: { type: string }, password: { type: string } } }
 *           example: { email: admin@spc.local, password: demo1234 }
 *     responses:
 *       200: { description: 성공 }
 *       401: { description: 인증 실패 }
 */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'email/password 필요' });
  try {
    const result = await login(email, password);
    if (!result) return res.status(401).json({ error: 'UNAUTHENTICATED', message: '이메일 또는 비밀번호가 올바르지 않습니다' });
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/me:
 *   get: { summary: 현재 로그인 계정, tags: [Auth], security: [{ bearerAuth: [] }], responses: { 200: { description: ok } } }
 */
app.get('/api/me', authenticate, (req, res) => {
  res.json({ ok: true, data: req.user });
});

// ── 사이트 ────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sites:
 *   get: { summary: 사이트 목록, tags: [Sites], responses: { 200: { description: ok } } }
 */
app.get('/api/sites', async (req, res) => {
  try {
    const { rows } = await query('SELECT id, site_key, name, address, latitude, longitude FROM site ORDER BY site_key');
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 디바이스 목록/상세 ───────────────────────────────────────────────────────
/**
 * @swagger
 * /api/devices:
 *   get:
 *     summary: 디바이스 목록
 *     tags: [Devices]
 *     parameters:
 *       - { in: query, name: siteKey, schema: { type: string } }
 *       - { in: query, name: statusUse, schema: { type: string } }
 *       - { in: query, name: q, schema: { type: string } }
 *     responses: { 200: { description: ok } }
 */
app.get('/api/devices', async (req, res) => {
  const { siteKey, statusUse, q, assignedAccountId } = req.query;
  const where = [];
  const params = [];
  if (siteKey)   { params.push(siteKey);   where.push(`site_key = $${params.length}`); }
  if (statusUse) { params.push(statusUse); where.push(`status_use = $${params.length}`); }
  if (q)         { params.push(`%${q}%`);   where.push(`(device_id ILIKE $${params.length} OR name ILIKE $${params.length})`); }
  if (assignedAccountId !== undefined && assignedAccountId !== '') {
    const accId = parseInt(assignedAccountId, 10);
    if (Number.isNaN(accId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'assignedAccountId 는 숫자여야 합니다' });
    }
    params.push(accId);
    where.push(`assigned_account_id = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const { rows } = await query(
      `SELECT id, device_id, site_key, type, device_key, name, location, latitude, longitude,
              status_use, description, install_date, model_name, serial_no, interface_version,
              connected, last_status_datetime, last_pt_cur, last_p_con, last_pe_cur,
              last_operation_status, last_operation, last_status_code, assigned_account_id
       FROM device ${clause} ORDER BY device_id`,
      params,
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}:
 *   get: { summary: 디바이스 상세, tags: [Devices], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok }, 404: { description: 없음 } } }
 */
app.get('/api/devices/:deviceId', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM device WHERE device_id = $1', [req.params.deviceId]);
    if (rows.length === 0) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    const setting = await query('SELECT * FROM device_setting WHERE device_id = $1', [req.params.deviceId]);
    res.json({ ok: true, data: { ...rows[0], setting: setting.rows[0] || null } });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices:
 *   post: { summary: 디바이스 등록, tags: [Devices], security: [{ bearerAuth: [] }], responses: { 200: { description: ok } } }
 */
app.post('/api/devices', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const d = req.body || {};
  if (!d.deviceId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'deviceId 필요' });
  try {
    const { rows } = await query(
      `INSERT INTO device (device_id, site_key, type, device_key, name, description, location,
                           latitude, longitude, status_use, install_date, model_name, serial_no,
                           interface_version, assigned_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'Active'),$11,$12,$13,$14,$15)
       ON CONFLICT (device_id) DO NOTHING
       RETURNING *`,
      [d.deviceId, d.siteKey || d.deviceId.slice(0,2), d.type || d.deviceId.slice(2,3),
       d.deviceKey || d.deviceId.slice(3,7), d.name, d.description, d.location,
       d.latitude, d.longitude, d.statusUse, d.installDate, d.modelName, d.serialNo,
       d.interfaceVersion, d.assignedAccountId],
    );
    if (rows.length === 0) return res.status(409).json({ error: 'COMMAND_CONFLICT', message: '이미 존재하는 deviceId' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}:
 *   put: { summary: 디바이스 마스터 수정, tags: [Devices], security: [{ bearerAuth: [] }], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.put('/api/devices/:deviceId', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const d = req.body || {};
  try {
    const { rows } = await query(
      `UPDATE device SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         location = COALESCE($4, location),
         latitude = COALESCE($5, latitude),
         longitude = COALESCE($6, longitude),
         status_use = COALESCE($7, status_use),
         install_date = COALESCE($8, install_date),
         model_name = COALESCE($9, model_name),
         serial_no = COALESCE($10, serial_no),
         interface_version = COALESCE($11, interface_version),
         assigned_account_id = COALESCE($12, assigned_account_id),
         updated_at = now()
       WHERE device_id = $1 RETURNING *`,
      [req.params.deviceId, d.name, d.description, d.location, d.latitude, d.longitude,
       d.statusUse, d.installDate, d.modelName, d.serialNo, d.interfaceVersion, d.assignedAccountId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}:
 *   delete: { summary: 디바이스 삭제, tags: [Devices], security: [{ bearerAuth: [] }], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.delete('/api/devices/:deviceId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM device WHERE device_id = $1', [req.params.deviceId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 시계열 ────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/devices/{deviceId}/data:
 *   get:
 *     summary: 디바이스 시계열 데이터
 *     tags: [Device Data]
 *     parameters:
 *       - { in: path, name: deviceId, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 100 } }
 *       - { in: query, name: from, schema: { type: string } }
 *       - { in: query, name: to, schema: { type: string } }
 *     responses: { 200: { description: ok } }
 */
app.get('/api/devices/:deviceId/data', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 5000);
  const params = [req.params.deviceId];
  let extra = '';
  if (req.query.from) { params.push(req.query.from); extra += ` AND received_at >= $${params.length}`; }
  if (req.query.to)   { params.push(req.query.to);   extra += ` AND received_at <= $${params.length}`; }
  params.push(limit);
  try {
    const { rows } = await query(
      `SELECT device_id, status_datetime, received_at, pt_cur, pt_b, p_con, pe_cur,
              operation_status, operation, remain_time_minutes, remain_time_seconds, status_code
       FROM device_data WHERE device_id = $1 ${extra}
       ORDER BY received_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}/data/latest:
 *   get: { summary: 최신 1건, tags: [Device Data], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.get('/api/devices/:deviceId/data/latest', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM device_data WHERE device_id = $1 ORDER BY received_at DESC LIMIT 1',
      [req.params.deviceId],
    );
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 알람 ──────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/alarms:
 *   get:
 *     summary: 전체 알람
 *     tags: [Alarms]
 *     parameters:
 *       - { in: query, name: acknowledged, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 100 } }
 *     responses: { 200: { description: ok } }
 */
app.get('/api/alarms', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const assignedAccountId = req.query.assignedAccountId;
  const params = [];
  const whereParts = [];
  let joinSql = 'LEFT JOIN alarm_code c ON c.code = a.alarm_code';
  if (req.query.acknowledged === 'true' || req.query.acknowledged === 'false') {
    params.push(req.query.acknowledged === 'true');
    whereParts.push(`a.acknowledged = $${params.length}`);
  }
  if (assignedAccountId !== undefined && assignedAccountId !== '') {
    const accId = parseInt(assignedAccountId, 10);
    if (Number.isNaN(accId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'assignedAccountId 는 숫자여야 합니다' });
    }
    params.push(accId);
    joinSql += ' INNER JOIN device d ON d.device_id = a.device_id';
    whereParts.push(`d.assigned_account_id = $${params.length}`);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  params.push(limit);
  try {
    const { rows } = await query(
      `SELECT a.*, c.name AS code_name, c.severity AS code_severity
       FROM device_alarm a ${joinSql}
       ${where} ORDER BY a.received_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}/alarms:
 *   get: { summary: 디바이스 알람, tags: [Alarms], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.get('/api/devices/:deviceId/alarms', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
  try {
    const { rows } = await query(
      'SELECT * FROM device_alarm WHERE device_id = $1 ORDER BY received_at DESC LIMIT $2',
      [req.params.deviceId, limit],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/alarms/{id}/ack:
 *   post: { summary: 알람 확인, tags: [Alarms], security: [{ bearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: integer } }], responses: { 200: { description: ok } } }
 */
app.post('/api/alarms/:id/ack', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE device_alarm SET acknowledged = true, acknowledged_by = $2, acknowledged_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 설정 ──────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/devices/{deviceId}/setting:
 *   get: { summary: 디바이스 설정 조회, tags: [Settings], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.get('/api/devices/:deviceId/setting', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM device_setting WHERE device_id = $1', [req.params.deviceId]);
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}/setting:
 *   put: { summary: 디바이스 설정 저장, tags: [Settings], security: [{ bearerAuth: [] }], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.put('/api/devices/:deviceId/setting', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const s = req.body || {};
  try {
    const { rows } = await query(
      `INSERT INTO device_setting (
         device_id, data_cycle, data_cycle_unit, network_cycle, network_cycle_unit,
         p_con, p_max, p_min, p_con_p, p_con_m, ud_con, vd_con, pel1, pel2,
         is_use_max, is_use_min, dp_con, delay_time, delay_time_unit,
         motor_step_angle, reducer, turn_angle,
         alarm_setting_001, alarm_setting_002, alarm_setting_003,
         alarm_setting_004, alarm_setting_005, alarm_setting_006, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28, now(), $29)
       ON CONFLICT (device_id) DO UPDATE SET
         data_cycle=EXCLUDED.data_cycle, data_cycle_unit=EXCLUDED.data_cycle_unit,
         network_cycle=EXCLUDED.network_cycle, network_cycle_unit=EXCLUDED.network_cycle_unit,
         p_con=EXCLUDED.p_con, p_max=EXCLUDED.p_max, p_min=EXCLUDED.p_min,
         p_con_p=EXCLUDED.p_con_p, p_con_m=EXCLUDED.p_con_m, ud_con=EXCLUDED.ud_con, vd_con=EXCLUDED.vd_con,
         pel1=EXCLUDED.pel1, pel2=EXCLUDED.pel2, is_use_max=EXCLUDED.is_use_max, is_use_min=EXCLUDED.is_use_min,
         dp_con=EXCLUDED.dp_con, delay_time=EXCLUDED.delay_time, delay_time_unit=EXCLUDED.delay_time_unit,
         motor_step_angle=EXCLUDED.motor_step_angle, reducer=EXCLUDED.reducer, turn_angle=EXCLUDED.turn_angle,
         alarm_setting_001=EXCLUDED.alarm_setting_001, alarm_setting_002=EXCLUDED.alarm_setting_002,
         alarm_setting_003=EXCLUDED.alarm_setting_003, alarm_setting_004=EXCLUDED.alarm_setting_004,
         alarm_setting_005=EXCLUDED.alarm_setting_005, alarm_setting_006=EXCLUDED.alarm_setting_006,
         updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING *`,
      [req.params.deviceId, s.dataCycle, s.dataCycleUnit, s.networkCycle, s.networkCycleUnit,
       s.pCon, s.pMax, s.pMin, s.pConP, s.pConM, s.udCon, s.vdCon, s.pel1, s.pel2,
       s.isUseMax, s.isUseMin, s.dpCon, s.delayTime, s.delayTimeUnit,
       s.motorStepAngle, s.reducer, s.turnAngle,
       s.alarmSetting001, s.alarmSetting002, s.alarmSetting003,
       s.alarmSetting004, s.alarmSetting005, s.alarmSetting006, req.user.id],
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 제어 ──────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/devices/{deviceId}/control:
 *   post:
 *     summary: 운전/정지 제어
 *     tags: [Control]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { operation: { type: string, enum: ['1','2'] } } }
 *           example: { operation: '1' }
 *     responses: { 200: { description: ok }, 404: { description: 미연결 } }
 */
app.post('/api/devices/:deviceId/control', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const { deviceId } = req.params;
  const { operation } = req.body || {};
  if (!operation || !['1', '2'].includes(operation)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: "operation 은 '1'(운전) 또는 '2'(정지)" });
  }
  try {
    // 운전 명령이면 시뮬레이터 자동 기동 (TCP 세션 확보)
    if (operation === '1') {
      try {
        await httpPost(DEVICE_HOST, DEVICE_PORT, `/api/devices/${deviceId}/start`, {});
        await new Promise((r) => setTimeout(r, 1000));
      } catch { /* 기동 실패해도 진행 */ }
    }
    const gw = await httpPost(GATEWAY_HOST, GATEWAY_HTTP_PORT, `/api/devices/${deviceId}/control`, { operation });
    if (gw.status !== 200) {
      if (gw.status === 404) return res.status(404).json({ error: 'DEVICE_NOT_FOUND', message: gw.data.message || 'device not connected' });
      return res.status(gw.status).json(gw.data);
    }
    await query(
      `INSERT INTO audit_log (account_id, action, target_type, target_id, payload)
       VALUES ($1, 'device.control', 'device', $2, $3)`,
      [req.user.id, deviceId, JSON.stringify({ operation })],
    );
    res.json({ ok: true, data: { message: `제어 명령 전송: operation=${operation === '1' ? '운전' : '정지'}` } });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/devices/{deviceId}/commands:
 *   get: { summary: 명령 이력, tags: [Control], parameters: [{ in: path, name: deviceId, required: true, schema: { type: string } }], responses: { 200: { description: ok } } }
 */
app.get('/api/devices/:deviceId/commands', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const { rows } = await query(
      'SELECT * FROM device_command WHERE device_id = $1 ORDER BY COALESCE(requested_at, sent_at) DESC LIMIT $2',
      [req.params.deviceId, limit],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 계정 (admin) ──────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/accounts:
 *   get: { summary: 계정 목록, tags: [Accounts], security: [{ bearerAuth: [] }], responses: { 200: { description: ok } } }
 */
app.get('/api/accounts', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query('SELECT id, email, name, role, status, last_login_at, created_at FROM account ORDER BY id');
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * @swagger
 * /api/accounts:
 *   post: { summary: 계정 등록, tags: [Accounts], security: [{ bearerAuth: [] }], responses: { 200: { description: ok } } }
 */
app.post('/api/accounts', authenticate, requireRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'email/password/name 필요' });
  try {
    const acc = await createAccount({ email, password, name, role });
    res.json({ ok: true, data: acc });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'COMMAND_CONFLICT', message: '이미 존재하는 email' });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path }));

ensureDefaultAdmin().finally(() => {
  app.listen(PORT, () => {
    console.log(`✅ SPC API Server :${PORT}`);
    console.log(`📚 Swagger: http://localhost:${PORT}/api-docs`);
  });
});
