# BACKLOG — các hạng mục chưa làm (Backend / Express + Firestore)

> Tài liệu gom toàn bộ nợ kỹ thuật + roadmap chưa triển khai của phía server.
> Mục đã hoàn thành bị loại khỏi danh sách; hoàn thành mục nào thì xoá mục đó.
> Cập nhật lần cuối: 22/10/2026.

---

## 1. QR opaque — phần còn lại sau v3.3

Đã có (nhánh `feat/opaque-qr`): pointer `qr_codes/{sha256(code)}` (không lưu code thô), `GET /api/v2/qr/resolve?code=`, claim bằng `code`, lỗi `409 QR_ALREADY_USED` / `410 QR_EXPIRED`, trang fallback `/qr/:code`, `assetlinks.json` + `apple-app-site-association`. QR chỉ chứa code ngẫu nhiên → chụp màn hình không lộ secret. Còn lại:

- **Thêm type ngoài `PAIRING`** (vd. `BACKUP` chuyển máy — xem mobile BACKLOG 1.1): hiện `SUPPORTED_QR_TYPES = ['PAIRING']`.
- **Consumed flag / `max_uses` chung** trên pointer khi có type thứ hai (hiện one-shot dựa vào trạng thái pairing session).
- **Authorization theo type**: type nhạy cảm giới hạn role.
- **Cấu hình production**: `ANDROID_CERT_SHA256` đang rỗng (`assetlinks.json` = `[]`), `IOS_APP_IDS` rỗng — xem mobile BACKLOG 0.2 / 0.4.

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
| 3.5 | API Đổi tên Kênh (`PUT /api/v2/channels/:channel_id/name`) | • Endpoint cho phép Owner đổi tên hiển thị của kênh.<br>• Guard: `403 NOT_OWNER` nếu caller không phải Owner.<br>• Schema: `z.object({ name: z.string().trim().min(1).max(50) })`.<br>• Cập nhật `channels/{channelId}.name` trong Firestore (display-only metadata, không cần rotate epoch).<br>• (Tuỳ chọn) Bắn FCM thông báo cho các active member để đồng bộ tên kênh mới. |

---

## 4. Hạng mục đã hoàn thành (tham khảo — đừng làm lại)

- Kiến trúc V2 channel 1-to-N E2EE đầy đủ (sessions, claim/approve/reject/cancel, revoke + rotate, key envelopes, messages by date) — spec: `SERVER_API_SPEC.md`, `SRD_DATABASE.md` (cùng repo này).
- Xoá toàn bộ stack V1 (pair/relay routes, controllers, session.service, schemas, types, tests) + refactor health endpoint.
- Cập nhật tài liệu `README.md` sang kiến trúc V2 channel (đặc tả endpoints V2, xóa bỏ mô tả V1 cũ).
- FCM chuông V2: notification block + channel_name cho đủ 4 kind (NEW_MESSAGE / JOIN_REQUEST / APPROVED / REVOKED); sender cũng nhận bell NEW_MESSAGE (đúng spec §7).
- `/.well-known/assetlinks.json` + `apple-app-site-association` (cũ: mục 3.3) và whitelist E2EE theo kênh `PUT /api/v2/channels/whitelist` với optimistic version (cũ: mục 3.4).
- Anti-replay T5 dùng chung `checkAndRecordHash` (bind hash `sha256(channel_id|nonce|ciphertext)`).
