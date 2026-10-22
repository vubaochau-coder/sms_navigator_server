# BACKLOG — các hạng mục chưa làm (Backend / Express + Firestore)

> Tài liệu gom toàn bộ nợ kỹ thuật + roadmap chưa triển khai của phía server.
> Mục đã hoàn thành bị loại khỏi danh sách; hoàn thành mục nào thì xoá mục đó.
> App chỉ hỗ trợ **Android** — không làm hạng mục iOS (AASA, APNs…).
> Cập nhật lần cuối: 22/10/2026.

---

## 0. Triển khai / vận hành

| # | Hạng mục | Ghi chú | Ưu tiên |
|---|---|---|---|
| 0.2 | Merge `feat/otp-notification` vào `main` **sau khi** app mới đã cài trên các máy Android | `main` tự deploy lên Render. BE mới gửi `NEW_MESSAGE` data-only cho Android → app cũ không hiện thông báo khi chạy nền | P0 |

---

## 1. Vòng đời thiết bị sau uninstall — job dọn định kỳ (tuỳ chọn)

- Token chết đã tự xoá khi FCM báo `registration-token-not-registered` / `invalid-registration-token` (`FcmService` → `deviceService.clearFcmToken`, so-khớp-rồi-xoá trong transaction: token mới upload sau đó được giữ).
- Còn lại: job dọn định kỳ device không `last_seen_at` quá N ngày + không còn token → review membership/envelope cleanup (chỉ dọn token, không tự revoke membership — quyết định nghiệp vụ).
- Lưu ý từ backup/khôi phục (mobile 1.1): máy khôi phục dùng lại `device_id` + `device_token` cũ và gửi FCM token mới — **không** được coi đó là thiết bị mới.

---

## 2. API mới

| # | Hạng mục | Chi tiết | Ưu tiên |
|---|---|---|---|
| 2.3 | Lịch sử request đã xử lý cho Owner | `GET /channels/requests?status=` đã có — kiểm tra phân trang + giới hạn số bản ghi trước khi mobile dùng (mobile 1.6). | P3 |

---

## 3. Quan sát / log

| # | Hạng mục | Chi tiết |
|---|---|---|
| 3.1 | Log đếm bell cho JOIN_REQUEST / APPROVED / REVOKED | `NEW_MESSAGE` đã có log `members/sent/failed/no_token`; các bell còn lại gửi 1 thiết bị, vẫn chỉ `warn` khi lỗi. |

---

## 4. Hạng mục đã hoàn thành (tham khảo — đừng làm lại)

- **Nhánh `feat/backlog-sweep`** (xem `REVIEW_BACKLOG.md` để kiểm thử):
  - CI pull request `.github/workflows/ci.yml` (tsc, lint, Jest, build) — cũ: mục 3.2.
  - Clean-cut v4: gỡ `pairing_token` / `invite_url` khỏi `POST /channels/sessions`, gỡ `POST /channels/sessions/resolve`, claim chỉ bằng `code`; cập nhật API spec + SRD — cũ: mục 0.3. **Deploy sau khi `app_update_min_build` ≥ 20.**
  - Đổi tên kênh `PUT /api/v2/channels/name` (Owner, 1–100 ký tự, display-only, không FCM) + spec §4.8 — cũ: mục 2.1.
  - Vòng đời kênh: `POST /channels/leave` (REVOKED + `rotation_pending`, bell MEMBER_LEFT), `POST /channels/rotate` (Owner re-key), `POST /channels/archive` (terminal, huỷ invite/request, ẩn tin, bell REVOKED/ARCHIVED); chặn tạo QR trên kênh đã giải tán; spec §4.9–4.11 — cũ: mục 2.2.
- **22/10/2026**: `ANDROID_CERT_SHA256` đã đặt trên Render (SHA release + debug máy build); `assetlinks.json` production đúng, máy test báo App Links `verified` (cũ: mục 0.1). Đổi keystore/máy build → chạy lại `scripts/print_android_sha256.sh` của repo mobile và cập nhật biến.
- **22/10/2026**: tự xoá FCM token chết (cũ: bước 1 mục 1); log đếm bell `NEW_MESSAGE` (một phần mục 3.1).
- **22/10/2026** (nhánh `feat/otp-notification`): filter `fcm_token` trong `notifyNewMessage` dùng truthy check (token rỗng `''` không còn lọt qua).
- **Nhánh `feat/otp-notification`** (chưa merge, xem 0.2): `NEW_MESSAGE` data-only cho Android kèm `sequence_number` + `sender_device_id`; `GET /api/v2/channels/message` (§6.4).
- **21/10/2026** (đã lên `main`):
  - Universal Opaque QR v3.3: con trỏ `qr_codes/{sha256(code)}`, `GET /api/v2/qr/resolve`, claim bằng `code`, `/qr/:code` fallback, `/.well-known/assetlinks.json` + AASA (từ env).
  - Xoay khoá idempotent: biên nhận `last_rotation` (hash package) → gửi lại y hệt trả `200 replayed: true`; 409 kèm `current_epoch` / `membership_version`; `ChannelMembershipService` là nơi duy nhất ghi epoch/envelope.
- **19/10/2026**: whitelist theo từng kênh `PUT /api/v2/channels/whitelist` (optimistic version).
- Kiến trúc V2 channel 1-to-N E2EE đầy đủ (sessions, claim/approve/reject/cancel, revoke + rotate, key envelopes, messages by date) — spec: `SERVER_API_SPEC.md`, `SRD_DATABASE.md`.
- Xoá toàn bộ stack V1 + refactor health endpoint; README sang kiến trúc V2.
- FCM chuông V2 cho đủ 4 kind (NEW_MESSAGE / JOIN_REQUEST / APPROVED / REVOKED).
- Anti-replay T5 dùng chung `checkAndRecordHash` (`sha256(channel_id|nonce|ciphertext)`).
