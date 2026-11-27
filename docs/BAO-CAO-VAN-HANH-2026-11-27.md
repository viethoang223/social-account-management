# SeedingSys · Báo cáo vận hành từ 25 đến 27/11/2026

Hai lô Instagram đã đăng được bài ảnh lên Facebook qua Chrome profile được ghép. Album đầu tiên của B8 đã có liên kết Facebook. Điểm nghẽn của B9 là bước chọn đối tượng xem ở màn tạo Reel. Kho đã có MP4 nhưng Facebook chưa nhận lệnh Đăng của Reel này trong 12 lần chuẩn bị. Bản 1.2.47 bổ sung lựa chọn dùng mặc định của Facebook khi connector không đọc được đối tượng xem.

## Hai lô đang chạy

Đối chiếu PostgreSQL trên máy chủ lúc **09:46 ngày 27/11/2026 (UTC+7)**. Cột “Đã đăng” chỉ tính bản ghi có trạng thái `PUBLISHED_VERIFIED` và liên kết Facebook. Liên kết chứng minh bài tồn tại. Quyền xem của người ngoài là một thuộc tính riêng.

| Lô nguồn → đích | Đã đăng | Media trong các bài đã xác minh | Công việc còn lại tại thời điểm kiểm tra |
| --- | ---: | --- | --- |
| N22 · james_7070 → B8 | 16/40 | 15 bài một ảnh và 1 album | Đã đọc đủ số lượng media nguồn cho 40/40 mục. Lô đang chạy, bài 17 đang chuẩn bị. |
| timphaam → B9 | 14/40 | 14 bài một ảnh | 38/40 mục đã có số lượng media nguồn. Bài 15 là Reel, dừng ở `FAILED_CONFIRMED / GAVE_UP_UI_UNEXPECTED`. Lô tạm dừng ở `PREVIOUS_UNVERIFIED`. |

Cả hai lô khi đó có **0 Reel có liên kết đã xác minh**. Số lần chuẩn bị một bài, số link Instagram đã tìm, số bài có đủ media và số bài Facebook đã đăng là bốn số đo khác nhau. Lịch hai lô đặt khoảng 10 phút mỗi bài, có sai số theo giây. Một lượt còn chờ xác minh có thể kéo dài khoảng cách thực tế.

**Cập nhật lúc 09:52.** B8 đã đạt 17/40, gồm 15 bài một ảnh và hai album. API đã nạp biến mới và B9 đã báo phiên bản 1.2.47. Sau khi kiểm tra 12 lượt trước đều dừng trước bước gửi, SeedingSys tiếp tục đúng bài 15 trên bản ghi cũ. Tại mốc này B9 đang chuẩn bị Reel, vẫn ở 14/40.

## Những gì người vận hành đã gặp

