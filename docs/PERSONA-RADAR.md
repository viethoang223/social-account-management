# Phân vai và Radar

Mở **Phân vai & Radar** trên dashboard SeedingSys. Quản trị viên nhập dữ liệu, quản lý nhân vật và ghép UID. Người duyệt xem Radar, kiểm tra cách xưng hô và duyệt phân vai.

## Nhập dữ liệu đang có

| Nguồn | Đầu ra | Nơi dùng |
|---|---|---|
| FB Desk → **Danh bạ nhân vật → Xuất danh bạ JSON** | `desk.personas/1` | Tab **Danh bạ nhân vật**. Giữ mã nhân vật, UID, vai, văn phong và từng chiều quan hệ. |
| Hồ sơ khách hàng → **Xuất JSON** | Một hồ sơ `desk.customer-profile/2` hoặc mảng hồ sơ | Tab **Radar khách hàng**. Nhập Nhân khẩu và Tính cách, giữ bằng chứng, độ tin cậy, điểm chỉnh tay và điểm gốc. |
| SeedingSys → **Giao việc quét Radar** | Hồ sơ `desk.customer-profile/2` từ extension SeedingSys | Dashboard lưu kết quả vào cùng kho Radar, giữ phần điểm quản trị viên đã chỉnh tay. |
| SeedingSys → **Duyệt phân vai** | Bản duyệt lưu kèm hồ sơ đã xem và context `desk.persona-context/1` | Tab **Xem trước & duyệt**. Có thể tải context JSON của bản đã duyệt. |

JSON tối đa 1 MB mỗi lần. Các trường mua hàng, kể cả trường tương ứng trong file Radar cũ, được loại khỏi dữ liệu lưu. Điểm chưa đủ dữ liệu vẫn để trống. Để sửa điểm trong dashboard, mở **Chỉnh điểm** bên cạnh trục. **Về điểm gốc** bỏ phần chỉnh tay của trục đó.

## Gắn vai và duyệt

1. Mở **Danh bạ nhân vật**. Nếu UID trong file đã có đích ghép extension, danh bạ tự hiện đúng mã đích. Các nhân vật còn lại có thể lưu nháp. Chọn đích đã ghép rồi bấm **Gắn UID**. Mỗi UID chỉ gắn với một nhân vật.
2. Mở **Xem trước & duyệt**. Chọn người nói, người nghe và Radar tham chiếu nếu cần. Với một chiều chưa thiết lập, quản trị viên thêm vai và điền cách tự xưng, cách gọi cụ thể. Chiều ngược lại được lưu riêng.
3. Bấm **Xem trước vai và xưng hô**. Kiểm tra hai UID, vai, văn phong và mẫu lời thoại, rồi bấm **Duyệt phân vai**. Hệ thống lưu dữ liệu đã xem. Nếu thay đổi quan hệ, ghép sang profile khác hoặc sửa Radar tham chiếu trước khi duyệt, hãy xem trước lại.
4. Trong **Phân vai đã duyệt gần đây**, mở bản duyệt để kiểm tra lại và tải context JSON. Context dùng cho soạn và duyệt, không cấp quyền đăng bài hoặc gửi bình luận.

## Phạm vi tích hợp

Dashboard là chỗ nhập, ghép, giao việc và duyệt. Extension SeedingSys trên `main` (manifest **1.2.0**) nhận việc đọc Radar, Post Research, đăng bài chữ và gửi bình luận. Các profile đã ghép tiếp tục dùng cùng mã khi tải lại extension tại chỗ.

Trong **Radar khách hàng**, nhập link trang công khai của khách đã liên hệ rồi bấm **Giao việc quét Radar**. Dashboard tự chọn một đích bật, online, đã ghép và có khả năng quét Radar. Extension mở tab tạm để đọc đầu trang, bài có nhãn công khai và thông tin Giới thiệu hiển thị. Nó gửi lại điểm và bằng chứng đã giới hạn từ mô hình Radar gốc. Lượt quét chờ khi UID đó đang giữ khóa đăng bài. Xem tiến độ và kết quả ngay dưới biểu mẫu.

Bấm **Duyệt phân vai** để lưu cặp UID và cách xưng hô. Trong Kho bài viết, chọn vai đã duyệt ở bản nháp bình luận, duyệt nội dung rồi giao lượt gửi. [Post Research và bình luận](RESEARCH-COMMENTS.md)

Mẫu JSON tương thích trong `tests/fixtures/personas/` dùng dữ liệu giả và được tạo từ bộ xuất của FB Desk `caf1130`. Kiểm thử kiểm tra cả hai chiều quan hệ, UID chưa ghép, điểm thiếu dữ liệu, dữ liệu mua hàng bị loại và tính nhất quán từ xem trước đến duyệt.
