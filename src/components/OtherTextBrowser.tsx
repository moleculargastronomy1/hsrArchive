import { useEffect, useState } from 'react';
import DialogueBrowser from './DialogueBrowser';
import { parseOtherCatalog, otherSectionPath, type OtherCatalog } from '../lib/other-text';
import {
  otherTextCategories,
  type OtherTextCategory,
  type OtherTextFilter,
} from '../lib/search-text';

export default function OtherTextBrowser({
  kind,
  groupId,
  sectionId,
  rowId,
  query,
  onScopeChange,
}: {
  kind: OtherTextCategory;
  groupId: string | null;
  sectionId: string | null;
  rowId: string | null;
  query: string;
  onScopeChange: (scope: string, kind: OtherTextFilter, query: string) => void;
}) {
  const [catalog, setCatalog] = useState<OtherCatalog>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(`${import.meta.env.BASE_URL}search/other-catalog.json`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('카테고리를 불러오지 못했습니다.');
        return parseOtherCatalog(await response.json());
      })
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [retry]);
  const groups = catalog?.groups.filter((g) => g.kind === kind) ?? [];
  const group = groups.find((g) => g.id === groupId);
  const section = group?.sections.find((s) => s.id === sectionId);
  const label = otherTextCategories.find((c) => c.id === kind)!.label;
  const link = (group?: string, section?: string) => '#' + otherSectionPath(kind, group, section);
  return (
    <>
      {error && (
        <div className="dialogue-status" role="alert">
          <p>{error}</p>
          <button className="button secondary" onClick={() => setRetry((n) => n + 1)}>
            다시 시도
          </button>
        </div>
      )}
      {group && (
        <nav className="category-tabs" aria-label="기타 카테고리 위치">
          <a href={link()}>{label} 목록</a>
          <a href={link(group.id)}>{group.title}</a>
        </nav>
      )}
      {group ? (
        <>
          <h2>{group.title}</h2>
          {section ? (
            <>
              <nav className="other-section-navigation" aria-label="대화 묶음 이동">
                {group.sections.map((s, index) => (
                  <a
                    key={s.id}
                    className={section.id === s.id ? 'active' : ''}
                    aria-current={section.id === s.id ? 'page' : undefined}
                    href={link(group.id, s.id)}
                  >
                    {index + 1}. {s.title}
                  </a>
                ))}
              </nav>
              <h3>{section.title}</h3>
              <DialogueBrowser
                key={section.file}
                file={'search/' + section.file}
                expectedHash={section.sha256}
                referenceCommit={catalog!.commit}
                localizationSource="search"
                contextPath={otherSectionPath(kind, group.id, section.id)}
                targetRowId={rowId ?? undefined}
              />
            </>
          ) : (
            <div className="other-category-grid" aria-label="대화 묶음">
              {group.sections.map((s, index) => (
                <a className="other-category-card" key={s.id} href={link(group.id, s.id)}>
                  <strong>
                    {index + 1}. {s.title}
                  </strong>
                  <small>{s.rows.toLocaleString()}줄</small>
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {groups.length > 0 && (
            <div className="other-category-grid" aria-label={`${label} 카테고리`}>
              {groups.map((g) => (
                <a className="other-category-card" key={g.id} href={link(g.id)}>
                  <strong>{g.title}</strong>
                  <small>{g.sections.length}개 묶음</small>
                </a>
              ))}
            </div>
          )}
          <DialogueBrowser
            initialQuery={query}
            initialScope="other"
            initialOtherKind={kind}
            onScopeChange={onScopeChange}
            global
          />
        </>
      )}
    </>
  );
}
