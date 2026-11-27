# Triển khai SeedingSys

> Connector đăng bài `fb-web` dùng các định dạng bật trong `FB_ENABLED_FORMATS`. Có thể chạy kiểm thử tùy chọn ở chế độ “Chỉ mình tôi”. Nguồn nội dung có thể dùng `fb-public` để đọc trang cá nhân hoặc fanpage truy cập được ở chế độ khách. [Hướng dẫn cấu hình Facebook](FB-WEB.md)

## 1. Chọn cách chạy

| Cách | Khi nào | Cần |
|---|---|---|
| **A. Chạy trên máy của bạn** (không Docker) | Thử, nghiệm thu, đào tạo người vận hành | Node 20.19+, corepack |
| **B. Máy chủ thật** (Docker Compose) | Vận hành thường trực | 1 máy core (~4 vCPU/8 GB), 1 máy worker (~8 vCPU/32 GB), tên miền, Cloudflare R2, tài khoản Claude API |

## 2. Cách A — chạy trên máy của bạn

```powershell
cd C:\Users\ha\seeding_project
corepack enable          # một lần; nếu PowerShell chặn pnpm.ps1: Set-ExecutionPolicy -Scope Process Bypass
pnpm install
pnpm db:local            # terminal 1: PostgreSQL local (giữ mở)
```

Terminal 2 (lần đầu):

```powershell
$env:DATABASE_URL="postgresql://seedingsys:seedingsys@127.0.0.1:54329/seedingsys"; pnpm db:generate; pnpm db:migrate; pnpm db:seed
pnpm dev:all             # api + 3 worker + web
```

Mở **http://localhost:3000**, đăng nhập bằng một trong các mã trong `API_TOKENS` của file `.env` (mặc định `dev-admin-token`, `dev-reviewer-token`, `dev-operator-token`).

**Trước khi cho người khác dùng, đổi mã trong `.env`:**

```powershell
node scripts/gen-secrets.mjs --print
```

Dán các mã vừa in vào `API_TOKENS='{"<mã admin>":"admin","<mã duyệt>":"reviewer","<mã vận hành>":"operator"}'`, rồi chạy lại `pnpm dev:all`.

Thêm bài thử bằng `pnpm fake post N1 "nội dung"`.

### 2.1 Chạy thường trực trên máy Windows này (không Docker)

`scripts/server.mjs` chạy Postgres local + api + 3 worker + web ở chế độ production. Tiến trình nào chết thì tự chạy lại (chờ 2 giây, tăng dần tới 60 giây). Log ghi theo ngày, giữ 14 ngày. Mỗi lần khởi động có một bản sao lưu DB. Máy có màn hình và IP mạng thường, nên `pnpm fb:login` và xử lý checkpoint vẫn làm tại chỗ như Cách A.

Cài một lần:

```powershell
pnpm build:web                                                                  # build lại sau mỗi lần sửa code
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1  # tác vụ "SeedingSys" chạy ẩn mỗi lần đăng nhập Windows
```

Dùng hằng ngày:

| Việc | Lệnh |
|---|---|
| Xem trạng thái | `pnpm server:status` |
| Dừng | `pnpm server:stop` |
| Chạy lại (ẩn) | `Start-ScheduledTask SeedingSys` |
| Chạy có cửa sổ để xem log trực tiếp | `pnpm server:start` (Ctrl+C để dừng) |
| Gỡ tự khởi động | `powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -Remove` |

Không chạy `pnpm dev:all`/`pnpm db:local` cùng lúc với bản thường trực: hai bộ worker sẽ tranh cùng profile trình duyệt.

