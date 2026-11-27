# Connector fb-web

Đăng bài lên trang cá nhân (B) bằng trình duyệt Chromium với **một profile riêng cho mỗi tài khoản**, do một người đăng nhập tay. Mã nằm ở `packages/connectors/fb-web`.

## Trạng thái — đọc kỹ

| Hạng mục | Trạng thái |
|---|---|
| Phiên, danh tính, soạn nháp, xem trước, đăng và đối soát | ✅ Kiểm thử với giao diện Facebook giả (`tests/helpers/mock-fb.ts`) bằng Chromium |
| **Selector trên giao diện Facebook thật** | ⚠️ **CHƯA kiểm chứng.** `selectors.ts` được viết theo giao diện vi-VN thường gặp (role + tên hiển thị). Facebook đổi giao diện thường xuyên nên rất có thể cần chỉnh khi thử lần đầu |
| Định dạng | TEXT, QUOTE_IMAGE, SINGLE_PHOTO, MULTI_PHOTO, VIDEO, REEL. Reel có trình tạo riêng. |
| Đọc nguồn (A) từ Facebook | Có kết nối khách, kết nối dùng phiên đã đăng nhập và Graph API. Xem mục “Phía đọc” để biết phạm vi từng kết nối. |
| Chuyển mã video, tiếp quản qua noVNC, agent UI | ❌ Chưa làm |

Worker đăng các định dạng được bật trong `FB_ENABLED_FORMATS` với phiên bản connector đang hoạt động. Giá trị rỗng tắt mọi định dạng. Kết quả `capability_checks` được lưu để theo dõi các lượt kiểm thử tự chọn.

## Cách hoạt động và các chốt an toàn

1. **Người đăng nhập tay.** `pnpm fb:login B1` mở cửa sổ trình duyệt thấy được trên profile của B1. Bạn tự nhập mật khẩu/xác minh 2 bước. Hệ thống không bao giờ nhập mật khẩu và không có mã nào vượt checkpoint.
2. Trước mỗi lần đăng: mở trang chủ → nếu bị đưa tới đăng nhập/checkpoint thì dừng (`LOGGED_OUT`/`CHECKPOINT`); vào `/me` để lấy ID đang đăng nhập và so với `external_id` của tài khoản (số hoặc tên người dùng) → sai thì dừng.
3. **Soạn nháp không có tác dụng ngoài:** mở composer, gõ caption, đính media (một lần, đúng thứ tự manifest), chọn/kiểm tra đối tượng xem. Sau đó `previewCheck` đọc lại caption, số ảnh, nút Đăng và đối tượng xem; sai là dừng, **chưa bấm gì**.
4. Hệ thống ghi `COMMITTING` trước khi bấm “Đăng”. Khi kết quả chưa rõ, bài chuyển sang `UNKNOWN` để đối soát. Bài chỉ có thể quay lại hàng đăng sau khi xác nhận lần trước chưa xuất hiện.
5. **Xác minh** (`FB_VERIFY`) mở trang cá nhân, cuộn và tìm bài theo **nội dung caption** (bài trên trang cá nhân không có dấu “bài viết” như trang chủ).
   - `caption` (mặc định): xác minh khi caption khớp và nhận diện được liên kết riêng của bài. Nếu đọc được thời gian, bài phải nằm trong cửa sổ xác minh. Nhiều ứng viên trùng khớp cần người đối soát.
   - `strict`: caption + mốc thời gian trong cửa sổ + đúng số ảnh.
   - `off`: bỏ qua kiểm tra và giữ kết quả ở trạng thái chưa xác minh để người vận hành đối soát.
   “Không thấy” chỉ được coi là **chắc chắn** khi đã cuộn qua một bài cũ hơn thời điểm bấm đăng *và* mọi mốc thời gian đọc được; ngược lại vẫn là chưa rõ (tránh đăng trùng).
6. Không có chế độ tàng hình, giả dấu vân tay trình duyệt, hay giãn cách ngẫu nhiên để lẩn tránh phát hiện.

### Giới hạn đã biết

