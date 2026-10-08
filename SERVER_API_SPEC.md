# Spec — Server API Contract & State Machines (Kiến trúc Channel 1-to-N E2EE)

> **Phiên bản**: v1.5 — 03/10/2026
> **Căn cứ**: `SRD_DATABASE.md` v1.6 (FREEZE-READY) + `TECH_DEBT_SOLUTION.md`.
> **Phạm vi**: hợp đồng HTTP giữa mobile ↔ server cho kiến trúc mới: endpoint,
> schema request/response, error codes, state machine, FCM payload, rate limit.
> **Namespace**: `/api/v2` (giữ `/api/v1` legacy cho tới khi migration xong —
> xem mục 12). Server hiện dùng Express + zod (`validate.middleware`), error
> envelope hiện có giữ nguyên.
>
> **Changelog v1.4 → v1.5** (sửa lệch spec với `MOBILE_FEATURES.md` §1.2):
> đổi tên thiết bị đưa vào **v1** — endpoint mới `PUT /api/v2/devices/name`
> (§3.3). `device_name` là display-only, không nằm trong AAD (SRD 7.1/7.2) →
> **không rotate key**; server fan-out tên mới sang `channel_members` ACTIVE +
> `pairing_requests` PENDING. Bỏ đề xuất per-channel
> `PUT /api/v2/channels/members` khỏi mục 13.
>
> **Changelog v1.3 → v1.4** (theo review): **membership ACTIVE = source of
> truth cho authorization đọc** (KL12) — `GET /messages` chỉ trả tin của kênh
> caller **đang ACTIVE**; caller REVOKED không nhận tin của kênh đó và bị
> `403 REVOKED` trên mọi channel-scoped API. Client purge key material khi bị
> revoke; bỏ wording "xóa local message store" (không tồn tại).
>
> **Changelog v1.2 → v1.3**: đọc message thành **channel-agnostic** —
> `GET /messages?date&tz_offset` gộp tin của MỌI kênh caller là member, điều
> kiện lọc duy nhất là ngày; client không truyền `channel_id` (khớp
> `MOBILE_FEATURES.md` v1.2). Ghi gửi vẫn per-channel.
>
> **Changelog v1.1 → v1.2**: đổi mô hình đọc message sang **fetch theo ngày**
> (`date` + `tz_offset`) — bỏ `after_sequence` và khuyến nghị client lưu
> `last_sequence`. Sequence vẫn là ordering/anti-replay server-side (KL7, T5),
> không còn là cơ chế sync của mobile (khớp `MOBILE_FEATURES.md` v1.1).
>
> **Changelog v1.0 → v1.1**: bỏ toàn bộ path parameter — mọi id/tham số nằm
> trong **query string (GET)** hoặc **body (POST/PUT)**; route chỉ còn path tĩnh.

---

## 1. Quy ước chung

| Mục | Quy ước |
|---|---|
| **Routing** | **Chỉ dùng path tĩnh — CẤM path parameter.** Mọi id/tham số: GET → query string; POST/PUT → JSON body. Toàn bộ input đi qua zod schema, không có ngoại lệ. (URL hằng định dạng → log/monitor gom nhóm theo endpoint, không leak id; không có dữ liệu user-controlled trong path) |
| Auth | `Authorization: Bearer <device_token>` — middleware `authenticate` hiện tại (token → SHA-256 → tra `devices`), gắn `req.device` |
| Body | JSON, UTF-8; timestamp ISO 8601 UTC; byte data (key, ciphertext, nonce) là **base64 chuẩn** |
| Success | `200/201` + `{ "success": true, ...data }` |
| Error | `{ "success": false, "error": "<CODE>", "message": "<mô tả tiếng Anh, client map sang tiếng Việt>" }` |
| Notification | FCM mang data payload kèm `notification: { title, body }` (tiếng Việt mặc định cho MVP để OS tự render khi background/killed) |
| Idempotency | GET thuần idempotent; POST message có anti-replay T5; POST key-envelope fetch idempotent |
| Mọi endpoint `/channels/*`, `/pairing/*` | **Bắt buộc Bearer** — kể cả claim QR (thiết bị B phải register trước, feature 1.1) |

