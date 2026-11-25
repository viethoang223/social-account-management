# SeedingSys

**Bản 1.0 · [Kết nối dàn UID qua extension Chrome](docs/EXTENSION-1.0.md).**

Hệ thống điều phối A → B theo đặc tả *SeedingSys Pilot A1–A5 → B1–B5 v1.0*: thu thập nguồn mỗi 5 phút, biên tập bằng LLM, cấp tối đa 1 lượt đăng mỗi giờ cho mỗi tài khoản đích, xác minh và đối soát kết quả. Thiết kế để lên 50 nguồn/đích bằng cách thêm cấu hình và worker, không đổi schema.

## Trạng thái triển khai

| Giai đoạn (build plan) | Trạng thái |
|---|---|
| 1. Nền tảng: monorepo, schema + constraint, state machine, queue/outbox, account lease + fencing, observability, CI | ✅ Xong |
| 2. Thu thập + biên tập: poll 5′ (singleton/source, watermark, baseline, revision), asset.fetch → R2/local + checksum, LLM gateway (Claude API, ngân sách, cache), validate | ✅ Xong (với FakeConnector) |
| 3. Lịch đăng + publish standard: slot mỗi giờ, FIFO, strict_order, DEFERRED/MISSED/SKIPPED, kill switch, COMMITTING boundary, verify, reconcile | ✅ Xong (với FakeConnector) |
| 4. Album/video: manifest, trạng thái UPLOADING_DRAFT → … → PLATFORM_PROCESSING, khóa dùng chung | 🟡 Luồng trạng thái + manifest xong; **media.prepare (FFprobe/FFmpeg) chưa làm**; NAMED_ALBUM luôn NEEDS_REVIEW |
| 5. Web vận hành, extension MV3, takeover noVNC, agent.recover | 🟡 **API + web Next.js xong** (đăng nhập, tổng quan, duyệt bài, cần xử lý, bài đã đăng, lịch & backlog, công tắc dừng, báo cáo, cấu hình); extension, noVNC, agent **chưa làm** (agent.recover hiện chuyển thẳng cho người) |
| 6. Kiểm thử lỗi | ✅ 16 kịch bản tự động (tests/faults) |
| fb-web connector (Playwright, selector vi-VN) | 🟡 **Đã viết** (phiên, danh tính, soạn nháp, xem trước, đăng, xác minh, đối soát; capability test) và kiểm thử với Facebook giả. **Selector chưa kiểm chứng trên Facebook thật**, mặc định không định dạng nào được đăng — xem [docs/FB-WEB.md](docs/FB-WEB.md). Không có NAMED_ALBUM/REEL |
| Nguồn (A) | Nguồn `fb-public` tự quét bài Facebook xem được ở chế độ khách. Nguồn `manual` dùng trang **Nhập bài** |
| 7. Soak 7 ngày, load test 50/50 | ⛔ Chưa làm |

Milestone **M1** (e2e trên FakeConnector: poll → READY → slot → PUBLISHED_VERIFIED; giết worker giữa chừng không tạo trùng) đã đạt — xem `tests/`.

## Chạy local (không cần Docker)

```powershell
corepack pnpm@9.15.9 install
copy .env.example .env
pnpm db:local          # terminal 1: PostgreSQL nhúng ở 127.0.0.1:54329 (dữ liệu trong .data/pg)
pnpm db:generate
pnpm db:migrate
pnpm db:seed           # A1–A5 → B1–B5 dùng FakeConnector
pnpm dev:all           # api + worker-core + worker-browser + worker-media + web (http://localhost:3000)
```

Mở **http://localhost:3000** và đăng nhập bằng một mã trong `API_TOKENS` (`.env`; mặc định `dev-admin-token`). Triển khai thật: xem [docs/DEPLOY.md](docs/DEPLOY.md).

Thêm bài giả lập và xem kết quả:

```powershell
pnpm fake post A1 "Ưu đãi giảm 30% đến hết 25/11"
pnpm fake post A2 "Album sự kiện" --photos 3
pnpm fake timeline fb-B1
pnpm fake session fb-B1 CHECKPOINT
```

Với Facebook thật (sau khi đọc [docs/FB-WEB.md](docs/FB-WEB.md)): `pnpm fb:login B1` (tự đăng nhập), `pnpm fb:capability B1 --yes` (kiểm thử ở “Chỉ mình tôi”).

Để quét nguồn A1 bằng URL, vào **Quản trị luồng đăng → A1 → B1**, chọn **Facebook công khai**, dán link tại **Nguồn A1** và lưu. Worker tự quét theo chu kỳ. Nút **Quét ngay** gửi một lượt quét cho worker. Nội dung và thông tin bài nằm trong PostgreSQL. Các tệp ảnh và video tải được lưu vào bucket khi dùng `STORAGE_DRIVER=r2`.

Nguồn Facebook công khai đưa các bài tìm được vào luồng xử lý ngay từ lượt quét đầu. Nguồn có chế độ mốc lưu bài cũ ở lần đồng bộ đầu. Bài sẵn sàng được chọn theo lịch đầu giờ hoặc qua nút **Đăng ngay** ở Backlog.

