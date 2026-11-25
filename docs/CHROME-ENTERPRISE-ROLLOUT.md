# Báo cáo triển khai SeedingSys trên nhiều profile Chrome

Ngày 26/11/2026 · Bản kiểm tra `fe43fc6` · SeedingSys Profile Connector **1.2.0**

## Kết quả kiểm tra

| Hạng mục | Trạng thái |
| --- | --- |
| Dashboard và API | Chạy cục bộ. Dashboard có **0 tài khoản đích** tại thời điểm kiểm tra. |
| Chrome và Facebook | Công cụ kiểm tra truy cập được **1 profile Chrome**. Facebook chuyển trang cá nhân sang bước xác minh số điện thoại bằng SMS hoặc WhatsApp. Chưa xác minh được UID nào và chưa nhập đích nào. Kết quả này chỉ bao gồm profile mà công cụ truy cập được. |
| Cài và ghép extension | Chưa xác nhận cài hoặc ghép thành công trên máy thử. Bản trong repo dùng extension giải nén. Dashboard nhập tối đa **200 UID/lượt** và cấp mã ghép riêng cho từng đích. |
| Môi trường Windows | Kết quả `dsregcmd /status` cho thấy máy chưa tham gia domain hoặc Entra ID. Các vị trí chính sách Chrome cục bộ đã kiểm tra chưa có giá trị đăng ký Chrome Enterprise Core hay chính sách cài extension tương ứng. Chưa xác nhận trạng thái đăng ký trong Google Admin Console. |

Luồng hiện tại được mô tả trong [hướng dẫn ghép extension](https://github.com/viethoang223/social-account-management/blob/fe43fc6/docs/EXTENSION-1.0.md). Chủ tài khoản cần hoàn tất xác minh trực tiếp trên Facebook. Sau đó, xác nhận UID của từng tài khoản được giao, nhập lô UID vào dashboard và kiểm tra trạng thái ghép khi profile báo kết nối.

## Đề xuất cấu hình Chrome Enterprise Core

Chrome Enterprise Core có thể triển khai và cập nhật extension tập trung. Ghép tài khoản Facebook vào SeedingSys vẫn theo cơ chế của ứng dụng. Nên chạy thử trên **một máy Windows dành riêng, với hai profile được phép vận hành**, vì chính sách theo trình duyệt có thể áp dụng cho nhiều người dùng mở Chrome trên máy đã đăng ký. [Hướng dẫn đăng ký Chrome Enterprise Core](https://support.google.com/chrome/a/answer/9301891?hl=en)

1. **Tạo phạm vi thí điểm.** Trong Google Admin Console, tạo OU con `SeedingSys Pilot`. Vào **Chrome browser → Managed browsers** và tạo mã đăng ký cho OU đó. Áp dụng chính sách `CloudManagementEnrollmentToken` ở cấp máy bằng GPO, MDM hoặc tệp đăng ký Windows do Admin Console cung cấp. Dùng bản Chrome cài ở cấp hệ thống. Khởi động lại Chrome và xác nhận máy xuất hiện đúng OU. [Đăng ký trình duyệt Windows](https://support.google.com/chrome/a/answer/9301891?hl=en)
2. **Chuẩn bị kênh phát hành.** Nếu tổ chức có kênh Chrome Web Store riêng, phát hành nội bộ và lấy extension ID từ listing. Với phương án tự lưu trữ, đóng gói và ký CRX, giữ nguyên khóa ký qua các phiên bản, rồi phục vụ gói và manifest cập nhật qua HTTPS. Xác nhận ID của bản đóng gói và thiết lập URL cập nhật cho các lần phát hành sau. Chrome trên Windows yêu cầu môi trường doanh nghiệp được quản lý để tự động cài extension tự lưu trữ. [Phát hành nội bộ](https://developer.chrome.com/docs/webstore/cws-enterprise) · [Điều kiện tự lưu trữ](https://developer.chrome.com/docs/extensions/how-to/distribute) · [Chính sách cài bắt buộc](https://chromeenterprise.google/policies/extension-install-forcelist/)
3. **Chỉ bật cài tự động trong OU thử nghiệm.** Vào **Chrome browser → Apps & extensions → Users & browsers**, chọn `SeedingSys Pilot` và thêm extension. Dùng **Add Chrome app or extension by ID → From a custom URL** nếu tự lưu trữ, rồi nhập URL manifest cập nhật. Đặt **Force install**. Trên máy thử, kiểm tra chính sách có hiệu lực ở `chrome://policy` và xác nhận đúng tên, ID, phiên bản trong `chrome://extensions` ở cả hai profile. [Thêm extension theo ID](https://support.google.com/chrome/a/answer/6177447?hl=en) · [Cài đặt tự động](https://support.google.com/chrome/a/answer/6306504?hl=en)
4. **Ghép hai profile bằng luồng hiện tại.** Nhập UID đã xác minh, cấp một mã riêng cho mỗi đích và ghép bằng popup. Dùng `http://localhost:3000` khi dashboard nằm trên cùng máy, hoặc URL HTTPS mà các máy thử truy cập được khi dùng dashboard chung. Giữ đích tắt trong lúc thử kết nối. Kiểm tra hai profile hiện đúng mã đích và khi một profile đóng hoặc đổi tài khoản, đúng đích đó mất trạng thái kết nối.
5. **Thử cập nhật trước khi mở rộng.** Xác nhận bản cập nhật giữ nguyên ID và kết nối của hai profile. Khi chuyển từ bản giải nén sang bản đóng gói có ID khác, chuẩn bị cấp lại mã cho các đích cần chuyển vì cấu hình lưu riêng theo extension ID. Nếu sai phạm vi cài đặt hoặc ghép sai UID, dừng mở rộng, tắt đích liên quan và điều chỉnh chính sách của OU thử nghiệm.

## Thay đổi SeedingSys để giảm thao tác ghép

- **Điền sẵn URL dashboard.** Thêm `storage.managed_schema` vào manifest và đọc `dashboardUrl` qua `chrome.storage.managed`. Bản 1.2.0 hiện lưu cấu hình do người dùng nhập trong popup. Chính sách chỉ cần chứa URL và cấu hình dùng chung. Mã ghép và mã admin cần được cấp qua luồng riêng. [Schema cấu hình extension](https://developer.chrome.com/docs/extensions/reference/manifest/storage)
- **Rút bước ghép thành một lần xác nhận.** Bổ sung luồng quản trị duyệt danh sách UID và phát mã kích hoạt một lần, có hạn, cho từng đích. Extension đổi mã lấy thông tin kết nối riêng của bản cài sau khi xác minh UID hiện tại. Từ chối UID sai, mã đã dùng hoặc hết hạn, và tài khoản đang bị Facebook yêu cầu xác minh. Ghi nhận kết quả ghép và hỗ trợ thu hồi từng đích.
- **Tiêu chí nghiệm thu.** Hai profile cài được qua chính sách, nhận đúng phiên bản, ghép đúng hai UID và cập nhật được mà vẫn giữ kết nối. Thử thêm ca sai UID và ca Facebook yêu cầu xác minh. Cả hai cần dừng ở trạng thái chờ xử lý, không kích hoạt đích.

**Đề nghị triển khai:** dùng Chrome Enterprise Core cho cài đặt và cập nhật trước. Kiểm chứng luồng ghép hiện tại trên hai profile, sau đó mới bổ sung cấu hình URL và mã kích hoạt một lần.