## 2. Error code catalog

| HTTP | Code | Khi nào | Hành động client |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod fail | Không retry |
| 401 | `UNAUTHORIZED` | Thiếu/sai token | Đăng ký lại thiết bị |
| 403 | `NOT_OWNER` | Gọi mutation mà không phải owner | Chặn UI |
| 403 | `FORBIDDEN` | Member gọi API ngoài quyền (vd gửi message) | Chặn UI |
| 403 | `REVOKED` | Caller đã bị revoke — áp dụng cho **mọi channel-scoped API** (detail/members/key-envelope/messages-send; `GET /messages` loại kênh đó khỏi kết quả thay vì lỗi). Membership ACTIVE = source of truth (KL12) | Purge **key material** của channel (map `epoch → CK` + envelope cache), hiện màn "bị thu hồi" |
| 404 | `NOT_FOUND` | Channel/request/session không tồn tại | Refresh state |
| 409 | `QR_ALREADY_USED` | Claim session đã CLAIMED | Hướng dẫn xin mã mới |
| 409 | `ALREADY_MEMBER` | Claim khi caller đã là member ACTIVE của kênh (kể cả Owner) | Thông báo "đã tham gia", không gửi yêu cầu |
| 409 | `REQUEST_ALREADY_PENDING` | Claim khi thiết bị còn request PENDING cho kênh này (dedup marker `pairing_pending`) | Điều hướng về màn "Đang chờ duyệt" |
| 409 | `REQUEST_NOT_PENDING` | Approve/reject khi request không còn PENDING | Refresh danh sách |
| 409 | `MEMBERSHIP_CHANGED` | Package stale (epoch/version lệch) | Owner: sync → tạo lại package → retry 1 chạm |
| 409 | `CHANNEL_NOT_ACTIVE` | Kênh ARCHIVED | Chặn gửi |
| 409 | `EPOCH_OUTDATED` | Gửi message với `request_epoch != current_epoch` | Fetch self-envelope mới → unwrap → retry |
| 409 | `REPLAY_DETECTED` | Trùng hash `(channel_id\|nonce\|ciphertext)` trong 24h | Không retry, báo lỗi |
| 410 | `QR_EXPIRED` | Claim session hết hạn | Xin mã mới |
| 422 | `PACKAGE_INCOMPLETE` | Envelope set sai cấu trúc (thiếu/thừa/sai device id so với snapshot server tự tính) | Owner: tạo lại package đầy đủ |
| 429 | `RATE_LIMITED` | Vượt rate limit | Backoff |
| 500 | `SERVER_ERROR` | Lỗi không rõ | Retry có backoff |

*(Quy ước: `409 MEMBERSHIP_CHANGED` = state đã đổi; `422 PACKAGE_INCOMPLETE` =
payload sai cấu trúc — hai mã không bao giờ chồng nhau.)*

## 3. Devices

### 3.1. `POST /api/v2/devices/register`

```jsonc
// Request (body)
{ "device_id": "uuid-v4", "device_name": "Pixel 8", "platform": "android",
  "public_key": "<base64 X25519>", "fcm_token": "..." }
// Response 201
{ "success": true, "device_token": "<raw, chỉ hiện 1 lần>", "device_id": "..." }
```

- Idempotent theo `device_id`: gọi lại với cùng device_id → trả token mới,
  update `public_key`/`device_name` (reinstall policy SRD 8.2).
- Lưu `public_key` **một lần theo device_id mới** — luôn hợp lệ vì reinstall
  sinh device_id mới (SRD 3.1).

### 3.2. `PUT /api/v2/devices/fcm-token` 🔒

`{ "fcm_token": "..." }` → `{ "success": true }`

### 3.3. `PUT /api/v2/devices/name` 🔒

```jsonc
// Request (body)
{ "device_name": "Pixel 8 của Minh" }
// Response 200
{ "success": true }
```

