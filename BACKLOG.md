# BACKLOG — các hạng mục chưa làm (Backend / Express + Firestore)

> Tài liệu gom toàn bộ nợ kỹ thuật + roadmap chưa triển khai của phía server.
> Mục đã hoàn thành bị loại khỏi danh sách; hoàn thành mục nào thì xoá mục đó.
> App chỉ hỗ trợ **Android** — không làm hạng mục iOS (AASA, APNs…).
> Cập nhật lần cuối: 22/10/2026.

---

## 0. Triển khai / vận hành

| # | Hạng mục | Ghi chú | Ưu tiên |
|---|---|---|---|
| 0.3 | Roadmap GĐ6 — clean-cut v4: gỡ `pairing_token`, `invite_url`, `POST /channels/sessions/resolve`, claim bằng token | Chỉ làm **sau** khi mobile bật force update (`min_version`) | P1 |

---

## A. Lệch thiết kế & luồng chưa tối ưu (phát hiện 22/10 khi test OTP trên máy thật)

Đi cùng mục A của `../sms_navigator/BACKLOG.md` (A1–A8).

| # | Hạng mục | Chi tiết | Ưu tiên |
|---|---|---|---|
| A1 | **`GET /api/v2/key-envelopes[?channel_id=]` — gom mọi envelope của máy gọi** | Hiện client phải gọi `GET /channels/detail` + `GET /channels/key-envelope` cho từng kênh, và chỉ lấy được epoch mới nhất nếu không truyền `epoch` → lệch SRD §8.4 (mobile A1/A2/A4). Cài đặt: 1 query `channel_key_envelopes where device_id == caller` (field đã có trong document, index đơn tự động) + 1 query membership ACTIVE của caller (lọc kênh đã revoke — KL12) + đọc theo lô `channels` và public key của Owner. Trả `[{ channel_id, current_epoch, owner_public_key, envelopes: [{ key_epoch, wrapped_key, nonce, kek_alg }] }]`; chỉ các epoch đã cấp cho máy này (KL8). Rate limit nhóm read. Giữ `GET /channels/key-envelope` cho app cũ. Spec §6.1b + test. | P0 |
| A2 | Bell `KEY_ROTATED` cho member còn lại khi rotate | Approve/revoke hiện chỉ báo requester / người bị thu hồi. Data-only `{ type: CHANNEL_EVENT, kind: KEY_ROTATED, channel_id, epoch }` cho mọi member ACTIVE khác (trừ Owner) → app lấy key ngay. Bỏ qua khi `replayed: true`. Tối ưu, không bắt buộc nếu mobile A1 + A2 xong. | P2 |
| A3 | Ciphertext trong `NEW_MESSAGE` (chờ quyết định bỏ I5) | Thêm `ciphertext`, `nonce`, `key_epoch` vào data khi tổng payload ≤ ~3.5 KB (giới hạn FCM 4 KB), ngược lại bỏ — app tự `GET /channels/message`. Sửa spec §7 + SRD (I5), test kích thước. | P2 |
| A4 | Chính sách lưu envelope | Envelope **không bao giờ bị xoá** (chỉ `clearAll` trong test) — đúng điều kiện cho A1 (lấy lại epoch cũ), nhưng tăng mãi và vẫn giữ envelope của member đã revoke (dù không trả ra — KL12). Quyết định: xoá envelope cũ hơn retention tin nhắn (30 ngày) và/hoặc của member đã revoke; ghi vào SRD §8.4. | P3 |
| A5 | Thay thế thiết bị khi khôi phục backup | Đi cùng mobile A7: cấp `device_token` mới (hoặc `token_generation`) khi máy khôi phục xác thực lần đầu → token cũ 401 → máy cũ thôi giành FCM token / relay. | P2 |
| A6 | ~~Rà soát luồng phía server~~ — xong, xem `../sms_navigator/docs/FLOW_AUDIT.md` | Phần BE của mobile A8: với từng endpoint ghi số lần đọc/ghi Firestore, bell bắn cho ai, idempotency, và đối chiếu bất biến SRD. | P1 |
| A7 | **P0 — Chiếm quyền thiết bị qua `POST /devices/register` (S1)** | Endpoint không cần xác thực; với `device_id` đã tồn tại nó **ghi đè `token_hash` và `public_key`**. `device_id` lộ cho mọi member (`GET /channels/members`, `sender_device_id`) → member chiếm được máy Owner: duyệt/thu hồi như Owner (KL2 chỉ so `owner_device_id`), và mọi package sau đó wrap key cho public key của kẻ tấn công. Sửa: `device_id` đã tồn tại → `409 DEVICE_EXISTS`, trừ khi kèm Bearer token hợp lệ của chính thiết bị (khi đó chỉ xoay token, **không** đổi `public_key`). Phát hành cùng mobile A9. Test: re-register không token → 409; có token → token mới, `public_key` giữ nguyên. | P0 |
| A8 | KL10 — sequence không nằm trong AAD | Phần BE của mobile A10: nhận + lưu `client_seq`, từ chối trùng trong `(channel, epoch)`; spec §6.2 + SRD §7.1 (`sms-navigator-msg-v2`). Chờ quyết định thiết kế. | P1 |
| A9 | Retention & dọn dữ liệu không được thực thi | Tin nhắn "retention 30 ngày" (SRD §3.7) nhưng không có job xoá và `server_received_at` là chuỗi ISO → **không** dùng được Firestore TTL policy. Tương tự `pairing_sessions` (TTL 10'), `pairing_requests` (dọn 30 ngày sau trạng thái cuối). Sửa: thêm field `expire_at` kiểu Timestamp khi ghi + bật TTL policy trên Firestore (hoặc job dọn định kỳ); backfill dữ liệu cũ. Làm cùng A4. | P2 |
| A10 | `GET /channels` trả thêm `owner_public_key`, `whitelist_version` | Bỏ được `GET /channels/detail` ở mọi vòng lấy key và sync whitelist phía mobile (mobile A12); chi phí: thêm field vào truy vấn owner đã có sẵn trong `listChannelsForDevice`. | P2 |

---

## 1. Vòng đời thiết bị sau uninstall — job dọn định kỳ (tuỳ chọn)

- Token chết đã tự xoá khi FCM báo `registration-token-not-registered` / `invalid-registration-token` (`FcmService` → `deviceService.clearFcmToken`, so-khớp-rồi-xoá trong transaction: token mới upload sau đó được giữ).
- Còn lại: job dọn định kỳ device không `last_seen_at` quá N ngày + không còn token → review membership/envelope cleanup (chỉ dọn token, không tự revoke membership — quyết định nghiệp vụ).
- Lưu ý từ backup/khôi phục (mobile 1.1): máy khôi phục dùng lại `device_id` + `device_token` cũ và gửi FCM token mới — **không** được coi đó là thiết bị mới.

---

## 2. API mới

| # | Hạng mục | Chi tiết | Ưu tiên |
|---|---|---|---|
| 2.1 | Đổi tên kênh `PUT /api/v2/channels/name` | Owner only (`403 FORBIDDEN`); `z.object({ channel_id, name: z.string().trim().min(1).max(50) })`; chỉ cập nhật `channels/{id}.name` (metadata hiển thị, không rotate epoch); tuỳ chọn bell cho member. Đi cùng mobile 1.5. | P2 |
| 2.2 | Vòng đời kênh: member tự rời (`leave`), Owner lưu trữ/giải tán (`archive`) | `leave` = revoke chính mình → Owner phải rotate ở lần gửi kế tiếp (409 `EPOCH_OUTDATED` đã tự phục hồi phía native). Đi cùng mobile 1.4. | P2 |
| 2.3 | Lịch sử request đã xử lý cho Owner | `GET /channels/requests?status=` đã có — kiểm tra phân trang + giới hạn số bản ghi trước khi mobile dùng (mobile 1.6). | P3 |

---

## 3. Quan sát / log

| # | Hạng mục | Chi tiết |
|---|---|---|
| 3.1 | Log đếm bell cho JOIN_REQUEST / APPROVED / REVOKED | `NEW_MESSAGE` đã có log `members/sent/failed/no_token`; các bell còn lại gửi 1 thiết bị, vẫn chỉ `warn` khi lỗi. |
| 3.2 | CI cho pull request | Repo chỉ có `keep-alive.yml`. Thêm workflow `pull_request`: `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm test` (Jest chạy offline bằng Firestore mock). Đặc biệt quan trọng vì `main` tự deploy lên Render. |

---

## 4. Hạng mục đã hoàn thành (tham khảo — đừng làm lại)

- **22/10/2026**: `ANDROID_CERT_SHA256` đã đặt trên Render (SHA release + debug máy build); `assetlinks.json` production đúng, máy test báo App Links `verified` (cũ: mục 0.1). Đổi keystore/máy build → chạy lại `scripts/print_android_sha256.sh` của repo mobile và cập nhật biến.
- **22/10/2026**: tự xoá FCM token chết (cũ: bước 1 mục 1); log đếm bell `NEW_MESSAGE` (một phần mục 3.1).
- **22/10/2026** (nhánh `feat/otp-notification`): filter `fcm_token` trong `notifyNewMessage` dùng truthy check (token rỗng `''` không còn lọt qua).
- **Nhánh `feat/otp-notification`** (đã merge `main` — PR #1, đang chạy trên Render): `NEW_MESSAGE` data-only cho Android kèm `sequence_number` + `sender_device_id`; `GET /api/v2/channels/message` (§6.4).
- **21/10/2026** (đã lên `main`):
  - Universal Opaque QR v3.3: con trỏ `qr_codes/{sha256(code)}`, `GET /api/v2/qr/resolve`, claim bằng `code`, `/qr/:code` fallback, `/.well-known/assetlinks.json` + AASA (từ env).
  - Xoay khoá idempotent: biên nhận `last_rotation` (hash package) → gửi lại y hệt trả `200 replayed: true`; 409 kèm `current_epoch` / `membership_version`; `ChannelMembershipService` là nơi duy nhất ghi epoch/envelope.
- **19/10/2026**: whitelist theo từng kênh `PUT /api/v2/channels/whitelist` (optimistic version).
- Kiến trúc V2 channel 1-to-N E2EE đầy đủ (sessions, claim/approve/reject/cancel, revoke + rotate, key envelopes, messages by date) — spec: `SERVER_API_SPEC.md`, `SRD_DATABASE.md`.
- Xoá toàn bộ stack V1 + refactor health endpoint; README sang kiến trúc V2.
- FCM chuông V2 cho đủ 4 kind (NEW_MESSAGE / JOIN_REQUEST / APPROVED / REVOKED).
- Anti-replay T5 dùng chung `checkAndRecordHash` (`sha256(channel_id|nonce|ciphertext)`).
