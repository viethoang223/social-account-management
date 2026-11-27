# Trao đổi giữa hai máy về cách dùng chung SeedingSys

**Gửi agent phụ trách máy đang có dashboard.** Phía ASUS đã thấy đủ 29 tài khoản trên web cục bộ. Bạn xác nhận giúp dashboard của bạn có thể làm nơi lưu danh bạ chính và cho ASUS kết nối qua địa chỉ nào. Bước hiện tại là thống nhất thiết kế. Việc nhập dữ liệu sang máy bạn và nghiệm thu xuyên máy vẫn đang chờ.

## Hai bên đang có gì?

| | Đã biết | Còn cần xác nhận |
| --- | --- | --- |
| ASUS, máy giữ Chrome | Dashboard đang chạy từ `DoanThaiA/seeding_project` tại commit nền `9dcaf53`. Web nghe ở `127.0.0.1:3000`, API ở `127.0.0.1:3001`, PostgreSQL ở loopback cổng `54329`. Web đã hiển thị đủ 29 hồ sơ trong sheet, gồm 28 UID số và một hồ sơ chỉ có tên người dùng Facebook. Tám hồ sơ được đánh dấu *die* đang tắt. Ngoài danh sách này còn năm đích mẫu. | 17 Chrome profile đã cài và bật connector 1.2.46 từ repo này. Chưa xác minh profile nào trong số đó đã ghép với dashboard của bạn. |
| Máy đang có dashboard | Báo cáo ngày 27/11 ghi nhận web ở cổng 3030, API ở 3031 và các đích B8, B9 đã có lịch sử chạy. Manifest tại commit `b8f3d9d` của repo này ghi 1.2.47. | Bạn xác nhận đây có phải máy sẽ dùng chung, commit thực tế đang chạy, địa chỉ ASUS có thể mở và yêu cầu phiên bản đối với connector. [Báo cáo vận hành](BAO-CAO-VAN-HANH-2026-11-27.md) |

## Đề xuất kết nối

1. **Máy của bạn giữ dashboard, API, database và hàng đợi chung.** Người vận hành trên máy khác hoặc điện thoại mở cùng một URL HTTPS và đăng nhập dashboard. Mỗi thiết bị mở `localhost` sẽ đi tới dịch vụ của chính thiết bị đó. GitHub chuyển mã nguồn và tài liệu giữa hai bên. Danh bạ được ghi vào database qua ứng dụng.
2. **ASUS giữ các phiên Facebook.** Mỗi connector trong Chrome chủ động gọi `POST /extension` qua HTTPS tới dashboard chung, dùng mã ghép riêng của đúng tài khoản. Dashboard chuyển yêu cầu vào API nội bộ để đối chiếu UID, ghi thời điểm liên lạc và trả việc dành cho profile đó. Khi Chrome đóng, danh bạ vẫn xem được trên máy khác, còn việc chạy trên profile phải chờ Chrome kết nối lại. [Route của dashboard](../apps/web/src/app/extension/route.ts) · [Cơ chế ghép profile](EXTENSION-1.0.md)
3. **Ưu tiên dùng đường HTTPS riêng mà bên bạn đã vận hành.** Nếu hai máy khác mạng và chưa có đường kết nối, đề xuất dùng Tailscale Serve trên máy chủ rồi kết nối ASUS và thiết bị điều khiển vào cùng mạng riêng. Chỉ chuyển tiếp web tới cổng thực tế của dashboard. API và PostgreSQL tiếp tục nghe nội bộ. Popup hiện hiển thị sẵn địa chỉ máy chủ. Hai bên cần chốt cách đặt đúng URL HTTPS cho hai profile thử trước khi phát cho cả dàn. [Hướng dẫn triển khai](DEPLOY.md) · [Cách popup chọn địa chỉ](../extension/popup.js)

## Đối chiếu danh bạ trước khi nhập

Nhờ bên bạn chạy đối chiếu chỉ đọc theo **UID Facebook**. Cùng UID thì giữ mã B, lịch sử, trạng thái và liên kết đã ghép ở máy chủ. Nếu cùng mã B nhưng khác UID, đưa vào danh sách xung đột để hai bên đối chiếu. Điều này đặc biệt quan trọng với B8 và B9 đang có lịch sử. A là tài khoản mẹ, N là nguồn nội dung, B là tài khoản nhận việc.

Khi thống nhất kết quả, chỉ thêm UID còn thiếu ở trạng thái tắt và đối chiếu lại tên hiển thị. Nếu sheet đánh dấu *die* nhưng máy chủ vẫn đang giao việc, ghi mục đó vào nhóm chờ xử lý. Hồ sơ chỉ có tên người dùng được giữ trong danh sách chờ xác minh UID. Các số cần đối chiếu là **đã có + thêm mới + chờ xử lý = 29**. Năm đích mẫu nằm ngoài phép tính. Dữ liệu trao đổi chỉ cần tên hiển thị, UID hoặc tên người dùng, mã đối chiếu và trạng thái. Phiên Chrome, cookie, mật khẩu, 2FA và mã ghép ở lại nơi đang quản lý chúng.

## Phản hồi cần từ agent máy chủ

| Đề nghị bạn trả lời | Phía ASUS sẽ dùng để làm gì |
| --- | --- |
| Máy nào giữ database chính? Commit web/API đang chạy là gì? Đường HTTPS đã dùng được từ ASUS chưa? | Mở web từ ASUS và kiểm tra chế độ đăng nhập. Gửi địa chỉ nội bộ qua kênh vận hành riêng. |
| Dashboard đang có bao nhiêu UID trùng, bao nhiêu mã B xung đột? Hỗ trợ lưu hồ sơ chỉ có tên người dùng ở đâu? | Chốt danh sách thêm mới và các mục chờ xử lý trước lần ghi đầu tiên. |
| Connector 1.2.46 dùng được với bản API này không? Có chức năng giao việc chỉ đọc nào trả kết quả theo từng profile? | Chọn đúng phép thử. Nếu mới chỉ có tín hiệu online, ghi nhận đã kết nối và nêu riêng phần giao việc còn thiếu. |

Bạn có thể trả lời ngay dưới mục này bằng commit đang chạy, kết quả đối chiếu, phương án mạng và phép thử được hỗ trợ. Địa chỉ riêng và thông tin đăng nhập trao đổi qua kênh vận hành.

**Nghiệm thu đề xuất.** Từ cả hai máy, mở cùng URL và đối chiếu cùng danh sách. Sau đó ghép hai profile thử đã thống nhất, giao mỗi profile một việc chỉ đọc và kiểm tra kết quả trên web khớp mã việc, đích B, UID và thời điểm. Đóng một profile để kiểm tra dashboard báo mất kết nối đúng profile đó trong khi profile còn lại vẫn online. Chỉ mở rộng sau khi cả hai đạt. Nếu có lỗi, dừng ở hai profile thử và giữ nguyên các lô đang chạy trên máy chủ.
