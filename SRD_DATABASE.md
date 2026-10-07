# SRD — Database Design (Firestore) cho Kiến trúc Channel 1-to-N E2EE

> **Phiên bản**: v1.6 (FREEZE-READY — sau 6 vòng review) — 03/10/2026
> **Căn cứ**: `TECH_DEBT_SOLUTION.md` (kiến trúc đích).
> **Phạm vi**: chỉ thiết kế database (schema Firestore, index, TTL, transaction,
> access pattern) + hợp đồng mật mã liên quan trực tiếp tới field database.
>
> **Changelog v1.5 → v1.6**: semantics `device_name` — là **bản sao display**,
> device đổi tên bất cứ lúc nào qua `PUT /api/v2/devices/name` (khớp
> `SERVER_API_SPEC.md` v1.5, `MOBILE_FEATURES.md` v1.5 §1.2); server tự đồng
> bộ sang `channel_members` ACTIVE + `pairing_requests` PENDING. Không đổi
> schema, không rotate key (AAD không bind tên — SRD 7.1/7.2).
>
> **Changelog v1.1 → v1.2** (vòng review 3):
> 1. **P0 — APPROVE = ROTATE**: approve sinh `CK_(N+1)` cho `{Owner} ∪ {ACTIVE
>    trước transaction} ∪ {Requester}`. Sửa mâu thuẫn: approve dùng lại CK_N +
>    policy "không đọc history" là bất khả thi về mật mã (B có K_N ⇒ decrypt
>    được mọi message epoch N, kể cả trước khi join). Giờ ranh giới history là
>    rào cản mật mã, không chỉ phân quyền.
> 2. **P1 — CREATE CHANNEL = Package Pattern**: Owner sinh CK_1 + self-envelope,
>    server chỉ commit (KL1 cấm server generate/derive key).
> 3. `base_version` → `base_membership_version` (nhất quán với field server).
> 4. `joined_epoch = new_epoch` lúc approve; policy 8.1 giờ được enforce bằng mật mã.
> 5. Thêm **KL11**: mọi membership mutation đều tạo key boundary mới; message
>    send không bao giờ đổi key.
> 6. Decision record: loại phương án hash ratchet, kèm lý do thật.
> 7. Thêm policy **client epoch-key retention** (chặn tự làm mất data khi fetch muộn).
> 8. Chốt semantics `membership_version = 1` lúc create.
>
> **Changelog v1.4 → v1.5** (vòng review 6): **membership ACTIVE = source of
> truth cho authorization đọc** — thêm **KL12**; `GET /messages` chỉ trả tin
> của kênh caller đang ACTIVE (Q4, §8.4); caller REVOKED không fetch được
> envelope nào (kể cả epoch cũ). Ghi đè policy "decrypt history cũ là hành vi
> đã chấp nhận" (§15 SOLUTION) — decision record ở §8.4. Khớp
> `SERVER_API_SPEC.md` v1.4, `MOBILE_FEATURES.md` v1.4.
>
> **Changelog v1.3 → v1.4** (vòng review 5): đọc message thành
> **channel-agnostic** — `GET /messages?date&tz_offset` gộp tin của MỌI kênh
> caller là member (ACTIVE hoặc REVOKED), điều kiện lọc duy nhất là ngày.
> Q4 mở rộng thành 2 bước (Q2 → whereIn + range, §5), §6, §8.4. Danh sách
> kênh client nhóm theo `role` — không đổi schema. Khớp
> `SERVER_API_SPEC.md` v1.3, `MOBILE_FEATURES.md` v1.3.
>
> **Changelog v1.2 → v1.3** (vòng review 4): mô hình đọc message đổi sang
> **fetch theo ngày** — `GET /channels/messages?channel_id&date`, client KHÔNG
> có local message store / `after_sequence`. Sequence vẫn là ordering +
> anti-replay server-side. Cập nhật Q4 (§5), §6, §8.4 — khớp
> `SERVER_API_SPEC.md` v1.2, `MOBILE_FEATURES.md` v1.1.
>
> *(Changelog v1.0 → v1.1: Package Pattern cho T2/T4, `membership_version`,
> `EPOCH_OUTDATED`, `provisioned_epoch`, KL1–KL10, canonical encoding,
> reinstall policy, các OQ đóng — chi tiết trong git history.)*

