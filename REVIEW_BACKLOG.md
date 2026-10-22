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

