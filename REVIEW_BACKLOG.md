# REVIEW BACKLOG — kiểm thử & rà soát nhánh `feat/backlog-sweep` (Backend)

> Mỗi mục ứng với **một commit** trên nhánh (theo thứ tự ưu tiên P1 → P3).
> Tick khi đã rà soát code **và** test (Jest + gọi thử trên môi trường staging nếu có).
> ⚠️ `main` tự deploy lên Render — chỉ merge theo thứ tự ghi ở từng mục.
> Nhánh tách từ `feat/otp-notification` (PR #1, đang draft) — merge PR #1 trước.
> Mobile tương ứng: `sms_navigator` nhánh `feat/backlog-sweep` (file `REVIEW_BACKLOG.md` cùng tên).

---

## P1-1 · CI cho pull request (BACKLOG 3.2)

**Rà soát**
- [ ] `.github/workflows/ci.yml`: `npm ci` → `tsc --noEmit` → `lint` → `test` → `build`, Node 22 (cùng Dockerfile).

**Kiểm thử**
- [ ] Mở PR của nhánh này → job xanh.
- [ ] (Khuyên) bảo vệ `main`, bắt buộc check `Typecheck, lint & test` — vì merge = deploy.

## P1-2 · Clean-cut v4 — gỡ `pairing_token`, `invite_url`, `/channels/sessions/resolve`, claim bằng token (BACKLOG 0.3)

⚠️ **Thứ tự deploy**: chỉ merge/deploy SAU KHI Remote Config `app_update_min_build` ≥ **20** (1.1.0) và mọi máy đã lên 1.1.0. App 1.0.x cũ quét QR v4 sẽ bị lỗi.

**Rà soát**
- [ ] `POST /channels/sessions` chỉ trả `session_id, expires_at, code, qr_url`; không còn sinh/lưu `pairing_token_hash`.
- [ ] `POST /pairing/requests` bắt buộc `code` (schema) — body v4 `{session_id, pairing_token}` → `400`.
- [ ] Route `POST /channels/sessions/resolve` đã xoá (→ `404`); preview chỉ còn `GET /qr/resolve`.
- [ ] Session v4 còn sót trong Firestore (TTL 10') không còn đường claim nào — chấp nhận, hết hạn tự nhiên.
- [ ] App 1.1.0 parse response mới an toàn: `PairingSessionModel` đọc `pairing_token`/`invite_url` với default `''`, QR dùng `qr_url` (đã kiểm tra trong code).
- [ ] `SERVER_API_SPEC.md` §4.5/4.6/5.1 và `SRD_DATABASE.md` §3.4, OQ-4 đã cập nhật.

**Kiểm thử**
- [ ] Jest: `qr.test.ts` — "v4 is gone" (token claim 400, resolve 404); `api-v2.test.ts` claim bằng `code`.
- [ ] Trên máy 1.1.0: Owner tạo QR → Member quét/bấm link → duyệt → nhận tin (end-to-end).
- [ ] Gọi tay `POST /api/v2/channels/sessions/resolve` → 404.

## P2-1 · Đổi tên kênh `PUT /api/v2/channels/name` (BACKLOG 2.1)

**Rà soát**
- [ ] Owner-only (`403 NOT_OWNER`), kênh `ARCHIVED` → `409 CHANNEL_NOT_ACTIVE`, update trong transaction.
- [ ] ⚠️ Giới hạn tên **1–100** (giống `POST /channels`), backlog cũ ghi 50 — chọn 100 để kênh đã tạo tên dài vẫn đổi được. App dialog cũng 100.
- [ ] Không bắn FCM: app 1.1.0 hiện FCM data-only `kind` lạ thành thông báo chung → tránh spam. Member thấy tên mới khi refresh.
- [ ] `tests/helpers/v2-client.ts` — helper dùng chung cho các test file mới (không đụng `api-v2.test.ts`).

**Kiểm thử**
- [ ] Jest `channel-rename.test.ts`.
- [ ] Gọi thật: đổi tên → `GET /channels` của member thấy tên mới; SMS relay tiếp theo trên máy Owner hiện tên mới trong log.

## P2-2 · Vòng đời kênh: rời / đổi key / giải tán (BACKLOG 2.2)

**Thiết kế — cần đồng ý trước khi merge** ⚠️
- Backlog cũ đề xuất "leave = Owner tự rotate khi gặp 409 EPOCH_OUTDATED": **không khả thi** — nếu server tự tăng epoch, Owner không có envelope epoch mới → SMS bị park mãi. Thay bằng: leave chỉ REVOKED + `rotation_pending`, epoch giữ nguyên; Owner app tự gọi `POST /channels/rotate` (mới). Người rời bị chặn đọc ngay bởi KL12 (membership), rotate là lớp bảo vệ thứ hai.
- Giải tán = **terminal** (không có un-archive); tin nhắn kênh đã giải tán không còn được trả cho ai (kể cả Owner). Dữ liệu vẫn nằm tới TTL 30 ngày.
- Bell giải tán dùng `kind: REVOKED` để app cũ (1.1.0) cũng purge key; `reason: ARCHIVED` để app mới hiện đúng ngữ cảnh.

**Rà soát**
- [ ] `leaveChannel`, `rotateChannel`, `archiveChannel` trong `channel.service.ts` — đọc trước ghi trong transaction.
- [ ] `commitRotation` luôn set `rotation_pending: false`; `RotationKind` thêm `ROTATE` (receipt/replay).
- [ ] `createSession` trên kênh ARCHIVED → 409 (trước đây vẫn tạo được QR!).
- [ ] `fetchMessagesByDate` / `fetchMessage` bỏ kênh ARCHIVED.
- [ ] `GET /channels/detail` trả thêm `rotation_pending`.
- [ ] Spec §4.9–4.11.

**Kiểm thử**
- [ ] Jest `channel-lifecycle.test.ts` (7 case).
- [ ] E2E với app (mobile P2-2): member rời → Owner nhận bell → mở app → tự rotate (epoch +1) → SMS tiếp theo vẫn tới các member còn lại.
- [ ] Owner giải tán → member (cả bản 1.1.0) nhận thông báo, kênh biến mất.

## P2-3 · Lịch sử request đã xử lý — `GET /channels/requests?status=HISTORY` (BACKLOG 2.3)

**Rà soát**
- [ ] `status=HISTORY` = `in [APPROVED, REJECTED, CANCELLED]`, sắp theo `decided_at` (fallback `terminal_at`/`created_at`), `limit` 1–100 (mặc định 50) + cursor `before`/`next_before`.
- [ ] Mỗi item thêm `status` (+ `decided_at` nếu có) — field mới, client cũ bỏ qua được.
- [ ] ⚠️ Lọc/sắp/cắt trang làm **trong bộ nhớ** sau 1 query `channel_id + status in` (index sẵn có); đủ cho quy mô kênh gia đình. Khi một kênh có hàng nghìn request → chuyển sang `orderBy(decided_at).limit()` + composite index.
- [ ] Hàng đợi PENDING giờ cũng bị cắt ở 50 (trước đây không giới hạn).

**Kiểm thử**
- [ ] Jest `channel-requests-history.test.ts`.