---

## 0. Vai trò các bên (tóm tắt điều hành)

```text
Owner   = key authority          (duy nhất bên sinh/giữ Channel Key)
Server  = authorization + durable storage + distribution  (KHÔNG phải key authority)
Member  = key holder             (chỉ decrypt, không sinh key)
FCM     = wake-up signal         (không nằm trong consistency path)
```

Server quyết định membership và lưu/phân phối envelope, nhưng **không bao giờ
trở thành key authority**. Mọi thao tác đổi key là Owner-driven (Package Pattern,
mục 4).

---

## 1. Mục đích & nguyên tắc thiết kế

| # | Nguyên tắc | Ràng buộc lên schema |
|---|---|---|
| N1 | Server blind: không biết plaintext, không biết Channel Key | Chỉ lưu ciphertext + wrapped key envelope |
| N2 | Mã hóa 1 lần, fan-out N nơi | Message gắn channel, không gắn từng receiver |
| N3 | Chưa duyệt thì chưa có key | Key envelope chỉ tồn tại khi request đã APPROVED |
| N4 | State transition atomic | Mọi chuyển trạng thái qua Firestore transaction |
| N5 | Mã QR single-use + TTL 10 phút | Session có state machine + TTL index |
| N6 | Sequence là nguồn đồng bộ, không dùng timestamp | sequence_number sinh server-side, duy nhất per channel |
| N7 | Revocation đi kèm key rotation (auto-rotate) | Envelope theo epoch; member có trạng thái |
| N8 | FCM không phải source of truth | Không field nào phụ thuộc FCM để duy trì tính đúng đắn |

**Quy ước chung**: mọi thời điểm lưu ISO 8601 UTC; mọi id là string; trường
`*_hash` là SHA-256 hex của giá trị gốc.

---

## 2. Tổng quan mô hình thực thể

```text
Firestore
├── devices/                        (mở rộng từ schema hiện tại)
├── channels/
│   └── {channelId}
├── channel_members/
│   └── {channelId}__{deviceId}
├── pairing_sessions/               (TTL 10 phút, single-use)
│   └── {sessionId}
├── pairing_requests/               (hàng đợi phê duyệt bất đồng bộ)
│   └── {requestId}
├── channel_key_envelopes/          (CK được wrap per-member per-epoch)
│   └── {channelId}__{deviceId}__{epoch}
└── channel_messages/
    └── {messageId}  (định danh logic = channel_id + sequence_number)
```

### Lệch so với §18.3 của `TECH_DEBT_SOLUTION.md` (có chủ đích)

| Điểm | §18.3 | SRD này | Lý do |
|---|---|---|---|
| Key envelope | Field trong `pairing_requests` | Collection riêng `channel_key_envelopes` | Rotation phải cấp envelope cho member hiện hữu + Owner (self-envelope) |
| Sequence | Không nêu cách sinh | `sequence_counter` trên channel doc + transaction increment | Duy nhất, monoton, không race |
| Id member | `{channelId}_{deviceId}` | `{channelId}__{deviceId}` | Tránh nhập nhầm khi id chứa `_` |
| Ai tạo/wrap key | Không nêu | **Owner, theo Package Pattern** (mục 4) — cho mọi mutation kể cả create | Server-blind: server không thể sinh/wrap key |
| Approve | Không nêu rotation | **Approve = rotate epoch** | Chặn đọc history trong cùng epoch (P0 v1.2) |

---

## 3. Chi tiết từng collection

### 3.1. `devices/{deviceId}`

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| device_id | string | ✔ | UUID v4 sinh client **mỗi lần cài đặt** |
| device_token_hash | string | ✔ | SHA-256 của device token (credential gọi API) |
| device_name | string | ✔ | Đổi được bất cứ lúc nào qua `PUT /api/v2/devices/name` — server tự fan-out (API spec §3.3) |
| platform | string ('android'\|'ios') | ✔ | |
| public_key | string (base64 X25519) | ✔ | Identity key lâu dài của **bản cài đặt này** |
| fcm_token | string | ✖ | Chuông báo |
| registered_at | ISO8601 | ✔ | |
| last_seen_at | ISO8601 | ✖ | |