Đổi tên thiết bị (MOBILE_FEATURES 1.2 — user sửa bất cứ lúc nào). Caller suy
từ `req.device` — body **không** nhận `device_id`. `device_name` là
display-only, không nằm trong AAD (SRD 7.1/7.2) → **không rotate key, không
đụng epoch/membership_version**. Server cập nhật trong 1 transaction:

1. `devices.device_name` của caller;
2. Fan-out `channel_members.device_name` của **mọi kênh** caller đang ACTIVE —
   nguồn hiển thị cho Owner ở `GET /channels/members` (§4.4);
3. Fan-out `requester_device_name` của các `pairing_requests` đang PENDING do
   caller gửi — nguồn hiển thị ở hàng đợi duyệt (§5.3).

Idempotent: gọi lại với cùng tên → `200`, không đổi gì. Lỗi duy nhất:
`400 VALIDATION_ERROR` (zod, max 128 ký tự).

### 3.4. `GET /api/v2/devices/me` 🔒

```jsonc
// Request (header)
// Authorization: Bearer <device_token>

// Response 200
{
  "success": true,
  "device_id": "uuid-v4",
  "device_name": "Pixel 8 của Minh",
  "platform": "android",
  "public_key": "<base64 X25519>",
  "created_at": "2026-10-06T00:00:00.000Z"
}
```

Kiểm tra tính hợp lệ của token thiết bị và đọc thông tin hồ sơ thiết bị hiện tại (dùng cho Splash screen / khởi động ứng dụng / xác thực token).
- Nếu token hợp lệ: trả `200` kèm thông tin thiết bị.
- Nếu token sai hoặc đã bị hủy: middleware `authenticate` trả `401 UNAUTHORIZED`.

## 4. Channels

### 4.1. `POST /api/v2/channels` — T0 (Owner package) 🔒

```jsonc
// Request (body)
{ "name": "Kênh nhà",
  "package": { "base_epoch": 1, "base_membership_version": 1,
    "envelopes": [ { "device_id": "<owner>", "key_epoch": 1,
      "wrapped_key": "...", "nonce": "...", "kek_alg": "X25519-ECDH-HKDF-SHA256/AES-256-GCM" } ] } }
// Response 201
{ "success": true, "channel_id": "...", "current_epoch": 1, "membership_version": 1 }
```

Server validate (KL1/KL2 — không đụng plaintext key): caller == `envelopes[0].device_id`,
`key_epoch == 1`, envelope set == `{Owner}`. Sai cấu trúc → `422 PACKAGE_INCOMPLETE`.

### 4.2. `GET /api/v2/channels` 🔒

Danh sách kênh caller thuộc về (nguồn: `channel_members` join `channels`).
Client nhóm thẳng theo `role`: `OWNER` → nhóm **"Kênh của bạn"**, `MEMBER` →
nhóm **"Kênh bạn tham gia"** (MOBILE_FEATURES 2.1). Member REVOKED **không**
xuất hiện ở đây (đã có mã `403 REVOKED` khi đụng API kênh).

```jsonc
{ "success": true, "channels": [ { "channel_id": "...", "name": "...",
  "role": "OWNER" | "MEMBER", "status": "ACTIVE", "current_epoch": 3,
  "membership_version": 4, "member_count": 2, "my_joined_epoch": 2,
  "owner_device_name": "..." } ] }
```

### 4.3. `GET /api/v2/channels/detail?channel_id={id}` 🔒

Chi tiết 1 kênh + trạng thái của caller (`role`, `my_joined_epoch`,
`provisioned_epoch`, `status`). `403 REVOKED` nếu từng là member nhưng đã bị
revoke; `404` nếu chưa từng là member.

### 4.4. `GET /api/v2/channels/members?channel_id={id}` 🔒

Owner: thấy tất cả (kèm REVOKED). Member: chỉ ACTIVE.

```jsonc
{ "success": true, "members": [ { "device_id": "...", "device_name": "...",
  "status": "ACTIVE", "joined_epoch": 2, "provisioned_epoch": 3, "joined_at": "..." } ] }
```

### 4.5. `POST /api/v2/channels/sessions` — tạo QR mời 🔒 (Owner)