| Khu vực | Hiện tượng và nguyên nhân tìm được | Cách xử lý hoặc giới hạn còn lại |
| --- | --- | --- |
| Mở dashboard | Hướng dẫn gốc dùng cổng 3000, còn máy này dùng 3030 và API 3031. Mở đúng địa chỉ khi dịch vụ đã dừng vẫn không vào được. Dashboard từng hiện các mã mẫu và chữ “Đang bật” dù người dùng chưa thấy tài khoản thật. | Dùng `node scripts/server.mjs status` để kiểm tra dịch vụ. Khi supervisor đang chạy nền chỉ cần mở dashboard. Kiểm tra ghép UID, heartbeat và thời điểm kết nối của từng B để biết tài khoản nào thực sự nhận việc. Nguyên nhân màn hình trống ban đầu chưa đủ bằng chứng để quy cho PostgreSQL. |
| Đăng nhập, mã và thiết bị | Token dashboard, mã ghép profile và mã GitHub xác nhận thiết bị từng bị nhầm lẫn. Popup Chrome đóng khi chuyển cửa sổ làm mất dữ liệu vừa nhập. | Dashboard dùng token của máy chủ. Đích B cấp mã ghép riêng cho một profile. Popup có địa chỉ dashboard mặc định và giữ kết nối sau khi ghép. GitHub hiển thị mã ở ứng dụng khởi tạo đăng nhập. SSH không tham gia ghép Facebook. |
| Profile và UID | Mỗi phiên Facebook nằm trong một Chrome profile. Tên thư mục Chrome và mã B có thể khác nhau. Việc chỉ liệt kê được một phần profile gây hiểu nhầm rằng cả máy chỉ có từng ấy tài khoản. Đăng nhập lại ở trình duyệt mới có thể gặp checkpoint. | Ghép đúng UID với bản cài extension, kiểm tra heartbeat và bỏ qua profile đang bị yêu cầu xác minh. B6 từng online Facebook và có quyền extension nhưng thiếu phiên Instagram dùng được. B7 có phiên Instagram và đã tìm được 40 link. |
| Dàn A, danh sách B và nguồn | Dùng “A90” cho nguồn khiến người vận hành nhầm A là nguồn bài. Cố định B3 trong ví dụ làm các đích khác khó tìm. | A là tài khoản mẹ. A1–A20 ở máy Asus, A21–A40 là nhóm kế tiếp. N là nguồn nội dung, B là tài khoản nhận việc. Chọn B từ danh sách đã ghép. Với việc đọc Instagram, kiểm tra cả quyền đọc, phiên đăng nhập và B thực tế được giao. |
| Điện thoại và máy khác | Điện thoại mở localhost sẽ trỏ về chính điện thoại. Kết nối mạng riêng giúp thấy máy chủ nhưng không tự khởi động những Chrome profile đang đóng trên máy xa. | Điện thoại dùng URL HTTPS của dashboard qua Tailscale, kể cả khi khác Wi-Fi. Máy giữ profile nhận việc qua extension. Browser worker trên Windows có thể mở đúng profile theo ánh xạ cục bộ trong `.data/chrome-profiles.json`. Máy chỉ cài extension cần có Chrome đang chạy. |
| Triển khai Chrome | Máy thử Enterprise ngày 26/11 có 0 đích đã ghép. Profile truy cập được dừng ở xác minh điện thoại. Nhiều lần sửa ở máy vận hành phải yêu cầu tải lại extension trong từng profile. Số phiên bản và giao thức media đang báo về từng có lúc không khớp. | Kiểm tra phiên bản lẫn khả năng nhận media trong heartbeat. Với extension giải nén, pull Git rồi tải lại ngay trong profile cần dùng. Thử nghiệm Enterprise trên máy kia chưa chứng minh cài đặt tự động trên cả dàn. |
| Giao việc và Kho | “Lưu luồng” lưu cấu hình nên bấm xong không thấy bài đăng. Ở màn Nhập bài thủ công, dán URL Instagram vào “Nội dung chữ” chỉ lưu URL như caption. Trường giới hạn từng chặn 40 vì đặt tối đa 20. | Để lấy hàng loạt, dán URL profile ở màn Research, chọn số bài rồi xem kết quả theo mã B. Chọn các bài trong Kho để đăng theo lô. Màn Đăng bài mới dùng cho bài tự soạn. |
| Quét Instagram | Grid đầu tiên thường chỉ có 12 link. Những lần khác dừng ở 24, 29 hoặc 30 vì Instagram nạp thêm khi cuộn. Bộ hẹn giờ của tab nền và việc chạm đáy trước khi trang nạp thêm làm kết quả thiếu ổn định khi thu nhỏ Chrome. | Tiếp tục cùng lượt với các link đã lưu, cuộn và đọc phần vừa nạp, khử trùng theo link. B7 từng lấy đủ 40 khi Chrome thu nhỏ. Mốc 2 phút 44 giây là của bước **tìm link**, chưa bao gồm đọc caption, album, Reel hay bình luận của 40 bài. |
| Tốc độ nhận việc | Có lượt chờ khoảng 14–15 giây trước khi B nhận việc. Thời gian quét comment còn gồm mở bài, đọc trang tiếp và lưu kết quả. | Connector đã có cơ chế nhận việc sớm hơn. Phép thử trên hai bài ghi nhận nhanh hơn khoảng 43% ở lượt so trước đó. Chưa có phép đo chứng minh mức tăng này cho cả kho hoặc cho mọi Reel. B6 không hoàn tất phép đối chiếu nhịp 5–8 giây và 30 giây vì thiếu phiên Instagram. |
| Bình luận nguồn Instagram | Một bài lấy 8/15, bài khác 5/16. Chỉ đọc phản hồi đầu làm mất trang tiếp và các câu trả lời bên dưới bình luận cha. Tổng số Instagram hiển thị cũng không cho biết B có đọc được từng mục hay không. | Bổ sung phân trang và đọc trả lời. Đã ghi nhận bài đầu đủ 15/15. Ở lần đối chiếu được báo cáo, bài thứ hai còn thiếu 3 so với 16. Chưa có kết quả cuối chứng minh đủ 16/16. |
| Vai và bình luận Facebook | Luồng cũ đòi có bình luận gốc ngay cả khi chỉ muốn viết một bình luận mới. Reel dùng bảng bình luận khác với bài thường. Có lượt đã gửi nhưng hệ thống chưa tìm lại được link nên Kho chưa hiện Đã đăng. | Bình luận mới có thể soạn độc lập. Radar và danh bạ gắn vai với UID, duyệt xưng hô giữa người nói và người nghe. Đã bỏ tám trục mua hàng khỏi quy trình. X2 lưu kế hoạch. Trong Kho, duyệt nội dung và đưa vào hàng đợi. Câu trả lời theo kịch bản chờ link bình luận cha. Bản 1.2.4 có đối soát link. Mỗi máy mới vẫn cần ghép đúng UID trước khi dùng vai đã duyệt. |
| Ảnh và carousel | Ảnh nhập có lúc dùng bản hiển thị nhỏ hơn nguồn. Các mẫu cũ có kích thước 640 × 640 và 480 × 640. Có carousel từng chỉ lưu phần tử đầu nên Kho trông như đủ một ảnh. | Ưu tiên phiên bản ảnh lớn hơn mà Instagram cung cấp, duyệt từng phần tử và kiểm tra số lượng, thứ tự, loại tệp và checksum. Mẫu đọc lại trên B8 đạt 1440 × 1440 và 1440 × 1799. Facebook có thể nén tiếp. Những bài đã xuất bản giữ tệp của lượt đăng đó. |
| Video và album | Tìm thấy Reel hoặc ảnh bìa chưa đủ để đăng video. Một số lượt đầu chỉ có thumbnail. Album trộn ảnh và video cần manifest nhiều tệp. | Media Bridge lấy tệp video thực và lưu vào Kho. Đã kiểm tra một MP4 của lô B9 có âm thanh, 13.348.899 byte, 720 × 1280. Album B8 ở vị trí 16 có 10 ảnh. Đối chiếu media nguồn và liên kết Facebook riêng để biết phần nào đã hoàn tất. |
| Bản nháp và quyền xem | Bản 1.2.5 từng chèn caption hai lần nên dừng trước khi đăng. Facebook có nhiều giao diện cho ảnh, album và Reel. Riêng B9, bản trước 1.2.47 dừng vì không xác định được lựa chọn Công khai của Reel. | Bản 1.2.6 sửa chèn chữ. Connector kiểm tra lại caption, preview và tài khoản ngay trước khi gửi. Bản 1.2.47 cho quản trị viên bật ngoại lệ đối tượng xem riêng cho Reel theo hướng dẫn bên dưới. |
| Tab, RAM và đăng trùng | Tab tự động còn mở sau khi đăng làm tăng RAM. Đóng tab khi Facebook còn tải có thể làm hỏng bài. Có lượt đã qua bước gửi nhưng chưa lấy được liên kết, khiến lô đứng để chờ bài trước. | Connector theo dõi tab do chính nó mở, đợi upload kết thúc và dọn tab. Khi chưa rõ kết quả, đối soát bài cũ bằng đúng UID, caption, thời điểm và link. Không tạo lượt đăng thứ hai chỉ vì thiếu link. B8 đã tìm lại được bài ảnh đã gửi. |