**Identity-key lifecycle:** Android Keystore key không sống qua uninstall →
**reinstall = identity mới = device_id mới = thiết bị hoàn toàn mới**. Member
muốn dùng lại phải re-join (re-claim QR + chờ duyệt). `public_key` set một lần
ngay lúc register — hợp lệ vì device_id luôn mới sau reinstall.

### 3.2. `channels/{channelId}`

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| channel_id | string | ✔ | Document id |
| owner_device_id | string | ✔ | Không đổi trong v1 (xem OQ-1) |
| name | string | ✔ | |
| current_epoch | int | ✔ | `= 1` lúc create; chỉ tăng qua Package Pattern của một membership mutation (KL11) |
| membership_version | int | ✔ | `= 1` lúc create (owner join được tính là membership change đầu tiên); +1 mỗi mutation membership sau đó |
| sequence_counter | int | ✔ | Bắt đầu = 0; tăng atomic khi nhận message |
| member_count | int | ✔ | Denormalize; source of truth là `channel_members` |
| status | string | ✔ | `ACTIVE` \| `ARCHIVED` |
| created_at | ISO8601 | ✔ | |
| updated_at | ISO8601 | ✔ | |

### 3.3. `channel_members/{channelId}__{deviceId}`

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| channel_id | string | ✔ | |
| device_id | string | ✔ | Owner cũng có member doc riêng (đồng bộ self-envelope) |
| device_name | string | ✔ | Bản sao display của `devices.device_name` — server tự đồng bộ khi device đổi tên |
| public_key | string | ✔ | Identity key tại thời điểm duyệt |
| status | string | ✔ | `ACTIVE` \| `REVOKED` |
| joined_epoch | int | ✔ | Epoch mà member được provision đầu tiên. Với member duyệt qua T2: **`= new_epoch = N+1`** |
| provisioned_epoch | int | ✔ | Epoch cao nhất **đã provision** envelope. Server KHÔNG chứng minh được member đã fetch/decrypt |
| joined_at | ISO8601 | ✔ | |
| revoked_at | ISO8601 | ✖ | |

Ràng buộc: revoke chỉ theo chiều `ACTIVE → REVOKED`, không quay lại.

### 3.4. `pairing_sessions/{sessionId}` — mã QR single-use

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| session_id | string | ✔ | Document id |
| channel_id | string | ✔ | |
| pairing_token_hash | string | ✔ | SHA-256 của **pairing_token 128-bit** random |
| status | string | ✔ | `UNUSED` \| `CLAIMED` \| `EXPIRED` |
| claimed_by_device_id | string | ✖ | Set trong cùng transaction CLAIMED |
| request_id | string | ✖ | |
| expires_at | ISO8601 | ✔ | 10 phút; TTL index |
| created_at | ISO8601 | ✔ | |

QR invite (deeplink) chứa: `session_id`, `pairing_token`, `server_url`,
`expiry` — tái dùng cơ chế one-time token + hash + TTL của GĐ1.
**Không chứa Channel Key / private key / credential dài hạn.**

State machine (transaction):

```text
UNUSED ──(B submit request, expires_at > now)──> CLAIMED
UNUSED ──(expires_at <= now)────────────────────> EXPIRED
CLAIMED ──(C submit)────────────────────────────> 409 QR_ALREADY_USED
```

### 3.5. `pairing_requests/{requestId}` — hàng đợi phê duyệt

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| request_id | string | ✔ | |
| channel_id | string | ✔ | |
| session_id | string | ✔ | |
| requester_device_id | string | ✔ | |
| requester_device_name | string | ✔ | User B nhập/sửa khi gửi request |
| requester_public_key | string | ✔ | Chụp lúc claim |
| owner_device_name | string | ✖ | Tên thiết bị của Owner kênh lúc gửi request, cập nhật fan-out khi Owner đổi tên |
| status | string | ✔ | `PENDING` \| `APPROVED` \| `REJECTED` \| `CANCELLED` |
| decided_by | string | ✖ | device_id của Owner |
| decided_at | ISO8601 | ✖ | |
| created_at | ISO8601 | ✔ | Thời gian chờ duyệt không giới hạn |
| terminal_at | ISO8601 | ✖ | Cleanup 30 ngày sau khi vào trạng thái cuối |

