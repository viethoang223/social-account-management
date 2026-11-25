// FB Desk customer Radar scoring, carried over from caf1130.
const SCHEMA = 'desk.customer-profile/2';
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
// So khớp GIỮ DẤU khi bài có dấu ("đang" ≠ "đảng", "lừa đảo" không chứa "đạo"); chỉ so bản bỏ dấu khi người viết gõ không dấu.
const lower = (s) =>
  String(s || '')
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bound = (w) =>
  new RegExp('(^|[^\\p{L}\\p{N}])' + esc(w) + '(?=$|[^\\p{L}\\p{N}])', 'u');
const words = (list) =>
  list
    .map((x) => (Array.isArray(x) ? x : [x, 1]))
    .map(([w, k]) => ({ w, re: bound(lower(w)), reFold: bound(fold(w)), k }));
const hasMarks = (t) =>
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
    t,
  );
const match = (x, t) =>
  hasMarks(t) ? x.re.test(lower(t)) : x.reFold.test(fold(t));
const hits = (t, list) => (list || []).filter((x) => match(x, t));
const SENSITIVE = words([
  'bệnh',
  'ung thư',
  'điều trị',
  'bệnh viện',
  'mang thai',
  'có bầu',
  'sảy thai',
  'trầm cảm',
  'thuốc',
  'phật giáo',
  'công giáo',
  'tin lành',
  'nhà thờ',
  'đi chùa',
  'cầu nguyện',
  'đạo',
  'đảng',
  'chính phủ',
  'biểu tình',
  'bầu cử',
  'chính trị',
  'lgbt',
  'đồng tính',
  'chuyển giới',
]);
const sensitive = (t) => SENSITIVE.some((x) => match(x, t));
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const snippet = (t, max = 140) => {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const saturate = (x, half) => 100 * (1 - Math.exp(-x / half));
const recencyWeight = (d) =>
  d == null ? 0.6 : d <= 30 ? 1 : d <= 90 ? 0.8 : d <= 365 ? 0.5 : 0.3;
function count(v) {
  const s = fold(v).trim();
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(nghin|trieu|k|n|tr|m)?(?![a-z])/);
  if (!m) return null;
  let n = m[2]
    ? parseFloat(m[1].replace(',', '.'))
    : parseFloat(m[1].replace(/[.,]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/^(k|n|nghin)$/.test(m[2] || '')) n *= 1e3;
  if (/^(tr|trieu|m)$/.test(m[2] || '')) n *= 1e6;
  return Math.round(n);
}

// ===================== 1. RADAR NHÂN KHẨU =====================
// Mỗi trục là MỘT THANG ĐO; bands là các mốc định nghĩa (khớp nhóm của Sheet khi có cột "sheet").
const DEMO_AXES = [
  {
    id: 'age',
    label: 'Tuổi',
    sheet: 'Tuổi',
    definition:
      'Tuổi của khách quy ra thang 0–100 (15 tuổi = 0, 65 tuổi = 100).',
    bands: [
      [0, 14, 'Sinh viên', '≤ 22 tuổi'],
      [15, 40, 'Đi làm', '23–35 tuổi'],
      [41, 80, 'Trung niên', '36–55 tuổi'],
      [81, 100, 'Lớn tuổi', '> 55 tuổi'],
    ],
  },
  {
    id: 'income',
    label: 'Thu nhập',
    sheet: 'Thu nhập',
    definition:
      'Mức thu nhập suy từ công việc công khai và tình trạng việc làm.',
    bands: [
      [0, 30, 'Xin việc', 'chưa có/đang tìm việc, sinh viên'],
      [31, 70, 'Dân VP', 'nhân viên, chuyên viên, giáo viên, kỹ sư'],
      [
        71,
        100,
        'Thu nhập cao',
        'quản lý, chủ doanh nghiệp, nghề chuyên môn cao',
      ],
    ],
  },
  {
    id: 'class',
    label: 'Đẳng cấp',
    sheet: 'Đẳng cấp',
    definition:
      'Tầng lớp theo lối sống công khai: công việc tay chân, sinh hoạt phổ thông, hay du lịch nước ngoài/đồ hiệu/nhà xe cao cấp.',
    bands: [
      [0, 35, 'Lao động', 'công việc tay chân, ca kíp'],
      [36, 70, 'Bình thường', 'sinh hoạt phổ thông'],
      [71, 100, 'VIP', 'du lịch nước ngoài, đồ hiệu, nhà/xe cao cấp'],
    ],
  },
  {
    id: 'education',
    label: 'Học vấn',
    definition: 'Bậc học cao nhất công khai trên trang Giới thiệu.',
    bands: [
      [0, 35, 'Phổ thông', 'THCS/THPT'],
      [36, 55, 'Cao đẳng/Trung cấp', ''],
      [56, 80, 'Đại học', ''],
      [81, 100, 'Sau đại học', 'Thạc sĩ, Tiến sĩ'],
    ],
  },
  {
    id: 'urban',
    label: 'Đô thị',
    definition:
      'Mức đô thị của nơi đang sống (hoặc quê quán nếu không ghi nơi sống).',
    bands: [
      [0, 35, 'Nông thôn', ''],
      [36, 60, 'Tỉnh/thị xã', ''],
      [61, 85, 'Thành phố lớn', 'Đà Nẵng, Hải Phòng, Cần Thơ…'],
      [86, 100, 'Hà Nội/TP.HCM/nước ngoài', ''],
    ],
  },
  {
    id: 'family',
    label: 'Giai đoạn gia đình',
    definition:
      'Giai đoạn gia đình theo tình trạng quan hệ công khai và bài viết về con cái.',
    bands: [
      [0, 25, 'Độc thân', ''],
      [26, 55, 'Hẹn hò/Đính hôn', ''],
      [56, 80, 'Đã kết hôn', ''],
      [81, 100, 'Có con', ''],
    ],
  },
];
const BIG_CITY = words([
  'hà nội',
  'hanoi',
  'hồ chí minh',
  'ho chi minh',
  'sài gòn',
  'saigon',
  'tp.hcm',
  'tphcm',
  'hcm',
]);
const CITY = words([
  'đà nẵng',
  'hải phòng',
  'cần thơ',
  'nha trang',
  'huế',
  'vũng tàu',
  'biên hòa',
  'thủ đức',
]);
const ABROAD = words([
  'korea',
  'hàn quốc',
  'seoul',
  'nhật bản',
  'japan',
  'tokyo',
  'osaka',
  'singapore',
  'úc',
  'australia',
  'sydney',
  'melbourne',
  'mỹ',
  'usa',
  'california',
  'canada',
  'đức',
  'germany',
  'pháp',
  'paris',
  'london',
  'đài loan',
  'taiwan',
]);
const RURAL = words(['xã', 'thôn', 'huyện', 'làng', 'ấp']);
const HIGH_JOB = words([
  'giám đốc',
  'ceo',
  'founder',
  'co-founder',
  'chủ tịch',
  'chủ doanh nghiệp',
  'owner',
  'trưởng phòng',
  'trưởng nhóm',
  'manager',
  'director',
  'head of',
  'bác sĩ',
  'luật sư',
  'kiến trúc sư',
  'phó giám đốc',
]);
const OFFICE_JOB = words([
  'nhân viên',
  'chuyên viên',
  'kế toán',
  'giáo viên',
  'giảng viên',
  'kỹ sư',
  'engineer',
  'developer',
  'marketing',
  'sale',
  'sales',
  'thiết kế',
  'designer',
  'biên dịch',
  'phiên dịch',
  'điều dưỡng',
  'dược sĩ',
  'ngân hàng',
  'trợ lý',
  'assistant',
  'executive',
  'teacher',
  'lập trình',
  'trưởng ban',
]);
const LABOR = words([
  'công nhân',
  'phụ hồ',
  'thợ',
  'shipper',
  'giao hàng',
  'tài xế',
  'xe ôm',
  'bán hàng rong',
  'làm thuê',
  'tăng ca',
  'ca đêm',
  'bốc vác',
  'may mặc',
  'phụ bếp',
  'bồi bàn',
]);
const NO_JOB = words(['thất nghiệp', 'tìm việc', 'xin việc', 'cần việc']);
const LUX = words([
  ['du lịch', 1],
  ['resort', 1.5],
  ['nhật bản', 1],
  ['hàn quốc', 1],
  ['singapore', 1],
  ['châu âu', 1.5],
  ['paris', 1.5],
  ['dubai', 1.5],
  ['macbook', 1],
  ['mercedes', 2],
  ['bmw', 2],
  ['lexus', 2],
  ['porsche', 2.5],
  ['louis vuitton', 2],
  ['gucci', 2],
  ['chanel', 2],
  ['hermes', 2.5],
  ['rolex', 2.5],
  ['biệt thự', 2],
  ['penthouse', 2],
  ['golf', 2],
  ['fine dining', 2],
  ['business class', 2.5],
]);
const KID = words([
  'con mình',
  'con trai mình',
  'con gái mình',
  'bé nhà',
  'con nhà mình',
  'mẹ bỉm',
  'bố bỉm',
  'sinh nhật con',
  'con yêu',
  'hai con',
  'đón con',
  'đưa con',
]);
const secsOf = (about) =>
  (about || []).flatMap((t) =>
    (t.sections || []).map((s) => ({ tab: t.tab, ...s })),
  );
function demographicAxes(input, now) {
  const secs = secsOf(input.about),
    pick = (re) => secs.find((s) => re.test(fold(s.title)));
  const posts = (input.posts || []).filter(
    (p) => p && p.text && !sensitive(p.text),
  );
  const src = (s) =>
    'Giới thiệu › ' + (s?.tab || '') + ' › ' + (s?.title || '');
  const out = {};
  const set = (id, score, confidence, evidence, note = '') => {
    out[id] = {
      score: score == null ? null : clamp(score),
      confidence: score == null ? 'không có' : confidence,
      evidence,
      note:
        score == null ? note || 'Trang không công khai thông tin này.' : note,
    };
  };
  {
    const b = pick(/^(ngay sinh|sinh nhat|birthday|nam sinh|birth year)$/);
    const y = b && Number((b.values.join(' ').match(/(19|20)\d{2}/) || [])[0]);
    const hs = secs.find(
      (s) =>
        /trung hoc|high school/.test(fold(s.title)) &&
        /tot nghiep nam (\d{4})|class of (\d{4})/.test(
          fold(s.values.join(' ')),
        ),
    );
    const hy =
      hs &&
      Number(
        (
          fold(hs.values.join(' ')).match(
            /tot nghiep nam (\d{4})|class of (\d{4})/,
          ) || []
        )
          .slice(1)
          .find(Boolean),
      );
    const studying = secs.find(
      (s) =>
        /dai hoc|university|cao dang/.test(fold(s.title)) &&
        /(dang hoc|studies at)/.test(fold(s.values.join(' '))),
    );
    const toScore = (a) => ((a - 15) / 50) * 100;
    if (y)
      set('age', toScore(now.getFullYear() - y), 'cao', [
        {
          text: now.getFullYear() - y + ' tuổi (sinh năm ' + y + ')',
          why: src(b),
        },
      ]);
    else if (hy)
      set(
        'age',
        toScore(now.getFullYear() - hy + 18),
        'trung bình',
        [
          {
            text:
              'khoảng ' +
              (now.getFullYear() - hy + 18) +
              ' tuổi (tốt nghiệp THPT ' +
              hy +
              ')',
            why: src(hs),
          },
        ],
        'Ước tính từ năm tốt nghiệp THPT.',
      );
    else if (studying)
      set(
        'age',
        toScore(20),
        'thấp',
        [{ text: 'Đang học đại học/cao đẳng', why: src(studying) }],
        'Ước tính từ việc đang đi học.',
      );
    else set('age', null);
  }
  {
    const w = pick(/^(cong viec|work|noi lam viec)$/);
    const wt = w ? w.values.join(' · ') : '';
    const current =
      w &&
      !/^(tung lam|da lam|former|previously)/.test(fold(w.values[0] || ''));
    const ev = [];
    let score = null,
      conf = 'thấp';
    if (w && hits(wt, HIGH_JOB).length) {
      score = current ? 85 : 65;
      conf = current ? 'trung bình' : 'thấp';
      ev.push({
        text: snippet(wt),
        why: src(w) + (current ? '' : ' (công việc cũ)'),
      });
    } else if (w && hits(wt, OFFICE_JOB).length) {
      score = current ? 50 : 42;
      conf = current ? 'trung bình' : 'thấp';
      ev.push({
        text: snippet(wt),
        why: src(w) + (current ? '' : ' (công việc cũ)'),
      });
    } else if (w && hits(wt, LABOR).length) {
      score = 25;
      conf = 'trung bình';
      ev.push({ text: snippet(wt), why: src(w) });
    }
    const nojob = posts.filter(
      (p) =>
        hits(p.text, NO_JOB).length && (p.ageDays == null || p.ageDays <= 180),
    );
    if (nojob.length && (score == null || !current)) {
      score = 15;
      conf = nojob.length > 1 ? 'trung bình' : 'thấp';
      ev.unshift({
        text: snippet(nojob[0].text),
        why:
          'bài gần đây: ' +
          hits(nojob[0].text, NO_JOB)
            .map((x) => x.w)
            .join(', '),
      });
    }
    if (score == null && w) {
      score = 45;
      conf = 'thấp';
      ev.push({
        text: snippet(wt),
        why: src(w) + ' (không rõ loại công việc)',
      });
    }
    set(
      'income',
      score,
      conf,
      ev,
      score == null ? 'Trang không công khai công việc.' : '',
    );
  }
  {
    let pos = 0,
      lab = 0;
    const ev = [];
    for (const p of posts) {
      const w = recencyWeight(p.ageDays),
        h = hits(p.text, LUX),
        l = hits(p.text, LABOR);
      if (h.length) {
        const s = h.reduce((a, x) => a + x.k, 0) * w;
        pos += s;
        ev.push({
          text: snippet(p.text),
          why: 'lối sống: ' + h.map((x) => x.w).join(', '),
          weight: s,
        });
      }
      if (l.length) {
        const s = l.length * 1.5 * w;
        lab += s;
        ev.push({
          text: snippet(p.text),
          why: 'lao động: ' + l.map((x) => x.w).join(', '),
          weight: -s,
        });
      }
    }
    const job = out.income?.score;
    if (!ev.length && job == null && posts.length < 5)
      set(
        'class',
        null,
        '',
        [],
        'Chưa đủ bài viết công khai để đánh giá lối sống.',
      );
    else {
      let score = 50 + saturate(pos, 4) * 0.45 - saturate(lab, 3) * 0.4;
      if (job != null) score = score * 0.7 + job * 0.3;
      ev.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      set(
        'class',
        score,
        ev.length >= 3 ? 'trung bình' : 'thấp',
        ev.slice(0, 4).map(({ text, why }) => ({ text, why })),
        ev.length
          ? ''
          : 'Không thấy dấu hiệu lối sống đặc biệt trong ' +
              posts.length +
              ' bài; xếp mức phổ thông.',
      );
    }
  }
  {
    const all = secs.filter((s) =>
      /dai hoc|cao hoc|university|college|truong|trung hoc|high school|hoc van|education/.test(
        fold(s.title),
      ),
    );
    const t = fold(
      all.map((s) => s.title + ' ' + s.values.join(' ')).join(' | '),
    );
    const level = /thac si|tien si|cao hoc|master|phd|mba/.test(t)
      ? 90
      : /dai hoc|university|hoc vien/.test(t)
        ? 68
        : /cao dang|trung cap|college/.test(t)
          ? 45
          : /thpt|trung hoc|high school|thcs/.test(t)
            ? 25
            : null;
    set(
      'education',
      level,
      'cao',
      all
        .slice(0, 2)
        .map((s) => ({ text: snippet(s.values.join(' · ')), why: src(s) })),
    );
  }
  {
    const live = pick(
        /^(song tai|tinh\/thanh pho hien tai|thanh pho hien tai|current city|dia chi|vi tri)$/,
      ),
      home = pick(/^(que quan|hometown)$/),
      s = live || home;
    const v = s ? s.values.join(' ') : '';
    const score = !s
      ? null
      : hits(v, ABROAD).length || hits(v, BIG_CITY).length
        ? 92
        : hits(v, CITY).length
          ? 75
          : hits(v, RURAL).length
            ? 25
            : 48;
    set(
      'urban',
      score,
      live ? 'cao' : 'thấp',
      s
        ? [
            {
              text: v,
              why:
                src(s) + (live ? '' : ' (quê quán, không phải nơi đang sống)'),
            },
          ]
        : [],
    );
  }
  {
    const r = pick(
      /^(moi quan he|tinh trang moi quan he|relationship|tinh trang hon nhan)$/,
    );
    const rv = r ? fold(r.values.join(' ')) : '';
    let score = /da ket hon|married/.test(rv)
      ? 70
      : /dinh hon|engaged/.test(rv)
        ? 50
        : /hen ho|in a relationship/.test(rv)
          ? 38
          : /doc than|single/.test(rv)
            ? 12
            : null;
    const ev = r ? [{ text: r.values.join(' '), why: src(r) }] : [];
    const kids = posts.filter((p) => hits(p.text, KID).length);
    if (kids.length) {
      score = Math.max(score ?? 0, kids.length >= 2 ? 90 : 84);
      ev.unshift({
        text: snippet(kids[0].text),
        why:
          'bài về con: ' +
          hits(kids[0].text, KID)
            .map((x) => x.w)
            .join(', '),
      });
    }
    set(
      'family',
      score,
      kids.length >= 2 || r ? 'trung bình' : 'thấp',
      ev.slice(0, 3),
    );
  }
  return out;
}

// ===================== 2. RADAR TÍNH CÁCH =====================
// Nét thể hiện QUA CÁCH VIẾT trên bài công khai (không phải chẩn đoán tâm lý). 4 nét đầu là nhóm "Cá tính" của Sheet.
const TRAIT_AXES = [
  {
    id: 'naive',
    label: 'Ngây thơ',
    sheet: 'Ngây thơ',
    definition: 'Hồn nhiên, dễ tin, hay hỏi đơn giản, giọng dễ thương.',
    low: 'Viết chín chắn, ít hỏi.',
    high: 'Nhiều "hihi/huhu/ạ", hỏi ngây ngô, emoji dễ thương.',
    cues: words([
      ['hihi', 1.5],
      ['hehe', 1],
      ['huhu', 1.5],
      ['dễ thương', 1.5],
      ['cute', 1.5],
      ['xinh quá', 1],
      ['có ai biết', 1],
      ['thật không', 1],
      ['ngại quá', 1],
      ['ui', 1],
      ['nè', 0.7],
      ['nha', 0.4],
      ['ạ', 0.4],
    ]),
    emoji: /[🥺🥰😊🤗💕💖🌸🐰🎀]/gu,
  },
  {
    id: 'knowledgeable',
    label: 'Hiểu biết',
    sheet: 'Hiểu biết',
    definition: 'Chia sẻ kiến thức, phân tích, kinh nghiệm; viết có lập luận.',
    low: 'Ít nội dung kiến thức.',
    high: 'Bài dài, có phân tích, số liệu, mẹo, kinh nghiệm.',
    cues: words([
      ['kiến thức', 2],
      ['phân tích', 2],
      ['kinh nghiệm', 1.5],
      ['nghiên cứu', 2],
      ['theo mình', 1],
      ['lưu ý', 1.5],
      ['bí quyết', 1.5],
      ['mẹo', 1],
      ['so sánh', 1.5],
      ['nguyên nhân', 1.5],
      ['giải pháp', 1.5],
      ['tại sao', 1],
      ['bởi vì', 0.7],
      ['thứ nhất', 1.5],
      ['tóm lại', 1.5],
    ]),
  },
  {
    id: 'assertive',
    label: 'Cá tính mạnh',
    sheet: 'Cá tính mạnh',
    definition: 'Quan điểm rõ ràng, dám nói thẳng, phản biện.',
    low: 'Tránh tranh luận, ít nêu quan điểm.',
    high: 'Hay khẳng định, phản bác, nói thẳng, nhiều "!!".',
    cues: words([
      ['quan điểm', 1.5],
      ['nói thật', 1.5],
      ['thẳng thắn', 2],
      ['không đồng ý', 2],
      ['phải nói', 1.5],
      ['vô lý', 1.5],
      ['sai', 1],
      ['dẹp', 1.5],
      ['tôi nghĩ', 1],
      ['mình nghĩ', 0.7],
      ['chắc chắn', 1],
      ['tuyệt đối', 1.5],
      ['xin lỗi nhưng', 1.5],
    ]),
    bang: true,
  },
  {
    id: 'goofy',
    label: 'Ngốc/Ngã cây',
    sheet: 'Ngốc/Ngã cây',
    definition: 'Hài hước tự trào, vụng về đáng yêu, hay đùa và "tấu hề".',
    low: 'Nghiêm túc.',
    high: 'Nhiều "haha/kkk/=))", kể chuyện vụng về, đùa chính mình.',
    cues: words([
      ['haha', 1],
      ['hahaha', 1.2],
      ['kkk', 1.2],
      ['=))', 1.5],
      [':))', 1],
      ['toang', 1.5],
      ['quê', 1],
      ['ngáo', 1.5],
      ['tấu hề', 2],
      ['lầy', 1.5],
      ['xỉu', 1],
      ['cười xỉu', 2],
      ['ngố', 1.5],
      ['hài', 1],
    ]),
    emoji: /[😂🤣😆😅🙃🤡]/gu,
  },
  {
    id: 'extravert',
    label: 'Hướng ngoại',
    definition: 'Thích gặp gỡ, đi chơi, hoạt động nhóm.',
    low: 'Bài chủ yếu một mình, ít sự kiện.',
    high: 'Đi chơi, tụ tập, gắn thẻ bạn bè, check-in thường xuyên.',
    cues: words([
      ['đi chơi', 1.5],
      ['tụ tập', 2],
      ['cả hội', 2],
      ['hội bạn', 1.5],
      ['team', 1],
      ['party', 2],
      ['gặp gỡ', 1.5],
      ['cafe', 0.7],
      ['cà phê', 0.7],
      ['offline', 2],
      ['sự kiện', 1.5],
      ['đang ở', 1],
      ['cùng với', 1],
      ['với các bạn', 1.5],
    ]),
  },
  {
    id: 'expressive',
    label: 'Bộc lộ cảm xúc',
    definition: 'Thể hiện tâm trạng, cảm xúc cá nhân trên mạng.',
    low: 'Ít cảm xúc, chủ yếu thông tin.',
    high: 'Nhiều tâm trạng, emoji, dấu cảm thán.',
    cues: words([
      ['buồn', 1.5],
      ['vui quá', 1.5],
      ['hạnh phúc', 1.5],
      ['nhớ', 1],
      ['mệt', 1],
      ['khóc', 1.5],
      ['cô đơn', 2],
      ['tâm trạng', 2],
      ['xúc động', 2],
      ['biết ơn', 1],
      ['tủi', 2],
    ]),
    emoji: /\p{Extended_Pictographic}/gu,
    bang: true,
  },
  {
    id: 'driven',
    label: 'Cầu tiến',
    definition: 'Quan tâm học tập, sự nghiệp, mục tiêu và tự phát triển.',
    low: 'Ít nói về học tập, công việc.',
    high: 'Học, thi chứng chỉ, dự án, mục tiêu, khởi nghiệp.',
    cues: words([
      ['học', 0.7],
      ['thi', 0.7],
      ['chứng chỉ', 2],
      ['band', 1.5],
      ['dự án', 1.5],
      ['sự nghiệp', 2],
      ['mục tiêu', 2],
      ['kpi', 1.5],
      ['cố gắng', 1],
      ['nỗ lực', 1.5],
      ['khởi nghiệp', 2],
      ['thăng tiến', 2],
      ['khóa học', 1.5],
      ['tự học', 2],
      ['phát triển bản thân', 2.5],
    ]),
  },
  {
    id: 'family_care',
    label: 'Chăm lo gia đình',
    definition: 'Mức nhắc tới và chăm lo cho gia đình trong bài viết.',
    low: 'Hiếm khi nhắc gia đình.',
    high: 'Thường xuyên nói về bố mẹ, vợ/chồng, con cái.',
    cues: words([
      ['bố mẹ', 1.5],
      ['ba mẹ', 1.5],
      ['mẹ mình', 1.5],
      ['bố mình', 1.5],
      ['gia đình', 1.5],
      ['vợ', 1],
      ['chồng', 1],
      ['ông bà', 1.5],
      ['nhà mình', 1],
      ['về quê', 1],
      ['cả nhà', 1],
    ]),
  },
];
function traitAxes(input) {
  const posts = (input.posts || []).filter(
    (p) => p && p.text && !sensitive(p.text),
  );
  const out = {};
  for (const a of TRAIT_AXES) {
    let pos = 0;
    const ev = [];
    posts.forEach((p) => {
      const w = recencyWeight(p.ageDays),
        h = hits(p.text, a.cues);
      let s = h.reduce((t, x) => t + x.k, 0);
      const why = h.map((x) => x.w);
      if (a.emoji) {
        const e = (p.text.match(a.emoji) || []).length;
        if (e) {
          s += Math.min(e, 6) * 0.4;
          why.push(e + ' emoji');
        }
      }
      if (a.bang) {
        const b = (p.text.match(/!{2,}/g) || []).length;
        if (b) {
          s += b * 0.6;
          why.push('"!!" ×' + b);
        }
      }
      if (a.id === 'knowledgeable' && p.text.length > 600) {
        s += 1.5;
        why.push('bài dài ' + p.text.length + ' ký tự');
      }
      if (s > 0) {
        pos += s * w;
        ev.push({
          text: snippet(p.text),
          why: why.join(', '),
          weight: +(s * w).toFixed(2),
        });
      }
    });
    ev.sort((x, y) => y.weight - x.weight);
    const n = ev.length;
    const score = n
      ? clamp(saturate(pos / Math.max(1, Math.sqrt(posts.length / 5)), 4))
      : posts.length >= 10
        ? 10
        : null;
    out[a.id] = {
      score,
      confidence:
        score == null
          ? 'không có'
          : n >= 4
            ? 'cao'
            : n >= 2
              ? 'trung bình'
              : 'thấp',
      evidence: ev.slice(0, 4).map(({ text, why }) => ({ text, why })),
      note:
        score == null
          ? 'Chưa đủ bài viết công khai (cần ít nhất 1 bài có dấu hiệu, hoặc 10 bài để kết luận "thấp").'
          : n
            ? ''
            : 'Không thấy dấu hiệu trong ' + posts.length + ' bài.',
    };
  }
  return out;
}

export function buildRadar(input, now = new Date()) {
  return {
    schema: SCHEMA,
    url: input.url,
    name: String(input.name || '').slice(0, 120),
    analyzedAt: now.toISOString(),
    postsRead: input.posts.length,
    demographic: demographicAxes(input, now),
    personality: traitAxes(input),
  };
}
