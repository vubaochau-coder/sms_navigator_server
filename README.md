# SMS Navigator Backend Server (V2 Channel E2EE)

Backend trung gian chuyển tiếp OTP và quản lý kênh mã hóa đầu-cuối (Channel 1-to-N E2EE Relay Server), sử dụng **Node.js, TypeScript, Express, và Firebase Admin SDK / Cloud Firestore**.

---

## 1. Tính Năng & Kiến Trúc V2

- **Channel 1-to-N E2EE:** Thiết bị cắm SIM là Owner quản lý kênh, mã hóa nội dung OTP 1 lần bằng Channel Key tại mỗi epoch (`current_epoch`).
- **Key Envelope & Forward Secrecy:** Khóa kênh được bọc mã hóa (envelope ECDH + AES-256-GCM) riêng cho từng thành viên hợp lệ. Khi có thành viên mới gia nhập hoặc bị thu hồi quyền (`REVOKED`), epoch tự động xoay vòng.
- **FCM High-Priority Notification & Data:** Tích hợp cả notification block (`title`, `body`) và data payload cho 4 sự kiện chính (`NEW_MESSAGE`, `JOIN_REQUEST`, `APPROVED`, `REVOKED`) kèm `channel_name`.
- **Anti-Replay Protection (T5):** Chống tấn công phát lại tin nhắn bằng bảng băm `sha256(channel_id|nonce|ciphertext)` lưu trữ TTL 24 giờ.
- **Tài liệu đặc tả chi tiết:**
  - `SERVER_API_SPEC.md`: Đặc tả hợp đồng API v2 đầy đủ.
  - `SRD_DATABASE.md`: Đặc tả cấu trúc collections & quy tắc Firestore.

---

## 2. Bắt Đầu Nhanh (Local Development)

### Bước 1: Cài đặt Dependencies
```bash
npm install
```

### Bước 2: Cấu hình Môi trường
Tạo file `.env` từ `.env.example`:
```bash
cp .env.example .env
```
Mặc định `FIREBASE_MOCK_MODE=true` cho phép bạn test đầy đủ mọi API mà chưa cần cấu hình Service Account Firebase ngay lập tức.

Khi sẵn sàng kết nối Firebase thật:
1. Vào Firebase Console ➔ Project Settings ➔ Service accounts.
2. Bấm **Generate new private key** tải file `.json`.
3. Lưu file thành `service-account.json` trong thư mục server hoặc set đường dẫn vào biến `FIREBASE_SERVICE_ACCOUNT_PATH`.
4. Đổi `FIREBASE_MOCK_MODE=false`.

### Bước 3: Khởi động Server
```bash
# Chế độ phát triển (Auto-reload với tsx):
npm run dev

# Chạy kiểm thử tự động (Jest + Supertest):
npm test

# Build production:
npm run build
npm start
```

---

## 3. Danh Sách API Endpoints V2

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/health` | Kiểm tra tình trạng server & kết nối Firebase |
| `POST` | `/api/v2/devices/register` | Đăng ký thiết bị kèm Identity Public Key (X25519) |
| `PUT` | `/api/v2/devices/name` | Cập nhật tên thiết bị và fan-out sang các kênh |
| `GET` | `/api/v2/devices/me` | Lấy thông tin thiết bị của token hiện tại |
| `PUT` | `/api/v2/devices/fcm-token` | Cập nhật FCM token nhận chuông |
| `POST` | `/api/v2/channels` | Tạo kênh mới (caller trở thành Owner) |
| `GET` | `/api/v2/channels` | Danh sách kênh caller tham gia (gồm Kênh của bạn & Kênh tham gia) |
| `GET` | `/api/v2/channels/detail` | Chi tiết kênh theo `channel_id` |
| `POST` | `/api/v2/channels/sessions` | Tạo phiên ghép đôi QR (TTL 10 phút) |
| `POST` | `/api/v2/channels/requests` | Member gửi yêu cầu tham gia kênh |
| `POST` | `/api/v2/pairing/requests/approve` | Owner duyệt member (rotate epoch + cấp key envelopes) |
| `POST` | `/api/v2/pairing/requests/reject` | Owner từ chối yêu cầu |
| `POST` | `/api/v2/pairing/requests/cancel` | Member hủy yêu cầu đang chờ |
| `POST` | `/api/v2/channels/revoke` | Owner thu hồi quyền member (rotate epoch) |
| `GET` | `/api/v2/channels/key-envelope` | Member lấy phong bì khóa cho epoch chỉ định |
| `POST` | `/api/v2/channels/messages` | Owner gửi tin nhắn SMS đã mã hóa lên kênh |
| `GET` | `/api/v2/messages` | Member đọc tin nhắn của tất cả kênh theo ngày (`?date=YYYY-MM-DD`) |

---

## 4. Kiểm Thử Nhanh Bằng cURL
Khởi động server trên port 3000 và chạy script kiểm thử tự động:
```bash
./test-curl.sh
```

---

## 5. Chạy Với Docker

```bash
# Build image
docker build -t sms-navigator-server:latest .

# Run container
docker run -d -p 3000:3000 --env-file .env --name sms-relay sms-navigator-server:latest
```