State machine (transaction): `PENDING → APPROVED/REJECTED (Owner), PENDING →
CANCELLED (requester)`. APPROVED kéo theo rotation — xem T2.

### 3.5b. `pairing_pending/{channelId}__{deviceId}` — marker chống claim trùng

Marker tồn tại **khi và chỉ khi** thiết bị có request PENDING cho kênh —
dedup guard của T1 (spec §5.1), tạo/xóa trong cùng transaction với
`pairing_requests`.

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| channel_id | string | ✔ | |
| requester_device_id | string | ✔ | |
| request_id | string | ✔ | Trỏ tới `pairing_requests` tương ứng |
| created_at | ISO8601 | ✔ | |

Lifecycle: tạo lúc claim (T1) — claim thứ hai cùng `(channel, requester)` trên
session khác vẫn chạm đúng doc id này → `409 REQUEST_ALREADY_PENDING`; xóa khi
request vào trạng thái cuối (T2 APPROVED / T6 REJECTED / T6 CANCELLED) → thiết
 bị được claim QR mới. Member ACTIVE chặn ở tầng `channel_members` (`409
ALREADY_MEMBER`), không cần marker.

### 3.6. `channel_key_envelopes/{channelId}__{deviceId}__{epoch}`

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| channel_id | string | ✔ | |
| device_id | string | ✔ | **Gồm cả Owner** (self-envelope, KL4) |
| key_epoch | int | ✔ | |
| wrapped_key | string (base64) | ✔ | Format mục 7.2 |
| nonce | string (base64) | ✔ | IV 12 byte |
| kek_alg | string | ✔ | 'X25519-ECDH-HKDF-SHA256/AES-256-GCM' |
| created_at | ISO8601 | ✔ | |
| fetched_at | ISO8601 | ✖ | Chỉ chứng minh HTTP fetch, không chứng minh decrypt |

Ràng buộc: envelope chỉ tồn tại cho `(member ACTIVE, epoch >= joined_epoch)`.
Member REVOKED **không bao giờ** được provision envelope epoch sau (KL8) và
không fetch được envelope nào sau revoke (KL12).
Fetch idempotent: `GET /channels/key-envelope?channel_id={id}&epoch={n}`.

### 3.7. `channel_messages/{messageId}`

| Field | Type | Bắt buộc | Ghi chú |
|---|---|---|---|
| channel_id | string | ✔ | |
| sequence_number | int | ✔ | Sinh atomic từ `sequence_counter` |
| ciphertext | string (base64) | ✔ | AEAD bằng CK_epoch |
| nonce | string (base64) | ✔ | IV 12 byte |
| key_epoch | int | ✔ | **Phải == `current_epoch` tại thời điểm accept** (KL7) |
| sender_device_id | string | ✔ | == owner_device_id (v1) |
| sent_at | ISO8601 | ✔ | Đồng hồ A |
| server_received_at | ISO8601 | ✔ | Retention 30 ngày |

---

## 4. Transactions & Package Pattern

### 4.0. Package Pattern — nguyên tắc chung

**Owner là key authority. Mọi membership mutation đều là một Owner package,
và mọi membership mutation đều tạo key boundary mới (KL11):**

```text
Owner
 ├─ đọc epoch = N, membership_version = M        (snapshot)
 ├─ [create]   sinh CK_1                          (epoch khởi tạo)
 ├─ [approve]  sinh CK_(N+1)                      (KHÔNG dùng lại CK_N)
 ├─ [revoke]   sinh CK_(N+1)
 ├─ wrap envelope cho đúng envelope set (bảng 4.1)
 └─ POST package {base_epoch: N, base_membership_version: M, envelopes[], ...}
          ↓
Server transaction
 ├─ verify sender == owner_device_id
 ├─ verify current_epoch == N && membership_version == M   (optimistic lock)
 ├─ verify snapshot member khớp trạng thái hiện tại
 ├─ verify envelope set đầy đủ theo bảng 4.1    → thiếu ⇒ 422 PACKAGE_INCOMPLETE
 └─ commit nguyên khối hoặc không commit gì
          ↓
Membership đã đổi từ lúc snapshot? ⇒ 409 MEMBERSHIP_CHANGED
→ Owner sync lại state (fetch current_epoch + version) → tạo package mới.
```

