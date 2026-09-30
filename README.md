# SMS Navigator OTP Relay Server

Backend trung gian chuyển tiếp OTP siêu nhẹ (Zero-Knowledge Relay Server), sử dụng **Node.js, TypeScript, Express, và Firebase Admin SDK**.

---

## 1. Tính Năng & Kiến Trúc

- **Zero-Knowledge:** Server chỉ định tuyến `encrypted_payload` và `iv` từ Máy Gửi (Việt Nam) sang Máy Nhận (Malaysia). Không giải mã, không lưu trữ nội dung tin nhắn OTP.
- **FCM High-Priority Data Messages:** Đánh thức Máy B tức thì qua background handler, vượt qua chế độ tiết kiệm pin / Doze Mode của Android.
- **Session Management với TTL:** Mapping `pair_id` ➔ `fcm_token` tự động quản lý thời hạn sống và dọn dẹp các session hết hạn.
- **Chống Spam & Tấn Công:** Tích hợp `helmet`, CORS, rate limiting (`express-rate-limit`) và Zod validation.

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

## 3. Danh Sách API Endpoints

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | Kiểm tra tình trạng server & kết nối Firebase |
| `POST` | `/api/v1/pair/confirm` | Máy B xác nhận ghép đôi & đăng ký FCM token |
| `GET` | `/api/v1/pair/status/:pairId` | Kiểm tra trạng thái liên kết của pairId |
| `DELETE` | `/api/v1/pair/:pairId` | Hủy phiên ghép đôi (Unpair) |
| `POST` | `/api/v1/relay` | Tiếp nhận encrypted OTP từ Máy A và bắn FCM sang Máy B (`sent_at` nhận ISO 8601, epoch giây hoặc mili-giây) |
| `GET` | `/api/v1/relay/pending/:pairId` | Receiver poll các payload đang chờ (tự clear sau khi fetch) |
| `GET` | `/api/v1/relay/history` | Lịch sử relay theo dải thời gian ISO 8601 (`?from=...&to=...`) hoặc theo ngày + múi giờ (`?date=YYYY-MM-DD&tz=+07:00`) |

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