## Quy tắc Reel từ 1.2.47

Biến trên **máy chạy API** là `REEL_ALLOW_UNVERIFIED_AUDIENCE`. Đặt trong `.env` của bản Windows hoặc `.env.core` của core Docker. Giá trị mặc định là `false`. Dùng `true` rồi nạp lại API để cho phép các đích có yêu cầu **Công khai** dùng mặc định tài khoản khi màn Reel không thể xác định lựa chọn. Tải lại SeedingSys Profile Connector **1.2.47** trong Chrome profile sẽ đăng. Không cần cấp mã ghép mới.

| Màn tạo Reel | SeedingSys xử lý khi bật biến |
| --- | --- |
| Đọc được Công khai | Kiểm tra caption và video, sau đó gửi như bình thường. |
| Đọc được Bạn bè, Chỉ mình tôi hoặc một quyền khác được nhận diện | Thử chọn Công khai. Nếu quyền vẫn sai ở lần kiểm tra cuối, dừng. |
| Không đọc được đối tượng xem | Gửi theo mặc định Facebook nếu UID, caption, MP4, bản nháp và quyền thực thi của lệnh đều hợp lệ. Lịch sử bài ghi “Đã gửi Reel theo mặc định của tài khoản. Chưa xác minh Công khai.” |
| Đã gửi nhưng chưa tìm ra bài | Tiếp tục đối soát lượt hiện tại. Chỉ xác nhận bài đã đăng khi có bằng chứng cho đúng bài. |

Tắt biến để trở về chế độ yêu cầu connector đọc được quyền xem. Bài chữ, ảnh, album, video thường và bình luận giữ quy tắc riêng. Việc bật biến không tự phát lại lệnh đã hết hạn hoặc mở lại một lô đang dừng.

## Đọc tiếp và kiểm tra bàn giao

- Kiểm tra kết nối, ghép đúng UID, tự mở Chrome và điều khiển qua điện thoại trong [hướng dẫn cho máy mới](../codex.md) và [hướng dẫn triển khai](DEPLOY.md).
- Xem bằng chứng và phạm vi của đợt triển khai trên máy khác trong [báo cáo Chrome Enterprise ngày 26/11](CHROME-ENTERPRISE-ROLLOUT.md).
- Xem cách duyệt vai, nhập lô Instagram và gửi bình luận trong [Phân vai và Radar](PERSONA-RADAR.md) và [Research và bình luận](RESEARCH-COMMENTS.md).
- Các thay đổi liên quan gồm [xác minh bình luận 1.2.4](https://github.com/viethoang223/social-account-management/commit/bf8ee75), [giữ media theo lô](https://github.com/viethoang223/social-account-management/commit/0673aa6), [chọn ảnh lớn hơn](https://github.com/viethoang223/social-account-management/commit/8ffdd45) và [đối soát bài đã gửi](https://github.com/viethoang223/social-account-management/commit/b723d97).