Server **không bao giờ** sinh key, không derive KEK, không unwrap envelope —
chỉ validate cấu trúc + commit (KL1, KL2).

### 4.1. Bảng transaction

| # | Operation | Envelope set (đúng định nghĩa) | Transaction gồm | Error codes |
|---|---|---|---|---|
| T0 | Create channel (**Owner package**) | `{Owner}` với epoch 1 | Verify package (epoch=1) → tạo `channels` (epoch=1, **membership_version=1**) + member doc Owner + self-envelope | `422 PACKAGE_INCOMPLETE` |
| T1 | Claim QR (B submit request) | — | `pairing_sessions`: `status==UNUSED && expires_at>now` → `CLAIMED` + `claimed_by` + tạo `pairing_requests` (PENDING) + tạo marker `pairing_pending/{channelId}__{deviceId}`; chặn member ACTIVE (`409 ALREADY_MEMBER`) và marker còn tồn tại (`409 REQUEST_ALREADY_PENDING`) | `409 QR_ALREADY_USED`, `410 QR_EXPIRED`, `409 ALREADY_MEMBER`, `409 REQUEST_ALREADY_PENDING` |
| T2 | Approve request (**Owner package**, **rotate**) | `{Owner} ∪ {ACTIVE trước transaction} ∪ {Requester}` — tất cả với **epoch N+1** | Verify package → `pairing_requests: PENDING→APPROVED` + tạo member ACTIVE cho requester (`joined_epoch=N+1`, `provisioned_epoch=N+1`) + cập nhật `provisioned_epoch=N+1` các member cũ + envelopes + `current_epoch=N+1`, `membership_version+1`, `member_count+1` | `409 MEMBERSHIP_CHANGED`, `422 PACKAGE_INCOMPLETE`, `403 NOT_OWNER`, `409 REQUEST_NOT_PENDING` |
| T3 | Gửi message (A) | — | Verify `sender==owner` + **`request.epoch == channels.current_epoch`** + anti-replay (T5) → `sequence_counter+1` → tạo message | `409 EPOCH_OUTDATED`, `403 FORBIDDEN` |
| T4 | Revoke + rotate (**Owner package**, **rotate**) | `{Owner} ∪ {ACTIVE còn lại sau revoke}` — với **epoch N+1** | Verify package → member(s) chỉ định `ACTIVE→REVOKED` + `current_epoch=N+1` + envelopes + cập nhật `provisioned_epoch=N+1` + `membership_version+1` | `409 MEMBERSHIP_CHANGED`, `422 PACKAGE_INCOMPLETE`, `403 NOT_OWNER` |
| T5 | Anti-replay | — | In-memory `sha256(channel_id|nonce|ciphertext)` TTL 24h — **chạy trước T3** | `409 REPLAY_DETECTED` |
| T6 | Reject/Cancel | — | `PENDING→REJECTED/CANCELLED`; session KHÔNG tái sử dụng (mã đã cháy) | — |

**Lưu ý T5:** server-generated `sequence_number` + uniqueness
`(channel_id, sequence)` là security boundary chính cho uniqueness.
`ReplayGuardService` chỉ là **defense-in-depth** (bị bypass khi chạy
multi-instance) — không bao giờ là source of truth.

## 5. Access patterns & indexes

| # | Query | Index |
|---|---|---|
| Q1 | Pending approvals của 1 channel | `pairing_requests (channel_id ASC, status ASC, created_at DESC)` |
| Q2 | Channel mà device B thuộc về | `channel_members (device_id ASC, status ASC)` → join `channels` batch |
| Q3 | Member ACTIVE của channel | `channel_members (channel_id ASC, status ASC)` |
| Q4 | Đọc tin nhắn **theo ngày, gộp MỌI kênh** caller **đang ACTIVE** (KL12 — kênh đã REVOKED bị loại): bước 1 lấy `channel_ids` từ Q2; bước 2 `where('channel_id', 'in', ids).where(server_received_at >= from).where(server_received_at < to)` (biên ngày = `date` + `tz_offset`) → **Composite: `channel_messages (channel_id ASC, server_received_at ASC)`**. Lưu ý Firestore `in` tối đa 30 giá trị/lần query — >30 kênh thì tách batch. Server gộp kết quả các batch, sort theo `server_received_at` trước khi trả |
| Q5 | Dọn session hết hạn | TTL index `pairing_sessions.expires_at` + quét phụ 10'/lần |
| Q6 | Lịch sử envelope của 1 member | Field query: `channel_key_envelopes where channel_id==X && device_id==Y orderBy key_epoch` + composite index `(channel_id ASC, device_id ASC, key_epoch ASC)` |