- **Log:** `.data\logs\<dịch vụ>-YYYY-MM-DD.log` (`supervisor`, `api`, `worker-browser`, `web`, `postgres`, `migrate`...).
- **Sao lưu DB:** mỗi lần khởi động, trước khi bật Postgres, thư mục `.data\pg` được chép nguyên vào `.data\pg-snapshots\` (giữ 7 bản). Nên đặt `SNAPSHOT_DIR` trong `.env` về ổ khác hoặc thư mục đồng bộ cloud. Khôi phục: `pnpm server:stop`, đổi tên `.data\pg`, chép một bản `pg-...` thành `.data\pg`, rồi `Start-ScheduledTask SeedingSys`.
- **Cập nhật code:** `pnpm install` → `pnpm build:web` → `pnpm server:stop` → `Start-ScheduledTask SeedingSys` (migration tự chạy).
- **Mạng:** web nghe ở cổng 3000 trên mọi card mạng. API chỉ nghe `127.0.0.1` (`API_HOST`), không lộ ra LAN. Cookie đăng nhập cho phép HTTP thường (`WEB_INSECURE_COOKIE=1`); nếu đặt HTTPS phía trước (ví dụ `tailscale serve`) thì đặt `WEB_INSECURE_COOKIE=0`.
- Trên Windows, khi dừng hoặc chạy lại thì worker bị tắt ngay. Một lượt đăng đang dở có thể chuyển sang **Chờ đối chiếu**; xử lý như bình thường.

Việc cần quyền admin hoặc cài đặt Windows (tự làm một lần):

```powershell
powercfg /change standby-timeout-ac 0      # không cho máy ngủ khi cắm điện
powercfg /change hibernate-timeout-ac 0
```

- Cho máy khác trong LAN vào (PowerShell **Run as administrator**): `New-NetFirewallRule -DisplayName "SeedingSys web" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow`, rồi mở `http://<IP máy này>:3000`.
- Từ điện thoại hoặc máy ở mạng khác, dùng Tailscale Serve để mở dashboard qua HTTPS trong mạng riêng. Xem mục bên dưới.
- Settings → Windows Update → *Change active hours*: tránh để máy tự khởi động lại giữa giờ đăng. Sau khi khởi động lại, hệ thống chỉ chạy lên khi có người **đăng nhập** Windows.
- Đổi mã đăng nhập mặc định trước khi cho người khác dùng (xem trên), rồi `pnpm server:stop` → `Start-ScheduledTask SeedingSys`.

### Mở dashboard từ điện thoại hoặc máy khác

