# Post Research và bình luận

Một bản cài **SeedingSys Profile Connector 1.2.0** trên mỗi Chrome profile nhận các lệnh do dashboard giao. Để nâng cấp bản đang chạy, cập nhật repo mới, build web và áp dụng migration. Bật API, web, `worker-core` và `worker-browser` khi vận hành bình luận. Tải lại extension trong từng Chrome profile đã ghép.

## Giao việc đọc

1. Mở **Post Research** và dán link profile, bài viết, Reel hoặc video. Dùng liên kết trực tiếp tới bài. Dashboard nhận dạng loại link và chọn profile đang kết nối, đã ghép đúng UID, có hỗ trợ Post Research.
2. Với link profile, chọn **Đọc bài và bình luận** cạnh bài tìm thấy. Với link bài, kết quả hiển thị caption, tác giả, liên kết ảnh hoặc video tìm được và cây bình luận đọc được. Kết quả có thể hiện **Đã đọc một phần** nếu Facebook giới hạn dữ liệu hiển thị. Tải JSON nếu cần lưu một bản của kết quả.
3. Chọn một nguồn **Nhập bài** đang bật rồi **Lưu vào Kho bài viết**. Nếu bài có ảnh hoặc video, xác nhận phạm vi lưu dạng chữ. Khi extension đọc được UID tác giả dạng số và UID đã ghép, người vận hành có thể gắn link làm bài đích đã đăng của profile đó.

## Chuẩn bị một lô bài Instagram

1. Trong **Post Research**, dán link profile Instagram, nhập số bài cần tìm và gửi lượt đọc. Mở **Tài khoản Instagram** để xem Chrome profile nào đang online và đã đăng nhập Instagram.
2. Trong kết quả tìm bài, chọn **Tài khoản Facebook đích** theo mã B và bấm **Đọc caption và media cả lô**. SeedingSys giao từng bài cho Chrome đang đăng nhập Instagram. Bạn có thể đóng dashboard trong khi Chrome và máy chủ tiếp tục chạy.
3. Mở **Kết quả từng bài** để xem B nào đọc, caption, số ảnh và số video. Trạng thái **Còn thiếu nội dung** cho biết cần đọc lại hoặc kiểm tra bài gốc. Nút **Đọc lại bài lỗi hoặc còn thiếu** giữ nguyên các bài đã đọc đủ. Việc chọn đích chỉ lưu tài khoản dự kiến cho lô.
4. Chọn **Nguồn trong Kho bài viết**, xác nhận quyền sử dụng một lần rồi bấm **Lưu lô vào Kho bài viết**. SeedingSys lưu ngay những bài đã đọc đủ và tự lưu các bài tiếp theo khi đọc xong. Khi nhập video, máy chạy worker-media dùng FFmpeg để chuẩn bị MP4 H.264/AAC theo cách của FB Desk. Cài FFmpeg trên máy đó hoặc đặt `MEDIA_FFMPEG_PATH` trỏ tới tệp thực thi. Kiểm tra trạng thái media trong kho và khả năng đăng media của đích trước khi lên lịch.
5. Khi bài đã có link Facebook, dùng **Phân vai & Radar** để duyệt quan hệ và cách xưng hô theo từng cặp UID, rồi soạn và duyệt bình luận trong **Kho bài viết**.

## Duyệt và gửi bình luận

1. Trong **Phân vai & Radar**, duyệt cách xưng hô theo đúng chiều. Với bình luận gốc, người nghe là chủ bài đích. Với phản hồi, người nghe là UID đã được duyệt để gửi bình luận cha.
2. Mở bài trong **Kho bài viết**, chọn đích và **Xử lý** bình luận. Chọn vai đã duyệt nếu màn hình có nhiều lựa chọn, xem lại nội dung và bấm **Duyệt bình luận**. Vai đã duyệt xác định UID gửi. Việc duyệt nội dung đưa bản nháp vào danh sách có thể gửi.
3. Kiểm tra bài trực tiếp bằng các profile sẽ tham gia. Trên bài đích cần cho các profile khác bình luận, người vận hành bấm **Xác nhận UID khác có quyền bình luận**. Bấm **Gửi bình luận** hoặc **Gửi tất cả đã duyệt**. Bình luận cha được xử lý trước, phản hồi chờ liên kết của bình luận cha.
4. Extension đối chiếu phiên đăng nhập, link bài, ô nhập, đúng nội dung và nhận quyền bấm gửi một lần. Bình luận có liên kết xác minh được hiện là **Đã đăng**. Nếu lần gửi cần đối soát, kiểm tra bài trên Facebook và dán link bình luận để ghi nhận. Chỉ xác nhận vắng mặt sau khi kiểm tra trực tiếp.

Ca tích hợp dùng hai UID mẫu trong `tests/e2e/research-comments.test.ts`. Dữ liệu thử nghiệm dùng PostgreSQL riêng. Chrome kiểm tra trình đọc và trình soạn bằng HTML mẫu phục vụ tại URL giả lập trong trình duyệt kiểm thử.