## 6. Mapping API ↔ collections

> Quy ước routing (khớp `SERVER_API_SPEC.md` v1.1): **không dùng path
> parameter** — mọi id/tham số nằm trong query string (GET) hoặc body
> (POST/PUT); route chỉ còn path tĩnh.

| Endpoint (đích) | Đọc | Ghi |
|---|---|---|
| POST /channels (**Owner package**: metadata + self-envelope K1) | — | T0 |
| POST /channels/sessions (tạo QR; body: `channel_id`) | `channels` (owner check) | Tạo `pairing_sessions` |
| POST /pairing/requests (B claim) | `pairing_sessions`, `channels` | T1 |
| GET /channels/requests?channel_id=&status=PENDING | Q1 | — |
| POST /pairing/requests/approve (**package: rotate**; body: `request_id`) | package + `devices` | T2 |
| POST /pairing/requests/reject — /cancel (body: `request_id`) | Q1 | T6 |
| POST /channels/revoke (**package: revoke list + rotate**; body: `channel_id`) | members | T4 |
| GET /channels/key-envelope?channel_id=&epoch | envelopes | (set fetched_at) |
| POST /channels/messages (body: `channel_id`, `request_epoch`, ciphertext) | `channels`, members | T5 + T3 |
| GET /messages?date=&tz_offset (gộp mọi kênh caller là member) | Q2 + Q4 | — |

FCM chỉ gửi thông báo "có thay đổi" (join request / approved / revoked /
tin nhắn mới) — mất FCM không mất dữ liệu (N8).

## 7. Hợp đồng mật mã

### 7.1. Channel Key & message

- `CK_epoch_n`: AES-256 key, sinh **trên Owner**, giữ trong SecureVault.
- Message AEAD: AES-256-GCM, nonce 12 byte random.
- **Canonical encoding (bắt buộc dùng chung BE/Flutter, cấm nối string tự do):**

```text
bind(ch, epoch, seq)  = "sms-navigator-msg-v1" || u32(len(ch)) || ch || u64(epoch) || u64(seq)
bind(ch, epoch, dev)  = "sms-navigator-env-v1" || u32(len(ch)) || ch || u64(epoch) || u32(len(dev)) || dev

message AAD  = bind(channel_id, key_epoch, sequence_number)
envelope AAD = bind(channel_id, key_epoch, device_id)
```

(`u32/u64` little-endian, chuẩn hoá một lần, nằm trong 1 file shared constant
mỗi phía.)

### 7.2. Key Envelope

```text
KEK_B = HKDF-SHA256(
          ikm  = ECDH(sk_owner, pk_member),
          salt = SHA256("sms-navigator-salt-v1" || u32(len(channel_id)) || channel_id || u64(key_epoch)),
          info = 'sms-navigator-kek-v1',
          L    = 32 )
wrapped_key = AES-256-GCM(key = KEK_B, nonce = 12B random,
                          plaintext = CK_epoch,
                          aad = envelope AAD ở 7.1)
```

- Không dùng ECDH raw làm key; salt gắn channel+epoch chống cross-channel /
  cross-epoch KEK reuse.
- **Create/approve/revoke đều sinh key mới** (KL11): CK_1 lúc create;
  CK_(N+1) lúc approve và revoke. Message send **không bao giờ** sinh key.
- **Self-envelope của Owner** có trong mọi package: `ECDH(sk_A, pk_A)` là phép
  toán hợp lệ trên X25519 (scalar-multiply chính public key của mình) — ghi rõ
  để không bị "sửa" thành lỗi sau này.

### 7.3. Recovery flow của Owner (không cần path đặc biệt)

```text
Owner crash sau khi package commit nhưng trước khi persist CK mới
→ mở app → fetch envelope {channelId}__{owner}__{epoch} mới nhất
→ ECDH(sk_A, pk_A) → unwrap → persist CK_epoch
```

