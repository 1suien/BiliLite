import { db } from '@/db'
import { SAMPLE_TXT, buildSampleEpub, buildSamplePdf } from '@/lib/sample'
import { importBuffer } from '@/lib/import'

/**
 * 开发期种子数据：URL 带 ?seed=1 时灌三本示例书（TXT / EPUB / PDF），
 * 方便在浏览器里把三种阅读器、分页、目录、主题全部验一遍。
 */
export async function seedDemoBooks(force = false): Promise<number> {
  if (!force) {
    const count = await db.books.count()
    if (count > 0) return 0
  }
  try {
    await importBuffer(SAMPLE_TXT.title + '.txt', new TextEncoder().encode(SAMPLE_TXT.text).buffer as ArrayBuffer, 'text/plain')
    await importBuffer('岛上灯塔（EPUB 示例）.epub', await buildSampleEpub(), 'application/epub+zip')
    await importBuffer('MoDu 示例 PDF.pdf', buildSamplePdf(), 'application/pdf')
    console.info('[seed] 已灌入 3 本示例书')
    return 3
  } catch (e) {
    console.warn('[seed] 示例书灌入失败', e)
    throw e
  }
}
