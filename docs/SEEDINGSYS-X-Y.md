# Mã đầu việc X và Y trong SeedingSys

Bảng này diễn giải các mã trên ảnh bảng trắng để đối chiếu khi nhận yêu cầu giao việc. Mã X chỉ đầu việc của các tài khoản B. Mã Y chỉ đầu việc của AI Agent 1 hoặc AI Agent 2.

| Mã | Ai phụ trách | Bối cảnh | Đầu việc | Lời thoại và mục đích |
| --- | --- | --- | --- | --- |
| **X1** | Tài khoản B được giao | Tường B2 | Like bài viết trên tường B2. | Không có lời thoại. Mục đích ghi trên bảng là tăng chỉ số tương tác cho B2. |
| **X2** | Tài khoản B được giao | Nhóm Facebook mục tiêu | Xin vào nhóm và trả lời câu hỏi gia nhập nếu nhóm yêu cầu. | Dùng câu trả lời phù hợp với câu hỏi của nhóm. Mục đích là vào được nhóm mục tiêu. |
| **X3** | Tài khoản B được giao | Nhóm Facebook | Like và bình luận bài trong nhóm. | LLM soạn bình luận theo ngữ cảnh và tính cách của tài khoản B đang đóng vai. Bảng ghi mục đích là tạo tương tác và điều hướng dư luận. |
| **X4** | Tài khoản B được giao | Fanpage | Like bài, like bình luận và trả lời bình luận trên fanpage. | LLM soạn lời trả lời theo ngữ cảnh của bài hoặc nhánh bình luận. Bảng ghi mục đích là seeding trên fanpage. |
| **Y1** | AI Agent 1 | Facebook | Từ mẫu được giao, tìm các nhóm Facebook phù hợp và lập danh sách nhóm mục tiêu. | Không có lời thoại. Đầu ra là danh sách nhóm để người giao việc có thể dùng cho X2. |
| **Y2** | AI Agent 2 | Trang cá nhân khách hàng | Kết bạn rồi gửi tin nhắn. | LLM soạn tin nhắn theo sản phẩm cần bán. Mục đích là hỗ trợ bán hàng. |

## Dải tài khoản và cách đọc mã

- Các dòng X trên ảnh ghi dải dự kiến **B1–B40**. Dàn Chrome trên máy hiện tại được chỉ định dùng dải **B1–B20**. Khi nhận yêu cầu, đối chiếu mã B với tài khoản đã có trong SeedingSys trên máy đó.
- Nếu người giao việc nói **Y1 rồi X2**, Y1 tìm và lập danh sách nhóm, sau đó X2 dùng các nhóm được chọn để gửi yêu cầu gia nhập. **X3** là tương tác trong nhóm. **X4** là tương tác trên fanpage.
- Khi giao từng mã, người giao việc có thể chỉ định tài khoản B, link bài, link nhóm, fanpage hoặc mẫu cần dùng tùy đầu việc.

## Tần suất ghi trên ảnh

Các số dưới đây là ghi chú trên bảng trắng. Phạm vi của từng lượt do người giao việc chỉ định.

| Mã | Ghi chú đọc được |
| --- | --- |
| X1 | Ngẫu nhiên 10–20 giây. |
| X2 | Ngẫu nhiên 1–2 phút mỗi tài khoản. Dưới 50 nhóm mỗi ngày. |
| X3 | Ngẫu nhiên 1–2 phút mỗi nhóm. Dưới 100 nhóm mỗi ngày. |
| X4 | Ngẫu nhiên 30–90 giây. Phần giới hạn theo ngày trong ảnh chưa đọc rõ. |
| Y1 | Có ghi chú về thời điểm bắt đầu dự án. Phần lịch lặp trong ảnh chưa đọc rõ. |
| Y2 | Ghi chú theo ngày có chữ “lời mời”. Số lượng trong ảnh chưa đọc rõ. |