Cũng là cơ chế client xử lý `409 EPOCH_OUTDATED`: fetch self-envelope epoch
mới → unwrap → persist → retry gửi.

## 8. Policy nghiệp vụ

### 8.1. Member mới và history

**Member chỉ decrypt được message từ `joined_epoch` trở đi — và giờ đây là
rào cản mật mã, không chỉ phân quyền:** member được provision đúng một lần tại
epoch join (T2 rotate), không bao giờ sở hữu key của epoch trước đó, nên về
mặt toán học không thể decrypt history trước join (kể cả khi ciphertext cũ rò
rỉ, thiếu K cũ là điều kiện cần để mở).

**Decision record — đã loại hash ratchet:** phương án "approve không rotate"
+ ratchet chuỗi key (`CK_{i+1} = HKDF(CK_i)`) về lý thuyết cũng chặn được
history, nhưng bị loại vì (a) member fetch muộn (mở một ngày cũ còn trong
retention) cần key epoch cũ — ratchet không reconstruct được chuỗi cũ, phải
lưu envelope per-message; (b) phức tạp hoá đọc out-of-order. Rotate-on-join
đơn giản hơn nhiều với chi phí O(members) cho sự kiện hiếm.

### 8.2. Identity reinstall

Reinstall = device_id mới + identity key mới → **phải re-join** (claim QR mới +
chờ Owner duyệt). Membership slot của bản cài cũ nên được Owner revoke trong
quá trình đối soát danh sách thiết bị.

### 8.3. Revoke luôn đi kèm rotate

T4 là **auto-rotate**: revoke xong `current_epoch+1` ngay trong cùng package.
Không có trạng thái "revoked nhưng chưa rotate".

### 8.4. Authorization khi đọc & client epoch-key retention

**Thứ bậc quyền đọc (KL12):**

```text
Authorization = membership ACTIVE tại thời điểm query   ← source of truth
Crypto        = epoch key                               ← cơ chế thực thi, KHÔNG phải quyền
```

Member đọc tin nhắn **theo ngày, gộp mọi kênh mình đang ACTIVE** (date-based
fetch, không có local message store), không theo epoch — sau một rotation, tin
nhắn epoch cũ vẫn nằm trong retention 30 ngày và **phải decrypt được bằng key
epoch cũ** khi user mở một ngày cũ. Do đó:

```text
Client giữ map epoch → CK cho MỌI epoch mình được provision.
Chỉ purge epoch E khi đã chắc chắn không còn message của epoch E
trong retention (epoch E cũ hơn MESSAGE_RETENTION_DAYS).
```

Xóa key cũ ngay sau khi nhận key mới = tự gây mất tin nhắn có thể fetch được.

**Khi bị revoke:** server loại kênh đó khỏi `GET /messages` và không trả
envelope nào nữa (`403 REVOKED`) — authorization **kết thúc tại revocation**.
Client purge **key material** của channel (map `epoch → CK` + envelope cache)
theo policy; không có local message store để xóa.

**Decision record — ghi đè §15 của `TECH_DEBT_SOLUTION.md`:** §15 nói
"decrypt history cũ là hành vi đã chấp nhận" vì không thể làm revoked member
"quên" key đã nhận — điều đó **vẫn đúng về mặt mật mã** và không bị phủ nhận.
Nhưng trong thiết kế không-local-store, server là **nguồn duy nhất** của
ciphertext, nên chặn server trả ciphertext của kênh đã revoke = chặn hết khả
năng đọc thực tế, với chi phí 0 (chỉ là filter đã có sẵn). Đổi lại thu hẹp
bề mặt tấn công đáng kể (TD-2) và API contract sạch. **Residual risk trung
thực:** rào cản này là authorization, không phải mật mã — server malicious +
revoked member còn giữ key cũ + có được ciphertext từ nguồn khác ⇒ vẫn decrypt
được; KL8 (không envelope mới) mới là rào chắn mật mã thực sự cho tương lai.

## 9. Key Lifecycle Invariants (KL1–KL12)

> Hợp đồng tối thượng — mọi implementation (BE/Flutter/Kotlin) phải enforce và
> không được diễn giải lại. Mỗi invariant có enforce-point tương ứng.