- Reel cần đúng một tệp video. Reel không có caption cần liên kết trực tiếp trả về sau khi đăng để xác minh. Chạy công cụ chứng nhận với `--formats REEL --video <tệp>` khi đã chuẩn bị hồ sơ thử. Công cụ chứng nhận tạo bài thật theo đối tượng “Chỉ mình tôi”.
- Bình luận vào bài đã xác minh được phân công theo hồ sơ. Điều phối viên duyệt từng bình luận rồi gửi từ Kho bài. Phản hồi cần có liên kết bình luận cha đã xác minh. Bài ở chế độ “Chỉ mình tôi” chỉ cho phép dùng chính hồ sơ đăng bài.
- Thứ tự ảnh đảm bảo nhờ thứ tự tải lên, **không** kiểm tra được bằng mắt (không đọc được checksum từ ảnh thu nhỏ); số ảnh thì được kiểm tra.
- Mốc thời gian trên timeline là tương đối (“5 phút”, “2 giờ”); hệ thống hiểu các dạng phổ biến bằng tiếng Việt. Dạng lạ → coi là không đọc được.
- Caption dài bị Facebook cắt (“Xem thêm”): so khớp theo 160 ký tự đầu.
- Video: chờ Facebook xử lý bằng cách gia hạn khóa tài khoản; thời gian chờ tối đa `FB_UPLOAD_TIMEOUT_MS` (mặc định 10 phút) — cần chỉnh theo kích thước thực tế.

## Quy trình đưa vào dùng

1. **Chuẩn bị (người):** văn bản đồng ý của chủ tài khoản, ngôn ngữ giao diện tiếng Việt, đối tượng mặc định “Chỉ mình tôi”, người phụ trách checkpoint.
2. Đặt `target_accounts.connector = fb-web`, `audience = ONLY_ME`, `external_id` = ID số hoặc tên người dùng (trang Cấu hình). Đặt `FB_PROFILES_DIR` (ổ mã hóa).
3. **Dừng `worker-browser`** (một profile chỉ mở được trong một trình duyệt), rồi:
   ```powershell
   pnpm fb:login B1
   ```
   Đăng nhập, đóng cửa sổ.
4. **Thử một ca** để xem selector có khớp giao diện thật không (đăng 1 bài thử chỉ mình bạn thấy, rồi tự xóa):
   ```powershell
   pnpm fb:capability B1 --formats TEXT --cases 1 --pause-sec 5 --yes
   ```
   Nếu báo `UI_UNEXPECTED`, mở `selectors.ts` và chỉnh theo giao diện thật (đặt `FB_HEADLESS=false` và `FB_SCREENSHOT_DIR` để xem), rồi thử lại. Nâng `SELECTORS_VERSION` khi đổi.
5. **Kiểm thử tùy chọn:** mỗi định dạng ≥20 ca, ngưỡng 95% (chữ, một ảnh) / 90% (nhiều ảnh, video):
   ```powershell
   pnpm fb:capability B1 --yes --activate
   ```
   Lệnh giãn cách mỗi bài 60 giây (đổi bằng `--pause-sec`), dừng ngay khi gặp checkpoint, đăng xuất, sai danh tính, sai đối tượng hoặc kết quả chưa rõ. Kết quả ghi vào `capability_checks` và hiện ở trang Cấu hình. Bài thử **không tự xóa**.
6. Đặt `FB_ENABLED_FORMATS` theo các định dạng cần đăng trên máy worker rồi bật lại `worker-browser`.
7. Chỉ khi đã soak ≥7 ngày ở “Chỉ mình tôi” mới cân nhắc đổi đối tượng xem sang thật và `APP_ENV=pilot-live`.

## Nguồn nội dung

Chọn **Cách lấy bài** ở trang **Quản trị luồng đăng**.

