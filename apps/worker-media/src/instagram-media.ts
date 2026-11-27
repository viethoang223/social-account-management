import { ConnectorError, type ReadConnector } from '@seedingsys/connectors-core';
import { sniffMime } from '@seedingsys/connectors-manual';
import { INSTAGRAM_RESEARCH_MEDIA_CONNECTOR, instagramMediaUrl } from '@seedingsys/domain';
import { prepareFacebookMp4 } from './video-bridge';

export const instagramMediaReader: ReadConnector = {
  key: INSTAGRAM_RESEARCH_MEDIA_CONNECTOR,
  version: '1.0.0',
  async readSince() {
    throw new ConnectorError('UNSUPPORTED', 'Dùng Post Research để đọc bài Instagram.');
  },
  async fetchMedia({ ref, sourceUrl }) {
    const url = instagramMediaUrl(sourceUrl ?? '');
    const kind = /^.+:(image|video):\d+$/.exec(ref)?.[1];
    if (!url || !kind) throw new ConnectorError('PERMANENT', 'Liên kết media Instagram không hợp lệ.');
    const limit = (kind === 'video' ? 120 : 25) * 1024 * 1024;
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(45_000) });
    if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new ConnectorError(response.status >= 500 ? 'TRANSIENT' : 'PERMANENT',
        'Không lấy được media Instagram hợp lệ (HTTP ' + response.status + ').');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ConnectorError('PERMANENT', 'Media Instagram vượt giới hạn dung lượng.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks, size);
    const mime = sniffMime(bytes);
    if (!mime?.startsWith(kind + '/') || (kind === 'video' && mime !== 'video/mp4')) {
      throw new ConnectorError('PERMANENT', 'Tệp Instagram không đúng định dạng ảnh hoặc MP4.');
    }
    return { bytes: kind === 'video' ? await prepareFacebookMp4(bytes, limit) : bytes, mime };
  },
};
