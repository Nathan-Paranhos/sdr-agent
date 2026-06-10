import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { log } from '../config/logger.js';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.resolve(process.cwd(), 'sdr-agent.db');
  const db = new Database(dbPath);
  
  // Enable WAL mode for safety with multiple active connections
  db.pragma('journal_mode = WAL');
  
  // Load sqlite-vec extension
  sqliteVec.load(db);
  
  // Create metadata and vector tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_items_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT UNIQUE NOT NULL,
      content_hash TEXT NOT NULL,
      category TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[1536] distance_metric=cosine
    );
  `);
  
  dbInstance = db;
  return dbInstance;
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (!env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY nao configurada para embeddings');
  }

  const url = `${env.OPENROUTER_BASE_URL.replace(/\/$/, '')}/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_REFERER || 'https://paranhos.dev',
      'X-Title': env.OPENROUTER_APP_TITLE || 'SDR Agent Group Manager'
    },
    body: JSON.stringify({
      model: 'openai/text-embedding-3-small',
      input: text.replace(/\n/g, ' ')
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ao gerar embeddings no OpenRouter: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as any;
  if (!data?.data?.[0]?.embedding) {
    throw new Error('Retorno invalido da API de embeddings do OpenRouter: ' + JSON.stringify(data));
  }

  return data.data[0].embedding;
}

async function getFilesRecursively(dir: string): Promise<string[]> {
  try {
    const subdirs = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      subdirs.map(async (subdir) => {
        const res = path.resolve(dir, subdir.name);
        return subdir.isDirectory() ? getFilesRecursively(res) : res;
      })
    );
    return files.flat();
  } catch (err) {
    // If directory doesn't exist yet, return empty list
    return [];
  }
}

function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function syncVectorDatabase(): Promise<void> {
  const db = getDb();
  const baseDir = path.resolve(process.cwd(), 'hermes-brain');
  
  // Ensure the directories exist
  await fs.mkdir(path.resolve(baseDir, '01_knowledge_graph'), { recursive: true });
  await fs.mkdir(path.resolve(baseDir, '05_postmortems'), { recursive: true });

  const folders = ['01_knowledge_graph', '05_postmortems'];
  const activePaths = new Set<string>();

  for (const folder of folders) {
    const folderPath = path.resolve(baseDir, folder);
    const allFiles = await getFilesRecursively(folderPath);
    
    for (const filePath of allFiles) {
      if (!filePath.endsWith('.md')) continue;

      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
      activePaths.add(relativePath);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const contentHash = calculateHash(content);

        // Check if already exists in metadata
        const existing = db.prepare('SELECT id, content_hash FROM vec_items_metadata WHERE file_path = ?').get(relativePath) as { id: number; content_hash: string } | undefined;

        if (existing) {
          if (existing.content_hash === contentHash) {
            continue;
          }
          // Changed: Delete old vector and metadata
          db.prepare('DELETE FROM vec_items WHERE id = ?').run(existing.id);
          db.prepare('DELETE FROM vec_items_metadata WHERE id = ?').run(existing.id);
          log.info({ relativePath }, 'Detectada alteracao no arquivo de conhecimento. Reindexando...');
        } else {
          log.info({ relativePath }, 'Detectado novo arquivo de conhecimento. Indexando...');
        }

        const embedding = await getEmbedding(content);
        const category = folder === '05_postmortems' ? 'postmortem' : 'knowledge';

        // Insert into metadata
        const result = db.prepare('INSERT INTO vec_items_metadata (file_path, content_hash, category) VALUES (?, ?, ?)').run(relativePath, contentHash, category);
        const newId = Number(result.lastInsertRowid);

        // Insert into vector table (convert float array to buffer representation of Float32Array)
        const vectorBuffer = Buffer.from(new Float32Array(embedding).buffer);
        db.prepare('INSERT INTO vec_items (id, embedding) VALUES (?, ?)').run(BigInt(newId), vectorBuffer);
        log.debug({ relativePath, newId }, 'Arquivo indexado no banco vetorial com sucesso');
      } catch (err) {
        log.error({ err, relativePath }, 'Erro ao gerar embedding ou salvar no banco vetorial');
      }
    }
  }

  // Cleanup files that no longer exist on disk
  const allStored = db.prepare('SELECT id, file_path FROM vec_items_metadata').all() as { id: number; file_path: string }[];
  for (const stored of allStored) {
    if (!activePaths.has(stored.file_path)) {
      log.info({ file_path: stored.file_path }, 'Removendo arquivo inexistente do banco vetorial');
      db.prepare('DELETE FROM vec_items WHERE id = ?').run(stored.id);
      db.prepare('DELETE FROM vec_items_metadata WHERE id = ?').run(stored.id);
    }
  }
}

export async function searchVectorIndex(queryText: string, category?: 'postmortem' | 'knowledge', limit: number = 3): Promise<string[]> {
  try {
    const embedding = await getEmbedding(queryText);
    const db = getDb();
    const queryBuffer = Buffer.from(new Float32Array(embedding).buffer);

    let rows: { file_path: string; distance: number }[] = [];

    if (category) {
      rows = db.prepare(`
        SELECT m.file_path, v.distance
        FROM vec_items v
        JOIN vec_items_metadata m ON v.id = m.id
        WHERE v.embedding MATCH ?
          AND m.category = ?
          AND v.distance < 0.7
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, category, limit) as any;
    } else {
      rows = db.prepare(`
        SELECT m.file_path, v.distance
        FROM vec_items v
        JOIN vec_items_metadata m ON v.id = m.id
        WHERE v.embedding MATCH ?
          AND v.distance < 0.7
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, limit) as any;
    }

    log.debug({ queryText, count: rows.length, results: rows.map(r => r.file_path) }, 'Pesquisa vetorial concluida');
    return rows.map((r) => r.file_path);
  } catch (err) {
    log.error({ err, queryText }, 'Erro ao realizar pesquisa vetorial');
    return [];
  }
}
