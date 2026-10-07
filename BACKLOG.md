# BACKLOG — các hạng mục chưa làm (Backend / Express + Firestore)

> Tài liệu gom toàn bộ nợ kỹ thuật + roadmap chưa triển khai của phía server.
> Mục đã hoàn thành bị loại khỏi danh sách; hoàn thành mục nào thì xoá mục đó.
> Cập nhật lần cuối: 07/10/2026.

---

## 1. QR opaque resolve endpoint (Bước 3 lộ trình Universal QR — phối hợp mobile)

Mobile đang giữ hợp đồng thiết kế đầy đủ trong `../sms_navigator/BACKLOG.md` mục 1. Phần BE cần làm:

- **Endpoint**: `GET /qr/v1/{key}` (yêu cầu device auth) → `{type, version, payload}`.
  - Error semantics: `404` không tồn tại/đã xoá · `410` hết hạn · `409` đã consume · `403` không đủ quyền resolve type.
- **Key store**: mỗi key quản lý `type, payload, created_at, expires_at, consumed_by, consumed_at, max_uses`.
  - Hiện trạng thiếu: **consumed flag chuẩn + max_uses** (chỉ có 409 PAIR_ALREADY_CONFIRMED riêng cho pairing).
- **Endpoint sinh key** khi tạo pairing session (thay cho việc mobile tự nhúng payload vào QR).
- **Secret exchange sau resolve**: dọn shared secret khỏi QR — BE sinh session, secret trao đổi qua kênh đã xác thực sau khi resolve (server-mediated exchange). Mục tiêu: chụp màn hình QR không lộ secret.
- **Authorization theo type**: type nhạy cảm giới hạn role.
- **Versioning trong path**: `/qr/v1/...` cho phép `/v2/` song song sau này.
- **Blocker hạ tầng**: domain verify App Links (phải chốt domain + host `assetlinks.json`).

---

## 2. Vòng đời thiết bị sau uninstall — chưa có dọn dẹp

- **Vấn đề**: app bị xoá → server không biết; device record, channel membership, key envelopes, FCM token tồn tại vĩnh viễn trong Firestore. FCM bell gửi thất bại (`messaging/registration-token-not-registered`) hiện chỉ bị nuốt: `fcm.service.ts` `sendDataNotification` catch → `logger.warn` → return `''`.
- **Hướng xử lý**:
  1. Trong `sendDataNotification`, khi gặp `messaging/invalid-registration-token` / `messaging/registration-token-not-registered`: đánh dấu device `fcm_token = undefined` (hoặc flag `unregistered_at`) để các bell sau skip rẻ hơn.
  2. (Tuỳ chọn) Job dọn định kỳ: device không `last_seen_at` quá N ngày + token unregistered → review membership/envelope cleanup (cẩn trọng: chỉ dọn token, không tự revoke membership — quyết định nghiệp vụ).

---

## 3. Phát hiện review 07/10/2026 — chưa xử lý

| # | Hạng mục | Chi tiết |
|---|---|---|
| 3.1 | Filter `fcm_token` lọt chuỗi rỗng | `message.v2.service.ts` `notifyNewMessage`: `device?.fcm_token !== undefined` → token `''` vẫn pass rồi fail im lặng. Sửa thành truthy check `!!device?.fcm_token` (áp cùng pattern cho mọi nơi bắn bell: pairing.v2.controller, channel.v2.controller) |
| 3.2 | Log đếm bell | Các điểm bắn bell fail im lặng (chỉ warn rời rạc). Cân nhắc log có cấu trúc: số bell gửi thành công / số device thiếu token / số lỗi — để debug "không thấy FCM" nhanh hơn |
| 3.3 | Endpoint `/.well-known/assetlinks.json` cho Deeplink App Links | Phục vụ file JSON xác thực SHA-256 fingerprint ứng dụng Android để hệ điều hành mở trực tiếp app không qua popup hỏi trình duyệt |
| 3.4 | Schema & API Whitelist theo từng Channel | Mở rộng doc `channels`: thêm trường `sender_whitelist` (mảng string hoặc regex rule). Bổ sung endpoint `PUT /api/v2/channels/whitelist` để Owner đồng bộ cấu hình whitelist lên server và khôi phục khi đổi máy |

---

## 4. Hạng mục đã hoàn thành (tham khảo — đừng làm lại)

- Kiến trúc V2 channel 1-to-N E2EE đầy đủ (sessions, claim/approve/reject/cancel, revoke + rotate, key envelopes, messages by date) — spec: `SERVER_API_SPEC.md`, `SRD_DATABASE.md` (cùng repo này).
- Xoá toàn bộ stack V1 (pair/relay routes, controllers, session.service, schemas, types, tests) + refactor health endpoint.
- Cập nhật tài liệu `README.md` sang kiến trúc V2 channel (đặc tả endpoints V2, xóa bỏ mô tả V1 cũ).
- FCM chuông V2: notification block + channel_name cho đủ 4 kind (NEW_MESSAGE / JOIN_REQUEST / APPROVED / REVOKED); sender cũng nhận bell NEW_MESSAGE (đúng spec §7).
- Anti-replay T5 dùng chung `checkAndRecordHash` (bind hash `sha256(channel_id|nonce|ciphertext)`).
