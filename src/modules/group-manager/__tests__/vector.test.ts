import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getDb, searchVectorIndex } from '../../../db/vector.js';

// Stub global fetch to return mock embedding response
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    data: [{ embedding: new Array(1536).fill(0.1) }]
  })
}));

describe('Vector Database & RAG Search', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec(`
      DELETE FROM vec_items;
      DELETE FROM vec_items_metadata;
    `);
  });

  it('inicializa as tabelas vetoriais corretamente e carrega extensao', () => {
    const db = getDb();
    const row = db.prepare('select vec_version() as version').get() as any;
    expect(row.version).toBeDefined();
    expect(typeof row.version).toBe('string');
  });

  it('retorna lista vazia de resultados se nao houver dados indexados', async () => {
    const results = await searchVectorIndex('Como subir docker EC2?', 'knowledge');
    expect(results).toEqual([]);
  });

  it('salva e recupera itens do banco vetorial', async () => {
    const db = getDb();
    
    // Insert mock metadata
    const result = db.prepare(
      "INSERT INTO vec_items_metadata (file_path, content_hash, category) VALUES (?, ?, ?)"
    ).run('hermes-brain/01_knowledge_graph/deploy/ci-cd.md', 'hash123', 'knowledge');
    const newId = Number(result.lastInsertRowid);

    // Insert mock vector (1536 dims, fill with 0.1)
    const mockVector = new Float32Array(new Array(1536).fill(0.1));
    const vectorBuffer = Buffer.from(mockVector.buffer);
    db.prepare('INSERT INTO vec_items (id, embedding) VALUES (?, ?)').run(BigInt(newId), vectorBuffer);

    // Search
    const results = await searchVectorIndex('deploy pipeline', 'knowledge', 1);
    expect(results.length).toBe(1);
    expect(results[0]).toBe('hermes-brain/01_knowledge_graph/deploy/ci-cd.md');
  });
});
