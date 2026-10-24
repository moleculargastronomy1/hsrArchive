import type { OtherTextCategory } from './search-text';

export interface OtherSection {
  id: string;
  title: string;
  file: string;
  rows: number;
  sha256: string;
}
export interface OtherGroup {
  id: string;
  kind: OtherTextCategory;
  title: string;
  sections: OtherSection[];
}
export interface OtherCatalog {
  schema: 'hsr-other-catalog.v1';
  commit: string;
  groups: OtherGroup[];
  speakers: Record<string, { text: string; name: string }>;
}
export function parseOtherCatalog(value: unknown): OtherCatalog {
  const data = value as OtherCatalog;
  const id = /^(npc|interaction|message|mail|loading)-p\d+$/;
  const safeLabel = (text: unknown) =>
    typeof text === 'string' && !!text.trim() && !/[\u3400-\u9fff]/.test(text);
  if (
    data?.schema !== 'hsr-other-catalog.v1' ||
    !/^[a-f0-9]{40}$/.test(data.commit) ||
    !Array.isArray(data.groups) ||
    new Set(data.groups.map((g) => g.id)).size !== data.groups.length ||
    data.groups.some(
      (g) =>
        !id.test(g.id) ||
        !g.id.startsWith(g.kind + '-p') ||
        !safeLabel(g.title) ||
        !Array.isArray(g.sections) ||
        new Set(g.sections.map((s) => s.id)).size !== g.sections.length ||
        g.sections.some(
          (s) =>
            !/^s[a-f0-9]{16}$/.test(s.id) ||
            !safeLabel(s.title) ||
            s.file !== `other/other-${g.id}--${s.id}.json` ||
            !/^[a-f0-9]{64}$/.test(s.sha256) ||
            !Number.isSafeInteger(s.rows) ||
            s.rows < 1,
        ),
    ) ||
    !data.speakers ||
    Object.entries(data.speakers).some(
      ([key, r]) => !/^\d+$/.test(key) || typeof r.text !== 'string' || !safeLabel(r.name),
    )
  )
    throw Error('기타 분류의 자료 형식을 확인해 주세요.');
  return data;
}
export function otherSectionPath(
  kind: OtherTextCategory,
  group?: string,
  section?: string,
  row?: string,
) {
  const params = new URLSearchParams({ scope: 'other', kind });
  if (group) params.set('group', group);
  if (section) params.set('section', section);
  if (row) params.set('row', row);
  return '/search?' + params.toString();
}