API (Bearer token theo `API_TOKENS`): `GET /health`, `GET /api/dashboard`, `GET /api/review`, `POST /api/review/:id/approve|reject|rewrite`, `GET /api/publications`, `POST /api/publications/:id/confirm|confirm-absent`, `GET /api/operator-tasks`, `POST /api/operator-tasks/:id/claim|resolve`, `GET|PUT /api/controls`, `GET /api/reports/summary`, CRUD `sources|targets|mappings`.

Dùng Claude thật: đặt `LLM_MODE=claude` và `ANTHROPIC_API_KEY` (mặc định model `claude-opus-5-5`, effort `medium`, structured outputs, refusal fallback phía server).

## Kiểm thử

```powershell
pnpm typecheck
pnpm test        # unit + e2e + fault injection, tự dựng PostgreSQL nhúng
```

## Cấu trúc

```
apps/
  api/             NestJS — vận hành: duyệt, xác nhận, kill switch, dashboard, cấu hình
  web/             Next.js — bảng vận hành tiếng Việt (proxy an toàn tới api, token trong cookie httpOnly)
  worker-core/     scheduler (poll 5′, slot mỗi giờ), outbox relay, LLM rewrite/validate, lease-sweeper
  worker-browser/  source.poll, publish.{standard,album,video}, publish.verify/reconcile, agent.recover
  worker-media/    asset.fetch (→ R2/local, checksum)
packages/
  db/              Prisma schema + migration SQL, transition guards, lease/fencing, outbox, ingest, snapshot
  contracts/       state machine tables, job schemas (Zod), content types
  domain/          logic thuần: thời gian/cửa sổ, hash, caption checks
  queue/           pg-boss + relay
  llm/             gateway (budget, cache, concurrency), ClaudeEditor, FakeEditor, prompts có version
  storage/         LocalStore / R2Store, object key theo checksum
  connectors/      core (interface), fake (nền tảng giả lập + fault injection), fb-web (Playwright, đăng + xác minh), manual (nhập bài)
infra/             Dockerfile (+ .web), compose core/worker, Caddy (HTTPS)
docs/DEPLOY.md     hướng dẫn triển khai máy chủ
tests/             e2e, faults, harness (Postgres nhúng + đồng hồ giả lập)
```

## Bất biến quan trọng (đã có test)

- Một tài khoản chỉ có một tiến trình thao tác: account lease + fencing token, dùng chung mọi workflow; thêm unique index "1 publication active / target" ở DB.
- `COMMITTING` được ghi (có kiểm tra fencing và thời gian lease còn lại) **trước** khi bấm đăng. Từ đó mọi lỗi/timeout/mất lease → `UNKNOWN` → `publish.reconcile`; không bao giờ tự đăng lại.
- `UNKNOWN` không bao giờ được tính là thành công. "Không thấy bài" chỉ kết luận được sau `reconcileMinAgeMs` (10′).
- Checkpoint / đăng xuất / sai identity / sai audience → dừng trước commit, tự dừng tài khoản, mở task cho người. Hệ thống không có cơ chế né kiểm tra.
- Snapshot caption + manifest media đóng băng khi READY và được kiểm tra hash + checksum ngay trước khi đăng.
- Lỡ nhiều giờ không dồn bài; slot quá cửa sổ 15′ là MISSED; slot đã quá cửa sổ khi hệ thống khởi động thì không được tạo.
- Chống trùng hai lớp: một bài nguồn chỉ được lưu một lần dù Facebook đổi `pfbid` (bí danh trong `source_post_aliases`, so mã ảnh/video hoặc caption + thời điểm); một nội dung (caption + checksum media, khóa `content_key`) chỉ đến mỗi tài khoản đích một lần — bản sao từ bài/nguồn khác thành `DUPLICATE` (“Trùng bài”), và bước chọn bài trước khi đăng loại mọi nội dung đích đã đăng. Nhập tay cùng caption + tệp vào cùng nguồn bị từ chối.

## Khác biệt so với kế hoạch (cố ý)

- `account_leases` dùng khóa `resource` chung (`account:<id>`, `source:<id>`) để dùng cùng một cơ chế fencing cho singleton poll.
- Dừng trước commit do lỗi tài khoản (checkpoint, identity…) đặt publication `CANCELLED` (nội dung về lại backlog) thay vì `NEEDS_OPERATOR`; `NEEDS_OPERATOR` dành cho kết quả chưa rõ sau commit.
- Verify chạy ngay trong job publish (cùng phiên); `publish.verify` dùng chung handler với reconcile.
- `scheduler.tick` (cron pg-boss mỗi phút, singleton) gom poll-dispatch, slot, sweeper — mọi bước idempotent.

## Việc tiếp theo

1. Giai đoạn 0 (vận hành): ma trận quyền đọc A1–A5, văn bản đồng ý chủ tài khoản B1–B5, cố định locale/audience.
2. Kiểm chứng selector `fb-web` trên giao diện thật + capability test ≥20 ca/định dạng ở chế độ "Chỉ mình tôi".
3. Extension MV3, takeover qua noVNC.
4. media.prepare (FFprobe/FFmpeg), agent.recover với 7 công cụ giới hạn.
5. Soak 7 ngày, load test 50/50.
#   s e e d i n g _ p r o j e c t  
 