1. Cài và đăng nhập Tailscale trên máy chạy dashboard. Trong PowerShell mở bằng quyền quản trị, chạy `tailscale serve --bg 3030` nếu dashboard dùng cổng `3030`. Nếu Tailscale yêu cầu bật HTTPS cho mạng riêng, dùng liên kết mà lệnh đưa ra, rồi chạy lại. `tailscale serve status` hiển thị URL HTTPS của máy chủ.
2. Cài Tailscale trên điện thoại hoặc máy điều khiển, đăng nhập vào cùng mạng Tailscale và bật kết nối. Mở URL HTTPS ở bước 1 trong trình duyệt rồi đăng nhập bằng mã truy cập dashboard. Lấy mã từ mục có vai trò `operator` hoặc `admin` trong `API_TOKENS` của tệp `.env` trên máy chủ. Dùng chính URL HTTPS đó trên Wi-Fi khác hoặc 4G/5G. Giữ máy chủ và dịch vụ SeedingSys chạy để mở dashboard.
3. Với máy Asus lưu các via, cài Tailscale vào cùng mạng và cài SeedingSys Profile Connector trong từng Chrome profile cần nhận việc. Điền sẵn URL HTTPS của máy chủ vào `defaultDashboardOrigin` trong `extension/popup.js` của bản cài dành cho Asus, rồi ghép từng mã profile từ dashboard dùng chung. Kiểm tra đúng mã B, UID và trạng thái online trước khi giao việc. Thiết bị điều khiển dùng trình duyệt. Thiết bị chạy việc giữ Chrome với đúng tài khoản đã ghép.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) · [Kết nối thiết bị từ xa](https://tailscale.com/docs/use-cases/personal-or-at-home-use/access-nas-media-file-servers)

### 2.2 Chuyển sang máy Windows khác

`scripts/move-machine.mjs` chuyển database (`.data\pg`) và `.env`, có checksum từng tệp. Ảnh và video ở R2 thì không cần chuyển. **Phiên Facebook không chuyển được:** Chrome mã hóa cookie theo tài khoản Windows, nên mọi tài khoản phải `pnpm fb:login` lại trên máy mới. Hai máy **không bao giờ** được chạy cùng lúc, nếu không sẽ đăng trùng bài.

Chuẩn bị: commit và push code lên repo private. Máy mới clone đúng commit đó; script cảnh báo nếu còn tệp chưa commit.

**Máy cũ** (chọn giờ ít lịch; slot quá hạn khi tắt máy sẽ bị bỏ, không chạy bù):

```powershell
# 1. Trang Công tắc dừng → bật "Toàn hệ thống". Xử lý các bài Chờ đối chiếu.
pnpm move check                    # lặp lại tới khi báo "An toàn để dừng"
pnpm server:stop
pnpm move export E:\seedingsys-move
```

`export` chỉ chạy khi Postgres đã dừng. Sau khi đóng gói, nó đánh dấu máy cũ đã chuyển (`.data\MOVED.json`): `server:start` và `db:local` sẽ từ chối chạy, và tác vụ tự khởi động bị gỡ. Bỏ chuyển: `pnpm move reactivate`.

**Máy mới** (Windows 64-bit, Node 20.19+, Chrome):

```powershell
git clone <repo> seeding_project; cd seeding_project
corepack enable; pnpm install
pnpm move import E:\seedingsys-move --worker-name may-khach-1
pnpm build:web
pnpm server:start                  # để mở cửa sổ; kiểm tra dashboard thấy đủ bài, lịch
pnpm fb:login B1                   # lặp cho từng tài khoản fb-web, có chủ tài khoản bên cạnh để xử lý 2FA/checkpoint
```

Sau đó tắt dần công tắc dừng từng tài khoản. Ổn định thì Ctrl+C và cài tự khởi động (mục 2.1). `import` kiểm tra checksum, cùng nền tảng và cùng phiên bản `embedded-postgres` (thư mục Postgres chỉ chép được như vậy), và không ghi đè `.data\pg`/`.env` có sẵn trừ khi thêm `--force` (bản cũ được đổi tên, không xóa). Giữ thư mục `.data\pg` ở máy cũ vài tuần rồi mới xóa. Gói chứa `.env`, nên xóa gói sau khi máy mới chạy ổn.

## 3. Cách B — máy chủ thật

### 3.1 Chuẩn bị
- Máy Linux có Docker + Docker Compose v2 (core) và một máy khác cho worker. Tên miền trỏ A record về máy core (ví dụ `ops.congty.vn`).
- WireGuard giữa core và worker (core dùng địa chỉ `10.88.0.1`). **Postgres chỉ lắng nghe trên địa chỉ WireGuard**, không mở ra internet.
- Bucket R2 **private** + khóa truy cập; tài khoản Claude API.
- Chỉ mở cổng 80/443 (Caddy) và WireGuard ra ngoài. API không được công khai.

### 3.2 Máy core

```bash
git clone <repo> seedingsys && cd seedingsys
node scripts/gen-secrets.mjs      # tạo .env.core với mật khẩu Postgres + 4 mã đăng nhập (in ra MỘT lần — lưu vào trình quản lý mật khẩu)
nano .env.core                    # điền DOMAIN, ANTHROPIC_API_KEY, R2_*, kiểm tra APP_ENV
docker compose -f infra/compose/core.yml --env-file .env.core up -d --build
docker compose -f infra/compose/core.yml --env-file .env.core logs -f api worker-core
```

Compose tự chạy migration trước khi bật api/worker. Caddy tự xin chứng chỉ HTTPS cho `DOMAIN`. Đăng nhập tại `https://<DOMAIN>`.

### 3.3 Máy worker
1. Cài WireGuard, kiểm tra `ping 10.88.0.1`.
2. Trên core, tạo role DB giới hạn cho máy này (chỉ cần đọc/ghi các bảng nghiệp vụ, không cần superuser) và điền vào `DATABASE_URL` của `.env.worker`.
3. `cp .env.worker.example .env.worker`, điền thông tin. **Không** đặt `ANTHROPIC_API_KEY` hay `API_TOKENS` ở đây.
4. Thư mục profile (`PROFILES_DIR`) nằm trên **ổ đĩa mã hóa**, không đồng bộ lên cloud.
5. `docker compose -f infra/compose/worker.yml --env-file .env.worker up -d --build`.

> `infra/Dockerfile.worker` cài Chromium cho `fb-web` nhưng **chưa được build thử** (máy phát triển không có Docker): build một lần trên máy worker và chạy `pnpm fb:login` / `pnpm fb:capability` để kiểm tra. Xvfb/noVNC (tiếp quản từ xa) chưa có: hiện đăng nhập/xử lý checkpoint bằng cách ngồi trực tiếp tại máy worker hoặc dùng điều khiển từ xa của hệ điều hành.

### 3.4 Sao lưu & vận hành
- Sao lưu Postgres **ra ngoài máy** hằng ngày (ví dụ `pg_dump` lên R2/ổ khác) và diễn tập khôi phục trước khi chạy thật.
- Nâng cấp: `git pull && docker compose ... up -d --build` (migration tự chạy).
- Khôi phục sau mất điện: các dịch vụ tự khởi động lại (`restart: unless-stopped`); slot quá hạn được bỏ, không chạy bù.

## 4. Người dùng web và quyền

| Vai trò | Làm được |
|---|---|
| `admin` | Mọi thứ + trang Cấu hình |
| `reviewer` | Duyệt/loại/viết lại bài |
| `operator` | Xử lý việc tiếp quản, xác nhận kết quả, công tắc dừng |
| `viewer` | Chỉ xem |

Mỗi người một mã riêng nếu có thể (thêm vào `API_TOKENS`). Mã được lưu trong cookie `httpOnly`, không lộ cho script trên trang. Đổi hoặc thu hồi mã: sửa `API_TOKENS` rồi khởi động lại `api`.

## 5. Kiểm tra sau khi triển khai

- [ ] Đăng nhập được; mã sai bị từ chối; truy cập `/` khi chưa đăng nhập bị chuyển về `/login`.
- [ ] Tổng quan: 5/5 nguồn đọc ổn, heartbeat của máy core và worker < 2 phút.
- [ ] Thêm bài thử vào nguồn → thấy ở Duyệt bài hoặc Lịch & backlog sau tối đa 5 phút.
- [ ] Bật rồi tắt công tắc dừng một tài khoản; xác nhận dashboard phản ánh.
- [ ] `https://<DOMAIN>:3001` **không** truy cập được từ internet.
- [ ] Diễn tập khôi phục DB từ bản sao lưu.

## 6. Còn thiếu để đăng lên Facebook thật

1. Giai đoạn 0 (người làm): quyền sử dụng nội dung, văn bản đồng ý của chủ B1–B5, cố định locale `vi-VN` và đối tượng xem, người phụ trách checkpoint.
2. **Kiểm tra phiên Facebook và bật định dạng cần đăng.** Có thể chạy capability test ở chế độ “Chỉ mình tôi” theo [hướng dẫn Facebook](FB-WEB.md).
3. Build và kiểm tra image worker có Chromium trên máy worker thật.
4. Chuyển mã video (FFmpeg), agent xử lý ngoại lệ UI, tiếp quản qua noVNC.
5. Soak 7 ngày trước khi chuyển `APP_ENV=pilot-live` và đổi đối tượng xem sang thật.

Tự động hóa tài khoản cá nhân có thể đi ngược điều khoản của nền tảng và dẫn tới hạn chế tài khoản. Hệ thống dừng và chuyển cho người khi gặp checkpoint, không cố vượt qua.
