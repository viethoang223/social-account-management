import { readFile } from 'node:fs/promises';

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function uniqueValues(rows, key) {
  const values = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    if (!row[key]) continue;
    if (values.has(row[key])) duplicates.add(row[key]);
    values.add(row[key]);
  }
  return duplicates;
}

function cleanCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

async function main() {
  const [pcFile, asusFile] = process.argv.slice(2);
  if (!pcFile || !asusFile || process.argv.length !== 4) {
    throw new Error('Cách chạy: node scripts/doi-chieu-danh-ba.mjs <PC-Company.json> <ASUS.json>');
  }
  const pc = (await readJson(pcFile)).accounts;
  const asus = await readJson(asusFile);
  if (!Array.isArray(pc) || pc.length !== 22 || !Array.isArray(asus) || asus.length !== 29) {
    throw new Error('Đợt này cần đúng 22 hồ sơ trung tâm và 29 dòng ASUS sau khi bỏ hồ sơ mẫu.');
  }
  const byUid = new Map();
  const byCode = new Map();
  for (const record of pc) {
    const code = cleanCode(record?.code);
    if (!/^B[1-9]\d*$/.test(code) || typeof record.uid !== 'string' || !/^\d+$/.test(record.uid)
        || typeof record.enabled !== 'boolean' || byUid.has(record.uid) || byCode.has(code)) {
      throw new Error('Tệp trung tâm có hồ sơ sai định dạng hoặc trùng khóa.');
    }
    byUid.set(record.uid, record);
    byCode.set(code, record);
  }
  const rows = asus.map((row, index) => {
    if (!row || !Object.hasOwn(row, 'uid') || !Object.hasOwn(row, 'code') || !Object.hasOwn(row, 'retired')
        || (row.code !== null && typeof row.code !== 'string') || (row.uid !== null && typeof row.uid !== 'string')
        || (row.retired !== null && typeof row.retired !== 'boolean')) {
      throw new Error('Kiểm tra trường code, uid, retired ở dòng ASUS ' + (index + 1) + '. UID phải ở dạng văn bản.');
    }
    return { code: cleanCode(row.code), uid: (row.uid ?? '').trim(), retired: row.retired };
  });
  const duplicateUid = uniqueValues(rows, 'uid');
  const duplicateCode = uniqueValues(rows, 'code');
  const summary = { trung: 0, canThem: 0, conVuong: 0, tong: rows.length };
  const pending = [];
  for (const [index, row] of rows.entries()) {
    const matched = byUid.get(row.uid);
    const codeOwner = byCode.get(row.code);
    const reasons = [];
    if (!/^\d+$/.test(row.uid)) reasons.push('thiếu UID số');
    if (duplicateUid.has(row.uid)) reasons.push('trùng UID trong bảng ASUS');
    if (row.code && !/^B[1-9]\d*$/.test(row.code)) reasons.push('mã B cần đối chiếu');
    if (duplicateCode.has(row.code)) reasons.push('trùng mã B trong bảng ASUS');
    if (codeOwner && codeOwner.uid !== row.uid) reasons.push('mã B thuộc UID khác ở máy chủ');
    if (row.retired === null) reasons.push('ASUS chưa xác nhận trạng thái ngừng dùng');
    if (row.retired === true && matched?.enabled) reasons.push('ASUS ghi ngừng dùng nhưng máy chủ đang bật');
    if (reasons.length) {
      summary.conVuong++;
      pending.push({ dongASUS: index + 1, lyDo: reasons });
    } else if (matched) {
      summary.trung++;
    } else {
      summary.canThem++;
    }
  }
  console.log(JSON.stringify({ ...summary, dongCanXemTaiASUS: pending }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