```jsonc
// Request (body)
{ "channel_id": "..." }
// Response 201
{ "success": true, "session_id": "...", "pairing_token": "<raw 128-bit>",
  "expires_at": "ISO", "invite_url": "smsnavigator://pair?v=4&s=...&t=...&u=...&e=..." }
```

Server sinh cả `invite_url` — A chỉ nhét chuỗi này vào QR, B parse đúng một
format (hết cảnh lệch parser hai phía). **Invite URL format v4:**

```text
smsnavigator://pair?v=4&s=<sessionId>&t=<pairingToken>&u=<base64url(serverBaseUrl)>&e=<expiryEpochMs>
```

Không chứa key/public key/credential dài hạn (I3). TTL 10 phút, single-use (I9/I11).
Mỗi lần gọi `POST /api/v2/channels/sessions` sẽ tự động vô hiệu hóa (`status: EXPIRED`) toàn bộ session `UNUSED` trước đó của kênh trong cùng transaction, đảm bảo mỗi kênh duy trì tối đa 1 active invite tại một thời điểm (B-invalidate-on-create).

### 4.6. `POST /api/v2/channels/sessions/resolve` — preview kênh từ QR 🔒 (Member)

API read-only để client hiển thị trước thông tin kênh (Tên kênh, Chủ kênh) cho người dùng xác nhận tham gia. Không làm biến đổi trạng thái session (vẫn giữ `UNUSED`) và không ghi bất kỳ document nào vào Firestore.
Được bảo vệ bởi `v2ResolveRateLimiter` (30 req / 5 phút / `device_id`).

```jsonc
// Request (body)
{ "session_id": "...", "pairing_token": "<raw>" }
// Response 200
{ "success": true, "session_id": "...", "channel_id": "...",
  "channel_name": "...", "owner_device_name": "...", "expires_at": "ISO" }
```

Fail-early: trả về lỗi sớm nếu:
- `404 NOT_FOUND`: session không tồn tại hoặc token không khớp.
- `409 QR_ALREADY_USED`: session đã bị claim.
- `410 QR_EXPIRED`: session đã hết hạn hoặc không còn UNUSED.
- `409 ALREADY_MEMBER`: caller đã là thành viên ACTIVE của kênh.
- `409 REQUEST_ALREADY_PENDING`: caller đang có yêu cầu PENDING chờ duyệt trên kênh này.

### 4.7. `POST /api/v2/channels/revoke` — T4 (Owner package) 🔒

```jsonc
// Request (body)
{ "channel_id": "...", "revoke_device_ids": ["C"],
  "package": { "base_epoch": 3, "base_membership_version": 4,
    "envelopes": [ /* {Owner} ∪ ACTIVE còn lại, key_epoch = 4 */ ] } }
// Response 200
{ "success": true, "current_epoch": 4, "membership_version": 5 }
```

## 5. Pairing (claim → duyệt)

### 5.1. `POST /api/v2/pairing/requests` — T1 (Member claim) 🔒

```jsonc
// Request (body)
{ "session_id": "...", "pairing_token": "<raw>", "device_name": "Galaxy S23" }
// Response 201
{ "success": true, "request_id": "...", "status": "PENDING",
  "channel_id": "...", "channel_name": "...", "owner_device_name": "..." }
```

Transaction: `pairing_sessions UNUSED + expires_at > now → CLAIMED` + tạo
request PENDING. Lỗi: `409 QR_ALREADY_USED`, `409 ALREADY_MEMBER`, `409
REQUEST_ALREADY_PENDING`, `410 QR_EXPIRED`.

Dedup rules (chống quét nhiều QR khác nhau của cùng kênh):

- Caller đã là member **ACTIVE** (kể cả Owner — Owner có member doc từ T0) →
  `409 ALREADY_MEMBER`. Member **REVOKED** vẫn claim lại được (reinstall policy
  SRD 8.2).