```text
KL1.  Server never generates, decrypts, or derives any key material
      (CK / KEK).                              [enforce: code review key path; không có keygen phía server]

KL2.  Owner is the key authority.              [enforce: T0/T2/T4 chỉ accept package từ owner_device_id → 403 NOT_OWNER]

KL3.  Every ACTIVE member is provisioned an encrypted envelope
      for the applicable epoch.                [enforce: T0/T2/T4 verify envelope set theo bảng 4.1 → 422 PACKAGE_INCOMPLETE]

KL4.  Owner MUST be provisioned a self-envelope for every epoch.
                                               [enforce: như KL3 — envelope set luôn gồm Owner]

KL5.  current_epoch advances ONLY inside an atomic package
      transaction for a membership mutation.   [enforce: không có code path nào tăng epoch ngoài T0/T2/T4]

KL6.  Every package carries (base_epoch, base_membership_version)
      it was generated against.                [enforce: T2/T4 optimistic check → 409 MEMBERSHIP_CHANGED]

KL7.  message.key_epoch MUST equal channels.current_epoch
      when the message is accepted.            [enforce: T3 check → 409 EPOCH_OUTDATED]

KL8.  A revoked member is never provisioned an envelope for a
      subsequent epoch.                        [enforce: T4 envelope set = {Owner} ∪ ACTIVE còn lại]

KL9.  Envelopes are cryptographically bound to (channel, epoch, device)
      via AEAD AAD — swapping an envelope across members or epochs
      fails to open.                           [enforce: envelope AAD 7.1/7.2]

KL10. A ciphertext is cryptographically bound to (channel, epoch, sequence)
      via AEAD AAD — the server cannot reassign sequence numbers
      to old ciphertexts.                      [enforce: message AAD 7.1]

KL11. Every membership mutation (create/approve/revoke) produces a NEW
      epoch key; message sends NEVER change the key.   [enforce: T0/T2/T4 đều rotate; T3 không đụng epoch]

KL12. Membership ACTIVE at query time is the source of truth for READ
      authorization; key possession alone never grants read access.
      Revocation ends authorization immediately — server stops returning
      messages and envelopes of that channel.
                                               [enforce: GET /messages lọc theo member doc ACTIVE; GET key-envelope 403 REVOKED; không có code path nào cấp ciphertext/envelope dựa trên thông tin khác]
```

## 10. Bảo mật & vận hành

- Client không truy cập Firestore trực tiếp (Admin SDK phía server); Security
  Rules không phải rào chắn chính nhưng project key không expose ra client.
- Rate limit gắn lên claim/approve/message như GĐ1; claim giữ budget chặt
  (10/5 phút/IP) chống brute-force token.
- Giữ doc member `REVOKED` (không delete) để audit; chặn tái nhập bằng
  blacklist `device_id` tại T1 nếu muốn.

## 11. Migration & deprecation

- App chưa phát hành → **không cần data migration**: tạo bộ collection mới,
  đánh dấu `pairs`/`pair_keys`/`messages` deprecated, xoá khi luồng mới ổn định.
- Tái sử dụng: `ReplayGuardService` (T5, role đã định nghĩa lại), deeplink
  invite (GĐ3), SecureVault (GĐ4), scanner neutral router (GĐ0 — thêm
  `JoinChannelHandler`).

## 12. Open questions — trạng thái

| # | Câu hỏi | Trạng thái |
|---|---|---|
| OQ-1 | Owner recovery khi A mất máy (identity key không khôi phục) | **MỞ (thu hẹp)**: crash recovery đã xử lý bằng self-envelope (7.3); mất hẳn thiết bị = mất kênh trong v1, tạo lại kênh. Backup identity key mã hóa passphrase để V2 quyết định |
| OQ-2 | Rotate ngay khi revoke? | **ĐÃ ĐÓNG**: auto-rotate trong T4 (mục 8.3) |
| OQ-3 | Message retention | **ĐÃ ĐÓNG**: TTL 30 ngày theo `server_received_at` (mục 8.4) |
| OQ-4 | Định danh token trong QR | **ĐÃ ĐÓNG**: `session_id` + `pairing_token` 128-bit, server lưu SHA-256 hash, single-use + TTL 10' (3.4) |