| Connector | Cách hoạt động | Cần gì |
|---|---|---|
| `fb-public` | Quét bài của chủ trang qua bảng tin Facebook dành cho khách | URL trực tiếp của trang cá nhân hoặc fanpage, ví dụ `https://www.facebook.com/profile.php?id=123` hoặc `https://www.facebook.com/ten.trang` |
| `fb-session` | Quét bài của chủ trang bằng phiên Facebook của đích trong luồng | URL nguồn và đúng một đích Facebook đang bật, có hồ sơ trình duyệt đã đăng nhập |
| `fb-web` | Đọc **trang cá nhân của chính tài khoản đang đăng nhập** trong profile trình duyệt của nguồn | Đăng nhập một lần bằng `pnpm fb:login N1`. Dùng UID hoặc tên người dùng của tài khoản đó làm địa chỉ nguồn. |
| `manual` | Người vận hành nhập bài ở trang **Nhập bài** | Không |
| `fb-graph` | Graph API chính thức (Page bạn quản trị, hoặc `me`) | Token trong `FB_GRAPH_TOKEN_N1`. Phân trang bài và bình luận đã kiểm thử với phản hồi API giả lập. |

### Quét nguồn công khai và đăng theo luồng N1 → B1

1. Chọn **Luồng đăng** và mở **N1 → B1**. Tại **Nguồn N1**, chọn **Facebook công khai**, nhập URL, đặt chu kỳ, bật nguồn và bấm **Lưu nguồn**.
2. Bấm **Quét ngay** để gửi lượt đọc cho worker và xem kết quả trong phần nguồn. Facebook công khai đưa từng bài tìm được vào luồng xử lý từ lượt đầu. Facebook có thể đổi mã `pfbid` của cùng một bài giữa các lượt đọc, nên bài trùng được nhận diện theo ID bài, rồi theo mã ảnh/video, rồi theo caption + thời điểm đăng; mã mới được lưu làm bí danh của bài cũ (kể cả bài trong thùng rác). Trình quét dùng phiên khách tạm thời. B1 sử dụng phiên đăng đã thiết lập cho tài khoản đích.
3. Tại **Duyệt và lịch đăng**, bật luồng và chọn cách duyệt, thời gian cho phép đăng muộn, hiệu lực bài và thứ tự hàng chờ. Tại **Lịch & backlog**, bấm **Đăng ngay** cạnh một bài sẵn sàng để gửi job cho worker. Lịch tự động vẫn chọn bài vào lượt đầu giờ.

Nếu trang không mở được ở chế độ khách, chọn **Facebook qua tài khoản đích** ở nguồn N1 trong luồng **N1 → B1**. Worker kiểm tra đúng danh tính B1 trước khi mở URL nguồn. Phiên B1 xử lý từng việc một, nên yêu cầu quét sẽ chờ lượt sau nếu B1 đang bận. Khi phiên hết hạn, đăng nhập lại bằng `pnpm fb:login B1`. Ảnh hoặc video mà phiên B1 chưa tải được vẫn ở Duyệt bài.

PostgreSQL lưu ID bài, permalink, caption, phiên bản và manifest media. Với album “+N”, trình quét mở bộ ảnh công khai và đối chiếu số lượng trước khi cho đăng. Worker media lưu ảnh và video MP4 đầy đủ vào R2 theo checksum khi `STORAGE_DRIVER=r2`. Album chưa tải đủ hoặc video chỉ có luồng phát sẽ được giữ để xử lý.

- Nguồn **Facebook công khai** dùng caption gốc theo mặc định. Chọn **Tự động nếu đạt kiểm tra** để bài đủ dữ liệu đi thẳng vào Backlog. Nút **Viết lại bằng AI** chỉ được dùng khi chọn ở màn hình Duyệt bài.
- Chọn **Lưu caption** ở Duyệt bài nếu cần lưu sửa đổi trước khi duyệt, hoặc **Sửa caption** ở Backlog trước khi bấm **Đăng ngay**. Nếu Facebook chỉ cung cấp một phần album hoặc không trả tệp video cho khách, dùng **Bổ sung media gốc** để tải lại toàn bộ ảnh theo thứ tự hoặc một video. Bài vẫn giữ ID nguồn cũ.
- Sau khi triển khai, kiểm tra Dashboard thấy đủ worker và dùng **Quét ngay** trên N1. Đối chiếu caption, số ảnh và khả năng xem video trong Duyệt bài trước khi thử **Đăng ngay** lên B1 ở chế độ **Chỉ mình tôi**.