- Thiết bị còn request **PENDING** cho kênh → `409 REQUEST_ALREADY_PENDING`.
  Enforce bằng marker doc `pairing_pending/{channelId}__{deviceId}` trong cùng
  transaction (xem SRD 3.5b): 2 claim đồng thời với 2 session khác nhau vẫn chỉ
  1 commit thành công. Marker bị xóa khi request vào trạng thái cuối
  (APPROVED/REJECTED/CANCELLED) → thiết bị claim QR mới được.

### 5.2. `GET /api/v2/pairing/requests/mine` 🔒 (Member)

Trạng thái các request mình đã gửi (cho màn "Đang chờ duyệt" + reconcile 7.3).
Không cần tham số — suy từ `req.device`.

```jsonc
{ "success": true, "requests": [ { "request_id": "...", "channel_id": "...",
  "channel_name": "...", "owner_device_name": "...", "status": "PENDING|APPROVED|REJECTED|CANCELLED",
  "created_at": "...", "decided_at": "..." } ] }
```

### 5.3. `GET /api/v2/channels/requests?channel_id={id}&status=PENDING` 🔒 (Owner)

Hàng đợi duyệt (Q1): `{ requests: [{request_id, requester_device_name, created_at}] }`.

### 5.4. `POST /api/v2/pairing/requests/approve` — T2 (Owner package) 🔒

```jsonc
// Request (body)
{ "request_id": "...",
  "package": { "base_epoch": 3, "base_membership_version": 4,
    "envelopes": [ /* {Owner} ∪ {ACTIVE trước txn} ∪ {Requester}, key_epoch = 4 */ ] } }
// Response 200
{ "success": true, "current_epoch": 4, "membership_version": 5,
  "requester_device_id": "..." }
```

Transaction T2 (SRD 4.1): request `PENDING→APPROVED` + member ACTIVE mới
(`joined_epoch = 4`, `provisioned_epoch = 4`) + envelope member cũ + rotate +
xóa marker `pairing_pending` của requester.
Lỗi: `409 MEMBERSHIP_CHANGED`, `422 PACKAGE_INCOMPLETE`, `409 REQUEST_NOT_PENDING`,
`409 ALREADY_MEMBER` (requester đã ACTIVE — chặn approve kép).

### 5.5. `POST /api/v2/pairing/requests/reject` 🔒 (Owner)

`{ "request_id": "..." }` — T6.

### 5.6. `POST /api/v2/pairing/requests/cancel` 🔒 (Member, chỉ PENDING)

`{ "request_id": "..." }` — T6.

## 6. Key Envelope & Messages

### 6.1. `GET /api/v2/channels/key-envelope?channel_id={id}&epoch={n}` 🔒

```jsonc
{ "success": true, "key_epoch": 4, "wrapped_key": "...", "nonce": "...",
  "kek_alg": "X25519-ECDH-HKDF-SHA256/AES-256-GCM" }
```

- Có `epoch` → trả envelope đúng epoch của **caller**; bỏ trống `epoch` →
  envelope `provisioned_epoch` cao nhất của caller (mode "latest" cho recovery
  Owner, SRD 7.3).
- Idempotent; set `fetched_at` lần đầu fetch.
- `403 REVOKED` nếu caller đã bị revoke — không trả envelope nào, kể cả epoch
  cũ đã từng được provision (KL12: authorization kết thúc tại revocation).
- `404` nếu chưa được provision epoch đó (KL8).

### 6.2. `POST /api/v2/channels/messages` — T5 + T3 🔒 (Owner)

```jsonc
// Request (body)
{ "channel_id": "...", "request_epoch": 4, "ciphertext": "<b64>", "nonce": "<b64 12B>" }
// Response 201
{ "success": true, "message_id": "...", "sequence_number": 128,
  "server_received_at": "..." }
```

Thứ tự xử lý server: rate limit → **T5 anti-replay** (`sha256(channel_id|nonce|ciphertext)`,
TTL 24h, trước T3) → T3 check `request_epoch == current_epoch` (KL7) → tăng
`sequence_counter` atomic → lưu message. Lỗi: `409 REPLAY_DETECTED`,
`409 EPOCH_OUTDATED`, `409 CHANNEL_NOT_ACTIVE`, `403 FORBIDDEN`.

