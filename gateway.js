// ── Gateway ↔ API 라우터 ──────────────────────────────────────────────────────
// IECP Gateway 전용 엔드포인트 모음. 일반 사용자 JWT 와 분리된 X-Gateway-Key 인증.
// 데이터 흐름도 / spc_gateway_postman_collection.json 의 계약을 구현한다.
//
//  GET   /api/v1/gateway/commands/poll        대기 명령 polling (pending → sent)
//  PATCH /api/v1/gateway/commands/:id/result  명령 실행 결과 보고 (sent → acked/failed)
//  POST  /api/v1/gateway/alarms               알람(701) 수신 → device_alarm INSERT
//  POST  /api/v1/gateway/device-status        장비 접속/해제 상태 보고
//  POST  /api/v1/gateway/annual-pressure      연간 압력 업로드 수신(503, 365개)
const express = require('express');
const { query } = require('./db');

const GATEWAY_KEY = process.env.GATEWAY_KEY || 'gw_secret_key_change_me';

// function_code → command_type 매핑 (v8 device_command.command_type)
const COMMAND_TYPE_BY_FC = {
  '300': 'operation',
  '500': 'cycle',
  '501': 'setting',
  '502': 'annual_pressure',
  '503': 'annual_request',
  '800': 'calc_pressure',
};

function requireGatewayKey(req, res, next) {
  const key = req.headers['x-gateway-key'];
  if (!key || key !== GATEWAY_KEY) {
    return res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'X-Gateway-Key 가 유효하지 않습니다' });
  }
  next();
}

const router = express.Router();
router.use(express.json({ limit: '2mb' })); // 연간압력 365개 배열 대비
router.use(requireGatewayKey);

// ── 명령 큐 polling ───────────────────────────────────────────────────────────
// pending 명령을 limit 개수만큼 가져가면서 sent 로 전이하고 transaction_id 를 부여한다.
// (long-poll wait 파라미터는 미지원 — 즉시 응답. Gateway 가 주기 폴링한다.)
router.get('/commands/poll', async (req, res) => {
  const gatewayId = req.query.gatewayId || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
  try {
    // 만료된 pending 명령 정리
    await query(
      `UPDATE device_command SET status = 'expired'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()`,
    );
    // pending → sent (동시 폴링 안전: FOR UPDATE SKIP LOCKED)
    const { rows } = await query(
      `UPDATE device_command SET status = 'sent', sent_at = now(), gateway_id = $1,
              transaction_id = (id % 10000)
       WHERE id IN (
         SELECT id FROM device_command
         WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now())
         ORDER BY priority DESC, created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, device_id, function_code, command_type, transaction_id, payload`,
      [gatewayId, limit],
    );
    const data = rows.map((r) => ({
      commandId: r.id,
      deviceId: r.device_id,
      functionCode: r.function_code,
      commandType: r.command_type,
      transactionId: r.transaction_id,
      payload: r.payload,
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 명령 결과 보고 ────────────────────────────────────────────────────────────
router.patch('/commands/:id/result', async (req, res) => {
  const { status, resultCode, resultMessage, respondedAt } = req.body || {};
  const newStatus = status === 'acked' ? 'acked' : status === 'failed' ? 'failed' : null;
  if (!newStatus) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: "status 는 'acked' 또는 'failed'" });
  }
  try {
    const { rows } = await query(
      `UPDATE device_command SET status = $2, result_code = $3, result_message = $4,
              completed_at = COALESCE($5::timestamptz, now())
       WHERE id = $1 RETURNING id`,
      [req.params.id, newStatus, resultCode == null ? null : resultCode, resultMessage || null, respondedAt || null],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: '명령을 찾을 수 없습니다' });
    res.json({ success: true, message: '명령 결과가 반영되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 알람(701) 수신 ────────────────────────────────────────────────────────────
// Gateway 가 KST→ISO 변환 후 전달. device_alarm 에 INSERT (WS push/SMS 는 3단계).
router.post('/alarms', async (req, res) => {
  const { deviceId, alarmDatetime, alarmType, alarmCode, branchId } = req.body || {};
  const did = String(deviceId || '').trim();
  if (!did) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'deviceId 필요' });
  try {
    // alarm_code 매핑으로 severity/message 보강
    let codeRow = null;
    if (alarmCode != null) {
      const r = await query('SELECT name, severity FROM alarm_code WHERE code = $1', [alarmCode]);
      codeRow = r.rows[0] || null;
    }
    const { rows } = await query(
      `INSERT INTO device_alarm (device_id, branch_id, alarm_datetime, alarm_type, alarm_code, message, severity, received_at)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, now()) RETURNING id`,
      [did, branchId == null ? null : branchId, alarmDatetime || null,
       alarmType == null ? null : alarmType, alarmCode == null ? null : alarmCode,
       codeRow ? codeRow.name : null, codeRow ? codeRow.severity : null],
    );
    res.status(201).json({ success: true, data: { alarmId: rows[0].id, pushed: false } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 장비 접속/해제 상태 보고 ──────────────────────────────────────────────────
router.post('/device-status', async (req, res) => {
  const { deviceId, status, gatewayId, ip, timestamp } = req.body || {};
  const did = String(deviceId || '').trim();
  if (!did || !['online', 'offline'].includes(status)) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: "deviceId / status('online'|'offline') 필요" });
  }
  try {
    if (status === 'online') {
      await query(
        `INSERT INTO device_connection (device_id, status, last_connected_at, gateway_id, ip, updated_at)
         VALUES ($1, 'online', COALESCE($2::timestamptz, now()), $3, $4, now())
         ON CONFLICT (device_id) DO UPDATE SET
           status = 'online', last_connected_at = COALESCE($2::timestamptz, now()),
           gateway_id = $3, ip = $4, updated_at = now()`,
        [did, timestamp || null, gatewayId || null, ip || null],
      );
    } else {
      await query(
        `INSERT INTO device_connection (device_id, status, last_disconnected_at, gateway_id, ip, updated_at)
         VALUES ($1, 'offline', COALESCE($2::timestamptz, now()), $3, $4, now())
         ON CONFLICT (device_id) DO UPDATE SET
           status = 'offline', last_disconnected_at = COALESCE($2::timestamptz, now()), updated_at = now()`,
        [did, timestamp || null, gatewayId || null, ip || null],
      );
    }
    // 장비 마스터(device.connected) 가 있으면 동기화 (best-effort)
    await query('UPDATE device SET connected = $2, updated_at = now() WHERE device_id = $1', [did, status === 'online']);
    res.json({ success: true, message: '상태가 갱신되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 연간 압력 업로드 수신 (503 응답, 365개) ───────────────────────────────────
router.post('/annual-pressure', async (req, res) => {
  const { deviceId, year, pressures } = req.body || {};
  const did = String(deviceId || '').trim();
  if (!did || !Array.isArray(pressures) || pressures.length === 0) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'deviceId / pressures(배열) 필요' });
  }
  const yr = parseInt(year, 10) || new Date().getFullYear();
  try {
    const values = [];
    const params = [];
    pressures.forEach((p, i) => {
      const base = i * 4;
      params.push(did, yr, i + 1, p);
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    });
    await query(
      `INSERT INTO annual_pressure (device_id, year, day_index, pressure)
       VALUES ${values.join(', ')}
       ON CONFLICT (device_id, year, day_index) DO UPDATE SET
         pressure = EXCLUDED.pressure, updated_at = now()`,
      params,
    );
    res.json({ success: true, data: { deviceId: did, year: yr, savedCount: pressures.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

module.exports = { router, requireGatewayKey, GATEWAY_KEY, COMMAND_TYPE_BY_FC };
