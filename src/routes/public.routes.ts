import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { QR_CODE_PATTERN } from '../services/qr-code.service.js';

/**
 * Public (unauthenticated) routes backing HTTPS invite links
 * (roadmap v3.3 §2.3.D): App Links / Universal Links association files and
 * the fallback page shown when the app is not installed.
 *
 * NOTE: if traffic goes through the Cloudflare Worker proxy, it must forward
 * `/.well-known/*` and `/qr/*` unchanged (no redirect — iOS/Android reject
 * association files served via redirect).
 */
const router = Router();

const publicPageRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test'
});

const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

router.get('/.well-known/assetlinks.json', (_req: Request, res: Response) => {
  const fingerprints = splitList(env.ANDROID_CERT_SHA256);
  const body =
    fingerprints.length === 0
      ? []
      : [
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
              namespace: 'android_app',
              package_name: env.ANDROID_APP_PACKAGE,
              sha256_cert_fingerprints: fingerprints
            }
          }
        ];
  res.type('application/json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify(body));
});

router.get('/.well-known/apple-app-site-association', (_req: Request, res: Response) => {
  const appIds = splitList(env.IOS_APP_IDS);
  const body = {
    applinks: {
      details: appIds.length === 0 ? [] : [{ appIDs: appIds, components: [{ '/': '/qr/*' }] }]
    }
  };
  res.type('application/json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify(body));
});

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Fallback for `https://<host>/qr/<code>` when the OS did not hand the link to
 * the app. Static HTML, no script. The code is echoed only after it matched
 * the strict base64url pattern, and only inside the custom-scheme href.
 */
router.get('/qr/:code', publicPageRateLimiter, (req: Request, res: Response) => {
  const code = String(req.params.code ?? '');
  const valid = QR_CODE_PATTERN.test(code);
  const download = env.APP_DOWNLOAD_URL.trim();
  const safeDownload = /^https:\/\//i.test(download) ? escapeHtml(download) : '';

  const action = valid
    ? `<a class="btn" href="smsnavigator://qr?code=${code}">Mở bằng SMS Navigator</a>`
    : `<p class="err">Mã mời không hợp lệ.</p>`;
  const getApp = safeDownload
    ? `<a class="link" href="${safeDownload}">Chưa có ứng dụng? Tải SMS Navigator</a>`
    : `<p class="hint">Chưa có ứng dụng? Hãy cài SMS Navigator rồi quét lại mã.</p>`;

  const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Lời mời tham gia kênh · SMS Navigator</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  main { max-width: 360px; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: .8; line-height: 1.5; }
  .btn { display: block; padding: 14px 20px; border-radius: 12px; background: #2563eb; color: #fff;
         text-decoration: none; font-weight: 600; margin-bottom: 16px; }
  .link { color: #2563eb; }
  .err { color: #dc2626; opacity: 1; }
</style>
</head>
<body>
<main>
  <h1>Bạn được mời tham gia một kênh</h1>
  <p>Mã mời có hiệu lực 10 phút và chỉ dùng được một lần.</p>
  ${action}
  ${getApp}
</main>
</body>
</html>`;

  res
    .status(valid ? 200 : 400)
    .type('html')
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .send(html);
});

export const publicRoutes = router;
