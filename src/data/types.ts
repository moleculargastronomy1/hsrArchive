export type Category = 'trailblaze' | 'companion' | 'readable';
export type World =
  | 'space-station'
  | 'jarilo'
  | 'luofu'
  | 'penacony'
  | 'amphoreus'
  | 'paradise-astropolis';

export interface TextBlock {
  id: string;
  type: 'narration' | 'dialogue';
  speaker?: string;
  text: string;
}

export interface Chapter {
  id: string;
  title: string;
  parentId?: string;
  kind?: 'branch' | 'adventure';
  blocks: TextBlock[];
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