### 6.3. `GET /api/v2/messages?date={YYYY-MM-DD}&tz_offset={minutes}` 🔒

Đọc tin nhắn **channel-agnostic**: gộp tin của **MỌI kênh** mà caller **đang
là member ACTIVE** — **điều kiện lọc duy nhất là ngày**. Server tự suy danh
sách kênh từ `req.device` (Q2 → Q4); client **không truyền `channel_id`**.

> **Authorization = membership (KL12):** membership `ACTIVE` tại thời điểm
> query là **source of truth** cho quyền đọc. Kênh caller đã bị REVOKED bị
> loại khỏi kết quả — **không** dùng "client còn giữ epoch key" để quyết định
> quyền đọc; key chỉ là cơ chế crypto/backup. Caller bị revoke khỏi *tất cả*
> kênh vẫn nhận `200` với `messages: []`.

```jsonc
// Response 200
{ "success": true, "date": "2026-10-02",
  "messages": [ { "channel_id": "...", "channel_name": "Kênh nhà",
    "sequence_number": 129, "key_epoch": 4, "ciphertext": "...",
    "nonce": "...", "sender_device_id": "...", "sent_at": "...",
    "server_received_at": "..." } ] }
```

- Server lọc `server_received_at` theo ngày `date` cộng `tz_offset` phút
  (mặc định 0 = UTC).
- Sort theo `server_received_at` giảm dần (tin mới nhất lên đầu; sequence không
  so sánh được giữa các kênh); mỗi dòng kèm `channel_id` + `channel_name` để UI hiển thị nguồn.
- Cap 1000 tin/ngày; vượt → trả 1000 tin **mới nhất** + `"truncated": true`.
- Sequence vẫn là ordering/anti-replay phía server (KL7, T5) — không phải cơ
  chế sync của mobile.

## 7. FCM — chỉ là chuông (I5)

**Data payload kèm Notification block** (hỗ trợ OS tự động render banner/thông báo khi app ở background hoặc bị tắt), KHÔNG chứa ciphertext/key. Bị mất/trễ là vô hại: app luôn reconcile khi mở (SRD N8).

```jsonc
{
  "data": { "type": "CHANNEL_EVENT", "channel_id": "...", "kind": "JOIN_REQUEST", "epoch": "3" },
  "notification": { "title": "Yêu cầu tham gia kênh", "body": "Máy A muốn tham gia kênh." }
}
```

| kind | Gửi cho | Ý nghĩa |
|---|---|---|
| `JOIN_REQUEST` | Owner | Có request chờ duyệt (kèm `requester_device_name` chỉ để hiện text) |
| `APPROVED` | Requester | Được duyệt — mở app để fetch key-envelope |
| `REVOKED` | Member bị revoke | Bị thu hồi — purge key material, kênh biến mất khỏi danh sách |
| `NEW_MESSAGE` | Các member ACTIVE | Có tin mới — mở app sync |

## 8. Package Pattern — schema chuẩn

```jsonc
"package": {
  "base_epoch": 3,                  // epoch Owner snapshot khi sinh package
  "base_membership_version": 4,     // membership_version snapshot (KL6)
  "envelopes": [                    // ĐỦ theo bảng SRD 4.1 cho operation tương ứng
    { "device_id": "...", "key_epoch": 4, "wrapped_key": "...", "nonce": "...",
      "kek_alg": "X25519-ECDH-HKDF-SHA256/AES-256-GCM" }
  ]
}
```

Operation được xác định bởi **path tĩnh** của endpoint (create/approve/revoke).
Server-side validation (thuần cấu trúc, không crypto):

1. Caller == `channels.owner_device_id` → `403 NOT_OWNER`
2. `base_epoch == channels.current_epoch && base_membership_version == channels.membership_version` → ngược lại `409 MEMBERSHIP_CHANGED`
3. Envelope set == tập device id server kỳ vọng theo bảng SRD 4.1, mọi
   `key_epoch == current_epoch + 1` (T0: `== 1`) → ngược lại `422 PACKAGE_INCOMPLETE`
