# BACKLOG — các hạng mục chưa làm (Backend / Express + Firestore)

> Tài liệu gom toàn bộ nợ kỹ thuật + roadmap chưa triển khai của phía server.
> Mục đã hoàn thành bị loại khỏi danh sách; hoàn thành mục nào thì xoá mục đó.
> App chỉ hỗ trợ **Android** — không làm hạng mục iOS (AASA, APNs…).
> Cập nhật lần cuối: 22/10/2026.

---

## 0. Triển khai / vận hành

| # | Hạng mục | Ghi chú | Ưu tiên |
|---|---|---|---|

---

## A. Lệch thiết kế & luồng chưa tối ưu (phát hiện 22/10 khi test OTP trên máy thật)

Đi cùng mục A của `../sms_navigator/BACKLOG.md` (A1–A8).

| # | Hạng mục | Chi tiết | Ưu tiên |
|---|---|---|---|
| A2 | Bell `KEY_ROTATED` cho member còn lại khi rotate | Approve/revoke hiện chỉ báo requester / người bị thu hồi. Data-only `{ type: CHANNEL_EVENT, kind: KEY_ROTATED, channel_id, epoch }` cho mọi member ACTIVE khác (trừ Owner) → app lấy key ngay. Bỏ qua khi `replayed: true`. Tối ưu, không bắt buộc nếu mobile A1 + A2 xong. | P2 |
| A3 | Ciphertext trong `NEW_MESSAGE` (chờ quyết định bỏ I5) | Thêm `ciphertext`, `nonce`, `key_epoch` vào data khi tổng payload ≤ ~3.5 KB (giới hạn FCM 4 KB), ngược lại bỏ — app tự `GET /channels/message`. Sửa spec §7 + SRD (I5), test kích thước. | P2 |
| A4 | Chính sách lưu envelope | Envelope **không bao giờ bị xoá** (chỉ `clearAll` trong test) — đúng điều kiện cho A1 (lấy lại epoch cũ), nhưng tăng mãi và vẫn giữ envelope của member đã revoke (dù không trả ra — KL12). Quyết định: xoá envelope cũ hơn retention tin nhắn (30 ngày) và/hoặc của member đã revoke; ghi vào SRD §8.4. | P3 |
| A5 | Thay thế thiết bị khi khôi phục backup | Đi cùng mobile A7: cấp `device_token` mới (hoặc `token_generation`) khi máy khôi phục xác thực lần đầu → token cũ 401 → máy cũ thôi giành FCM token / relay. | P2 |
| A6 | ~~Rà soát luồng phía server~~ — xong, xem `../sms_navigator/docs/FLOW_AUDIT.md` | Phần BE của mobile A8: với từng endpoint ghi số lần đọc/ghi Firestore, bell bắn cho ai, idempotency, và đối chiếu bất biến SRD. | P1 |
| A8 | KL10 — sequence không nằm trong AAD | Phần BE của mobile A10: nhận + lưu `client_seq`, từ chối trùng trong `(channel, epoch)`; spec §6.2 + SRD §7.1 (`sms-navigator-msg-v2`). Chờ quyết định thiết kế. | P1 |
| A9 | Retention & dọn dữ liệu không được thực thi | Tin nhắn "retention 30 ngày" (SRD §3.7) nhưng không có job xoá và `server_received_at` là chuỗi ISO → **không** dùng được Firestore TTL policy. Tương tự `pairing_sessions` (TTL 10'), `pairing_requests` (dọn 30 ngày sau trạng thái cuối). Sửa: thêm field `expire_at` kiểu Timestamp khi ghi + bật TTL policy trên Firestore (hoặc job dọn định kỳ); backfill dữ liệu cũ. Làm cùng A4. | P2 |

---

## 1. Vòng đời thiết bị sau uninstall — quyết định nghiệp vụ

- Đã có báo cáo chỉ-đọc `npm run report:stale-devices -- <days>` (xem mục 4). Còn lại: **quyết định** có tự revoke membership của thiết bị "stale" hay không (lưu ý máy khôi phục từ bản sao lưu quay lại với cùng `device_id`). Chưa có job tự động.

---

## 2. API mới

| # | Hạng mục | Chi tiết | Ưu tiên |
|---|---|---|---|

---

## 3. Quan sát / log

| # | Hạng mục | Chi tiết |
|---|---|---|

---

## 4. Hạng mục đã hoàn thành (tham khảo — đừng làm lại)

- **PR #2 `feat/backlog-sweep`** — sửa theo rà soát (`../sms_navigator/docs/FLOW_AUDIT.md`):
  - **S1 / A7** — `POST /devices/register` với `device_id` đã có: chỉ chấp nhận khi kèm Bearer token hiện tại của chính thiết bị (xoay token, **không** đổi `public_key`), ngược lại `409 DEVICE_EXISTS`. Spec §3.1 + bảng lỗi.
  - **A1** — `GET /api/v2/key-envelopes[?channel_id=]` (§6.1b): mọi envelope của máy gọi theo kênh ACTIVE, epoch ≥ `joined_epoch`, kèm `owner_public_key` + `current_epoch`.
  - **A10** — `GET /channels` trả thêm `rotation_pending` (whitelist đã có) → đồng bộ relay của Owner không cần `GET /channels/detail` từng kênh.

- **Nhánh `feat/backlog-sweep`** (xem `REVIEW_BACKLOG.md` để kiểm thử):
  - CI pull request `.github/workflows/ci.yml` (tsc, lint, Jest, build) — cũ: mục 3.2.
  - Clean-cut v4: gỡ `pairing_token` / `invite_url` khỏi `POST /channels/sessions`, gỡ `POST /channels/sessions/resolve`, claim chỉ bằng `code`; cập nhật API spec + SRD — cũ: mục 0.3. **Deploy sau khi `app_update_min_build` ≥ 20.**
  - Đổi tên kênh `PUT /api/v2/channels/name` (Owner, 1–100 ký tự, display-only, không FCM) + spec §4.8 — cũ: mục 2.1.
  - Vòng đời kênh: `POST /channels/leave` (REVOKED + `rotation_pending`, bell MEMBER_LEFT), `POST /channels/rotate` (Owner re-key), `POST /channels/archive` (terminal, huỷ invite/request, ẩn tin, bell REVOKED/ARCHIVED); chặn tạo QR trên kênh đã giải tán; spec §4.9–4.11 — cũ: mục 2.2.
  - Lịch sử request đã xử lý: `GET /channels/requests?status=HISTORY` + phân trang `limit`/`before`, item có `status`/`decided_at`; spec §5.3 — cũ: mục 2.3.
  - Log đếm bell `targets/sent/failed/no_token` cho mọi loại qua `FcmService.bellDevices` / `logBellCounts` — cũ: mục 3.1.
  - Báo cáo chỉ-đọc thiết bị đã gỡ app (`last_seen_at` quá N ngày + không còn FCM token, kèm kênh ACTIVE): `npm run report:stale-devices -- <days>` — cũ: mục 1 (phần job dọn; tự revoke vẫn chờ quyết định).
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
