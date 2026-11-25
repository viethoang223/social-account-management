# Bàn giao cho Codex trên thiết bị Windows khác

Repo của nhóm là [`viethoang223/social-account-management`](https://github.com/viethoang223/social-account-management). Bản ứng dụng được nghiệm thu bằng mô phỏng là `v1.0.0` tại commit `3571305`. Đọc tài liệu này và kiểm tra máy trước khi cài. Khi xong, báo lại URL dashboard, phiên bản đã chạy, kết quả kiểm tra và phần nào cần chủ tài khoản thao tác.

## 1. Chọn vai trò của máy

| Nhu cầu | Cài trên máy này |
|---|---|
| Thử độc lập trên một máy hoặc chuyển máy này thành máy chủ | Chạy dashboard, API, PostgreSQL và các worker. Cài extension vào Chrome profile cần thử. |
| Giữ các via trên máy này và điều khiển từ dashboard đã có | Cài extension vào từng Chrome profile. Lấy URL HTTPS của dashboard và mã ghép của từng đích từ quản trị viên. |

Nếu người dùng chưa có URL dashboard dùng chung, triển khai thử một máy trước. Mỗi bản cài localhost có database riêng. Nếu chỉ ghép thêm via vào dàn dùng chung, thực hiện mục 3 với dashboard đã có. Extension kết nối với dashboard qua HTTP loopback trên cùng máy hoặc HTTPS giữa các máy. Bước ghép profile không cần SSH.

## 2. Cài và chạy dashboard trên Windows

1. Kiểm tra Git, Node.js từ 20.19 trở lên, pnpm **9.15.9** và Chrome từ 120 trở lên nếu dùng extension. Kiểm tra có SeedingSys đang chạy, thư mục cài cũ hay tác vụ tự khởi động nào trên máy. Giữ nguyên các cài đặt đang phục vụ người dùng.
2. Từ thư mục làm việc mà người dùng chọn, clone repo. Nếu repo đã có trên máy, kiểm tra `git status`, remote và commit hiện tại trước khi cập nhật. Dùng bản phát hành đã ghim cho lần cài thử.

   ```powershell
   git clone --branch v1.0.0 https://github.com/viethoang223/social-account-management.git
   Set-Location social-account-management
   git rev-parse --short HEAD
   node --version
   pnpm --version
   ```

   Nếu thiếu pnpm hoặc đang dùng phiên bản khác, cài bản 9.15.9 bằng Node/npm của máy hoặc dùng Corepack nếu đã có. Xác nhận phiên bản trước khi chạy `install`.

3. Tạo cấu hình local cho bản cài mới. Giữ `APP_ENV=local`, `LLM_MODE=fake` và `STORAGE_DRIVER=local` cho lần thử. Đoạn dưới tạo mật khẩu PostgreSQL và ba mã truy cập mới, lưu vào `.env` mà không in chúng.

   ```powershell
   @'
   const fs = require('node:fs');
   const { randomBytes } = require('node:crypto');
   const secret = () => randomBytes(24).toString('hex');
   if (!fs.existsSync('.env')) {
     let config = fs.readFileSync('.env.example', 'utf8');
     config = config.replace('postgresql://seedingsys:seedingsys@', 'postgresql://seedingsys:' + secret() + '@');
     for (const role of ['admin', 'reviewer', 'operator']) {
       config = config.replace('dev-' + role + '-token', secret());
     }
     fs.writeFileSync('.env', config, { flag: 'wx' });
   }
   '@ | node
   ```

   Cổng mặc định là web `3000`, API loopback `3001` và PostgreSQL loopback `54329`. Nếu các cổng đã bị bản khác dùng, chọn bộ cổng khác cho bản mới. Đổi `WEB_PORT`, `API_PORT`, `LOCAL_PG_PORT` và cổng tương ứng trong `DATABASE_URL` trước lần chạy đầu. Khi nâng cấp một bản đang có dữ liệu, sao lưu và dùng cấu hình của bản đó.

4. Cài dependency, tạo Prisma Client, build web rồi khởi động. Chạy tiếp lệnh sau khi lệnh trước thành công.

   ```powershell
   pnpm install --frozen-lockfile
   pnpm db:generate
   pnpm build:web
   node scripts/server.mjs start
   ```

   Lệnh cuối chạy supervisor ở foreground và tự áp dụng migration. Giữ cửa sổ này mở trong lúc dùng. Nếu cần chạy nền hoặc tự khởi động, xem [hướng dẫn triển khai Windows](docs/DEPLOY.md#21-chạy-thường-trực-trên-máy-windows-này-không-docker). Chỉ tạo tác vụ tự khởi động nếu đó là cách vận hành người dùng muốn.

5. Dùng PowerShell thứ hai trong cùng thư mục để xác minh dịch vụ. Chỉ chạy `pnpm db:seed` trên database local mới nếu cần dữ liệu mẫu. Các đích **B1–B5** tạo từ seed là giả lập.

   ```powershell
   node scripts/server.mjs status
   Invoke-RestMethod http://127.0.0.1:3001/health
   pnpm db:seed
   ```

   Mở [dashboard local](http://localhost:3000/login) và đăng nhập bằng mã ứng với vai trò `admin` trong `.env`. Nếu đã đổi cổng, dùng cổng đã cấu hình. Mở **Quản trị luồng đăng** để xác minh đã thấy các nguồn hoặc đích mẫu. Kiểm tra log ở `.data/logs` nếu web đã mở mà API chưa sẵn sàng. Dừng đúng bản đang chạy bằng `node scripts/server.mjs stop` từ thư mục của nó.

## 3. Ghép tài khoản với Chrome profile

1. Trên dashboard dự định vận hành, mở **Quản trị luồng đăng → Tài khoản đích → Nhập danh sách UID**. Dán một UID Facebook dạng số mỗi dòng, tối đa 200 UID mỗi lượt. Có thể tạo một đích bằng **+ Thêm đích → Facebook qua extension**. Mã `B...` là mã đích nội bộ.
2. Chọn đích của UID cần ghép và **Tạo mã profile**. Dùng một mã riêng cho từng UID. Khi API báo mã đã gắn với bản cài khác, kiểm tra profile trước. Đổi hoặc thu hồi mã trong dashboard khi chuyển tài khoản sang bản cài khác.
3. Trên đúng Chrome profile đang đăng nhập UID đó, mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển** và **Tải tiện ích đã giải nén** từ thư mục `extension/` của repo. Kiểm tra tên **SeedingSys Profile Connector**, phiên bản **1.0.0**. Mở popup, nhập URL gốc của dashboard và mã profile. Kiểm tra popup báo đúng mã `B...` và dashboard hiện **Profile đang kết nối**.
4. Nếu Chrome chưa đăng nhập, để chủ tài khoản tự nhập mật khẩu và hoàn tất xác minh. Nếu sai UID, dừng và kiểm tra lại Chrome profile. Có thể cài SeedingSys bên cạnh FB Desk trong Chrome. Với via chuyển sang SeedingSys, kiểm tra lịch FB Desk của chính via đó đã dừng trước khi bật đích mới.
5. Với thiết bị ở xa, dùng URL HTTPS của dashboard thay cho `localhost`. Chỉ chia sẻ mã profile được cấp cho via trên máy đó. Mã admin, mật khẩu PostgreSQL, cookie và dữ liệu Chrome không cần chuyển sang máy chạy extension. Giữ Chrome chạy với đúng tài khoản trong lúc cần nhận việc.

## 4. Thử và vận hành

1. **Kiểm tra nội bộ trước.** Dùng A/B giả lập để thử lấy bài, duyệt và hàng chờ. Nếu dùng `pnpm fake post A1 "Bài kiểm thử nội bộ"`, chờ hoặc bấm **Quét ngay** để A1 có lượt đọc thành công đầu tiên trước khi thêm bài. Sau đó quét lại và xem **Duyệt bài**, **Lịch & backlog** và **Bài đã đăng**.
2. **Kiểm tra ghép thật.** Chọn hai UID và hai Chrome profile mà người dùng chỉ định. Mỗi popup phải hiển thị đúng đích của mình. Khi một profile đóng hoặc đổi UID, đợi hết cửa sổ heartbeat tối đa khoảng 75 giây rồi kiểm tra trạng thái kết nối của đúng đích. Thử kiểm tra trạng thái khi cả hai đích còn tắt.
3. **Thử đăng thật khi người dùng đã chỉ định tài khoản và nội dung.** Tạo một nguồn **Nhập bài** và ánh xạ nó sang đúng đích đã ghép. Dùng một bài chữ riêng để thử, đối tượng **Chỉ mình tôi**. Bật đích và ánh xạ, nhập bài, duyệt nếu cần rồi dùng **Đăng ngay** ở **Lịch & backlog**. Bản 1.0 dùng extension cho bài chữ. Ảnh, video và đăng công khai qua extension nằm ngoài phạm vi bản này.
4. **Xác nhận kết quả.** Khi bài sang **Cần xử lý**, kiểm tra đúng profile và nội dung trên Facebook. Dán liên kết trực tiếp của bài nếu thấy nó. Chỉ xác nhận vắng mặt khi đã kiểm tra chắc chắn. Nếu vừa mất kết nối hoặc chưa rõ bài có lên chưa, giữ trạng thái đối soát và tránh gửi lại.
5. **Bật lịch sau khi kiểm thử đạt.** Mỗi đích chỉ nên nhận lịch đăng từ một hệ thống. Coi **Đang bật** là trạng thái cấu hình. Dùng **Profile đang kết nối** để xem tín hiệu kết nối. Một kết nối thành công chưa chứng minh thao tác đăng thật đã đạt.

## 5. Xử lý nhanh và báo cáo

| Dấu hiệu | Kiểm tra |
|---|---|
| Không mở được dashboard | Chạy `node scripts/server.mjs status` trong đúng thư mục. Kiểm tra cổng, `BUILD_ID`, log supervisor và API. |
| Không thấy chức năng nhập UID | Kiểm tra mã đăng nhập có vai trò admin, bản web đã build lại và database đã chạy migration của v1.0.0. |
| Extension báo sai UID hoặc chưa online | Kiểm tra đúng Chrome profile, địa chỉ dashboard, mã ghép, phiên Facebook và kết nối HTTPS nếu khác máy. |
| Đăng ngay báo thiếu worker | Kiểm tra popup và heartbeat của đích. Xác minh đích, nguồn và ánh xạ đã bật, cùng với công tắc dừng. |
| Chưa rõ kết quả đăng | Vào **Cần xử lý** và đối chiếu trên Facebook. Tránh chạy lại cùng bài khi chưa biết kết quả. |

Khi thay mã nguồn, chạy `pnpm typecheck`, `pnpm test` và `pnpm build:web`. Test hồi quy cho kết nối hai profile nằm ở `tests/e2e/extension-routing.test.ts`. Bản 1.0 đã qua 147 ca kiểm thử trên môi trường kiểm thử của repo. Lượt Facebook thật trên máy mới cần được xác minh riêng.

Chỉ đưa vào báo cáo đường dẫn, commit, URL, mã đích nội bộ, trạng thái và lỗi đã lược bí mật. Giữ `.env`, `.data`, token và thông tin đăng nhập ngoài commit, lịch sử chat và log chia sẻ. Nếu người dùng yêu cầu push, kiểm tra đích là `viethoang223/social-account-management`.

Tài liệu bổ sung: [triển khai và vận hành](docs/DEPLOY.md) · [extension v1.0](docs/EXTENSION-1.0.md).
