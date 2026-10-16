export type Category = 'trailblaze' | 'simulation' | 'codex' | 'books';
export type World =
  | 'space-station'
  | 'jarilo'
  | 'luofu'
  | 'penacony'
  | 'amphoreus'
  | 'paradise-astropolis'
  | 'simulated-universe'
  | 'universe';

export interface TextBlock {
  id: string;
  type: 'narration' | 'dialogue';
  speaker?: string;
  text: string;
}

export interface Chapter {
  id: string;
  upstreamChapterId?: number;
  upstreamManaged?: boolean;
  bwikiManaged?: boolean;
  title: string;
  group?: string;
  collection?: 'bookshelf' | 'document';
  parentId?: string;
  kind?: 'branch' | 'adventure';
  intro?: boolean;
  aliases?: string[];
  contentNote?: string;
  blocks: TextBlock[];
  content?: {
    file: string;
    rows: number;
    missing: number;
    sourceIds: string[];
    textReferenceCommit?: string;
  };
}

export interface ArchiveEntry {
  id: string;
  title: string;
  subtitle: string;
  arcLabel?: string;
  description: string;
  category: Category;
  world: World;
  order: number;
  language: 'ko-KR';
  tags: string[];
  source:
    | { kind: 'demo'; note: string }
    | { kind: 'extracted'; version: string; sourceIds: string[] };
  chapters: Chapter[];
}