Giới hạn cố ý của `fb-web` khi đọc:
- Chỉ đọc `/me` và chỉ khi tài khoản đang đăng nhập **đúng là** nguồn đã khai; sai tài khoản thì dừng và báo lỗi. Không mở trang của người khác.
- Chỉ lấy bài **do chủ trang viết**; bài người khác đăng lên tường bị bỏ qua. Không đọc bình luận hay tên người bình luận.
- Không đăng nhập hộ, không vượt checkpoint: gặp là báo lỗi nguồn để người xử lý.

Những gì đọc được: toàn bộ caption (tự bấm "Xem thêm"), ID bài ổn định (lấy từ liên kết thời gian sau khi rê chuột), ảnh theo kích thước hiển thị trên trang cá nhân. Không lấy được: **video** (trang phát video theo luồng, không có tệp) → bài video vào **Duyệt bài** để người tải tệp lên; album nhiều hơn số ảnh hiển thị ("+N") → vào **Duyệt bài**. Lần đọc đầu tiên của mỗi nguồn chỉ ghi nhận bài cũ, không đăng lại chúng.

## Khi Facebook đổi giao diện
Bật công tắc dừng theo connector `fb-web` (trang Công tắc dừng) → sửa `selectors.ts`/flow → chạy test (`pnpm test`) → chạy lại `pnpm fb:capability` → tăng phiên bản (kết quả cũ không còn hiệu lực vì khóa theo phiên bản) → tắt công tắc dừng.
# Kho bài viết và bình luận

- Mở **Kho bài viết**, chọn profile nguồn hoặc đích rồi chọn bài. Trang đích hiển thị các bản nháp và bài đăng trong lịch sử SeedingSys. Cột đối chiếu lấy caption và media của đúng bản duyệt hoặc bản đã đăng.
- Chọn **Quét bình luận** trong một bài hoặc bật **Tự quét bình luận khi phát hiện bài mới** ở tùy chọn nguồn. Bình luận được lưu theo ID của bài và ID bình luận. Nhánh phản hồi giữ ID cha. Trình đọc Facebook lưu phần giao diện hiển thị cho phiên đang dùng, còn Graph API đọc các trang kết quả mà quyền của token cho phép.
- Để đưa thảo luận sang bài đích, duyệt nội dung và chọn profile gửi cho từng bình luận. Khi bài đích có liên kết trực tiếp, người vận hành có thể gửi qua worker. Với phản hồi, bình luận cha ở đích phải được ghi nhận trước.
- Nếu lượt gửi chuyển sang **Chờ đối chiếu**, kiểm tra bài hoặc bình luận cha trên Facebook. Nếu đã gửi thành công, dán liên kết bình luận để ghi nhận. Chỉ chọn xác nhận chưa đăng khi đã kiểm tra đúng nơi, sau đó mới gửi lại.

## Đồng bộ profile và thùng rác

Trong **Kho bài viết**, chọn nguồn rồi mở **Đồng bộ profile** để chọn đích. Lượt chạy dùng dữ liệu đã lưu hoặc đọc thêm lịch sử và bình luận. Graph API đi tiếp theo con trỏ từng trang. Trình duyệt chuẩn bị các bài đã đọc được và báo lịch sử chưa xác minh đầy đủ. Sau khi chuẩn bị, có thể duyệt tối đa 50 bài đủ nội dung mỗi lượt hoặc mở từng bài để kiểm tra. Bài đã đăng ở đích giữ liên kết hiện tại và được đánh dấu khi bản nguồn đã thay đổi.

`profile_syncs` lưu tiến độ theo luồng và con trỏ. `profile_sync_items` liên kết từng bài, bản chờ duyệt và lượt quét bình luận. Ảnh và video tiếp tục dùng manifest của revision. Bản sao bình luận dùng khóa đích + bình luận nguồn, nên chạy lại giữ các nội dung đã chỉnh, trạng thái loại và liên kết đã ghi nhận.

**Xóa khỏi kho nguồn** đưa bài vào thùng rác và hủy job còn chờ. Bài đã đăng vẫn có lịch sử ở profile đích. Khôi phục trả bài về kho và các bản duyệt chưa hết hạn tiếp tục theo lịch.

