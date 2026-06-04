# SPC API Server

SPC IoT 시스템의 데이터를 REST API로 제공하는 서버입니다.

## 구조

```
spc-api/
  server.js         → Express API 서버
  swagger.js        → Swagger 설정
  package.json      → 의존성
```

## 설치 및 실행

### 1. 의존성 설치

```bash
cd spc-api
npm install
```

### 2. 서버 시작

```bash
npm start          # 프로덕션
npm run dev        # 개발 (nodemon)
```

서버는 `:3000` 포트에서 실행됩니다.

## API 문서

**Swagger UI**: http://localhost:3000/api-docs

### 주요 엔드포인트

#### 장비 상태 조회

```bash
# 모든 장비 상태
GET /api/devices

# 특정 장비 상태
GET /api/devices/{deviceId}
```

**응답 예:**
```json
{
  "device_id": "SPC0001",
  "last_pt_cur": 1.52,
  "last_p_con": 1.8,
  "last_pe_cur": 1.47,
  "last_operation_status": "1",
  "last_operation": "1",
  "last_status_datetime": "20260519120530",
  "received_at": "2026-05-19T12:05:30.000Z"
}
```

#### 시계열 데이터 조회

```bash
# 장비 데이터 (최근 100개)
GET /api/devices/{deviceId}/data?limit=100&offset=0
```

**응답:**
```json
[
  {
    "device_id": "SPC0001",
    "status_datetime": "20260519120530",
    "received_at": "2026-05-19T12:05:30.000Z",
    "pt_cur": 1.52,
    "p_con": 1.8,
    "pe_cur": 1.47,
    "operation_status": "1",
    "operation": "1",
    "status_code": 0
  }
]
```

#### 알람 조회

```bash
# 특정 장비 알람
GET /api/devices/{deviceId}/alarms?limit=50

# 전체 알람
GET /api/alarms?limit=100
```

#### 제어 명령 이력

```bash
GET /api/commands?limit=50
```

#### 장비 제어 (운전/정지)

```bash
# 운전
curl -X POST http://localhost:3000/api/devices/SPC0001/control \
  -H "Content-Type: application/json" \
  -d '{"operation":"1"}'

# 정지
curl -X POST http://localhost:3000/api/devices/SPC0001/control \
  -H "Content-Type: application/json" \
  -d '{"operation":"2"}'
```

**응답:**
```json
{
  "ok": true,
  "message": "제어 명령 전송 성공: operation=운전",
  "timestamp": "2026-05-19T12:05:30.000Z"
}
```

**오류 응답:**
```json
{
  "error": "Device not found or not connected",
  "message": "device not connected"
}
```

#### 헬스 체크

```bash
GET /health
```

## 데이터 소스

- 데이터는 **spc-postgres (PostgreSQL)** 에 저장/조회됩니다.
- 기본 연결 정보:
  - DB: `spcdb`
  - User: `spc`
  - 주요 테이블:
    - `device_data` - 시계열 데이터
    - `device_alarm` - 알람 이벤트
    - `device_command` - 제어 명령

## 구성도

```
spc-device (송신)
    ↓ TCP IECP
spc-gateway (수신 → PostgreSQL 저장)
  ↓ PostgreSQL
spc-api (REST API)
    ↓ HTTP JSON
클라이언트 / 대시보드 / 모니터링
```

## CORS

모든 오리진에서의 요청을 허용합니다.

```javascript
res.header('Access-Control-Allow-Origin', '*');
```

## 오류 응답

```json
{
  "error": "Error message",
  "message": "Detailed error message"
}
```

## 개발

### 새로운 엔드포인트 추가

1. `server.js`에 라우트 추가
2. Swagger 주석 작성 (`@swagger` 블록)
3. `npm run dev`로 테스트
4. 자동으로 Swagger UI 업데이트됨

### PostgreSQL 조회 예시

```sql
SELECT device_id, pt_cur, p_con, pe_cur, received_at
FROM device_data
ORDER BY received_at DESC
LIMIT 10;
```

## 라이센스

MIT
