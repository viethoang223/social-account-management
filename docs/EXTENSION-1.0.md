# Kết nối tài khoản qua extension

SeedingSys 1.0 dùng PostgreSQL và hàng đợi hiện có để gửi bài tới đúng UID. Extension chạy trong Chrome profile đã đăng nhập Facebook. Mỗi profile ghép với một đích bằng một mã riêng. Phiên đăng nhập nằm trong Chrome.

Bản này hỗ trợ bài chữ lên trang cá nhân ở chế độ **Chỉ mình tôi**. Người vận hành kiểm tra bài sau khi gửi và xác nhận liên kết trên dashboard. Các connector cũ vẫn có quy trình riêng.

## Chạy thử trên một máy

1. Chạy SeedingSys theo [hướng dẫn triển khai](DEPLOY.md). Nếu nâng cấp từ bản cũ, chạy migration và build lại web trước khi mở bản 1.0.
2. Trong **Quản trị luồng đăng → Tài khoản đích**, mở **Nhập danh sách UID** để tạo tối đa 200 đích mỗi lượt. UID đã có được bỏ qua. Đích mới ở trạng thái tắt. Bạn cũng có thể chọn **+ Thêm đích → Facebook qua extension** để thêm một đích.
3. Chọn đích và bấm **Tạo mã profile**. Mã chỉ hiện khi tạo. Sau khi gắn với một bản cài extension, mã đó không thể ghép bản cài khác. Để đổi profile, chờ lượt đăng đang chạy kết thúc rồi đổi hoặc thu hồi mã.
4. Trong Chrome profile có đúng tài khoản, mở `chrome://extensions`, bật chế độ dành cho nhà phát triển và tải thư mục `extension/` bằng **Tải tiện ích đã giải nén**. Extension này cài bên cạnh FB Desk. Với UID đã chuyển sang SeedingSys, dừng lịch đăng riêng trong FB Desk trước khi bật luồng mới.
5. Mở popup của extension, nhập địa chỉ dashboard, ví dụ `http://localhost:3000`, rồi nhập mã profile. Khi popup hiện đúng mã đích và dashboard báo profile kết nối, bật đích.
6. Tạo ánh xạ từ một nguồn **Nhập bài** đến đích, nhập một bài chữ và duyệt nếu cần. Trong **Lịch & backlog**, bấm **Đăng ngay** và kiểm tra Chrome. Xác nhận liên kết trực tiếp hoặc báo chắc chắn bài chưa xuất hiện ở mục **Cần xử lý**.

## Nhiều profile hoặc nhiều máy

Lặp lại các bước ghép cho mỗi UID. Các máy có thể dùng cùng dashboard qua một địa chỉ HTTPS truy cập được. Mỗi profile xác thực bằng mã riêng qua endpoint web `/extension`. Worker và PostgreSQL dùng cấu hình triển khai SeedingSys.

Chrome phải chạy và đúng tài khoản Facebook phải đăng nhập. Nếu profile hết phiên, đổi UID hoặc quá 75 giây không báo trạng thái, hệ thống không giao lượt mới. Lịch tự động đợi trong cửa sổ của lượt hiện tại. **Đăng ngay** sẽ báo thiếu worker khi profile offline.

## Xử lý khi kết nối gián đoạn

Extension kiểm tra UID, caption và đối tượng xem trước khi bấm. Máy chủ chỉ cấp quyền bấm một lần trong mỗi lượt đã chuyển sang `COMMITTING`, với thời hạn ngắn. Nếu mất kết nối hoặc kết quả chưa rõ sau mốc này, hệ thống chuyển sang đối soát. Lượt đó không được gửi lại tự động.

Định tuyến, từ chối UID sai, phạm vi mã profile, công tắc dừng và giới hạn một lần bấm được kiểm thử trên PostgreSQL với hai profile mô phỏng. Trước khi giao lịch, kiểm tra một bài chữ Chỉ mình tôi với giao diện Facebook trên từng profile thực tế.