4. Commit nguyên khối (I10)

## 9. State machines (đúng một nguồn: server)

```text
pairing_sessions:  UNUSED ──claim(T1, chưa hết hạn)──> CLAIMED
                   UNUSED ──(expires_at <= now)──────> EXPIRED
                   CLAIMED ──(claim lần 2)───────────> 409 QR_ALREADY_USED

pairing_requests:  PENDING ──approve(T2)──> APPROVED   (kèm rotate, terminal)
                   PENDING ──reject───────> REJECTED   (terminal)
                   PENDING ──cancel────────> CANCELLED (terminal, chỉ requester)

channel_members:   (không tồn tại) ──T2──> ACTIVE (joined_epoch = N+1)
                   ACTIVE  ──T4──────────> REVOKED  (terminal, không quay lại)
```

## 10. Rate limits (middleware hiện tại, mở rộng)

| Endpoint | Budget |
|---|---|
| `POST /pairing/requests` (claim) | 10 / 5 phút / IP (chống brute token 128-bit) |
| `POST /channels/sessions` | 10 / 5 phút / device |
| `POST /channels/messages` | 60 / phút / device |
| `GET /messages` (đọc theo ngày) | 120 / phút / device |
| `POST /pairing/requests/approve`, `.../revoke` | 20 / phút / device |
| `POST /devices/register` | 10 / 5 phút / IP |
| `PUT /devices/name` | 10 / phút / device |

## 11. Sequence — các luồng chính

```text
[B join]
B: scan QR → POST /pairing/requests (T1)                        ──▶ PENDING
A: FCM chuông / mở app → GET /channels/requests?channel_id=&status=PENDING
A: POST /pairing/requests/approve (T2, rotate N→N+1)
B: FCM APPROVED (hoặc reconcile khi mở app)
B: GET /channels/key-envelope?channel_id=&epoch=N+1 → ECDH unwrap → persist CK
B: GET /messages?date=<hôm nay> → decrypt từng tin (mọi kênh) → hiển thị

[A gửi OTP]
Native chặn SMS → Flutter encrypt(CK_N, AAD bind(ch,N,seq_hint=0))
  → POST /channels/messages {channel_id, request_epoch: N} → server cấp seq
  └─ 409 EPOCH_OUTDATED → GET key-envelope (latest) → unwrap → retry

[A revoke C]
A: POST /channels/revoke {channel_id, [C], package epoch N+1, envelopes {A}∪ACTIVE\C}
Server: T4 commit → C: FCM REVOKED → C purge key material; A tiếp tục gửi bằng CK_(N+1)
  └─ 409 MEMBERSHIP_CHANGED → GET /channels/detail → tạo lại package

[Owner recovery]
A mở app: GET /channels → current_epoch > epoch local
  → GET key-envelope (latest) → ECDH(sk_A, pk_A) unwrap → persist (SRD 7.3)
```

## 12. Legacy `/api/v1` — deprecated, không xóa ngay

| Nhóm v1 | Thay bằng v2 | Ghi chú |
|---|---|---|
| `/pair/*` (create/confirm/status) | `/channels` + `/pairing/*` | Pair 1-1 chết hẳn |
| `/relay/*` (payload/pending/history) | `/messages` (fetch theo ngày, gộp mọi kênh) | `ReplayGuardService` tái dùng nguyên lý, đổi bind string |
| `/devices/register` | `/api/v2/devices/register` (+public_key) | Thuộc tính mới: idempotent theo device_id |

Client v2 KHÔNG gọi bất kỳ endpoint v1 nào. Xóa v1 khi đợt 3 (MOBILE_FEATURES
§10) hoàn thành.

## 13. Mở sau (không thuộc v1)

- `POST /api/v2/channels/leave` — member chủ động rời (body: `channel_id`) (feature 8.2)
- `POST /api/v2/channels/archive` — ARCHIVED (body: `channel_id`) (feature 8.3)
- Phân trang thêm cho ngày có lượng tin vượt cap 1000 (P2, nếu cần)
