import { useRef, type ReactNode } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import {
  comparisonLanguages,
  localizationKey,
  type ComparisonLanguage,
  type LocalizationState,
} from '../lib/localization';
import type { DialogueRow } from '../lib/dialogue';

export function LanguageComparisonControls({
  label = '한국어 원문 · 선택지 포함',
  languages,
  onChange,
}: {
  label?: ReactNode;
  languages: ComparisonLanguage[];
  onChange: (languages: ComparisonLanguage[]) => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  return (
    <div className="comparison-toolbar">
      <span className="comparison-original">
        <Sparkles size={14} />
        {label}
      </span>
      <div className="comparison-actions" aria-label="비교 언어">
        {languages.map((id) => (
          <button
            className="comparison-chip"
            key={id}
            onClick={() => onChange(languages.filter((item) => item !== id))}
            aria-label={`${comparisonLanguages.find((item) => item.id === id)!.label} 비교 닫기`}
          >
            {comparisonLanguages.find((item) => item.id === id)!.label}
            <X size={12} />
          </button>
        ))}
        {languages.length < comparisonLanguages.length && (
          <details
            className="comparison-picker"
            ref={picker}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                picker.current!.open = false;
                picker.current?.querySelector('summary')?.focus();
              }
            }}
          >
            <summary>
              <Plus size={14} />
              언어 추가
            </summary>
            <div className="comparison-options" aria-label="추가할 비교 언어">
              {comparisonLanguages
                .filter((item) => !languages.includes(item.id))
                .map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      picker.current!.open = false;
                      picker.current?.querySelector('summary')?.focus();
                      onChange([...languages, item.id]);
                    }}
                  >
                    <span>{item.label}</span>
                    <small lang={item.id}>{item.native}</small>
                  </button>
                ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export function LocalizedPassage({
  row,
  language,
  states,
  retry,
}: {
  row: DialogueRow;
  language: ComparisonLanguage;
  states: Record<string, LocalizationState>;
  retry: () => void;
}) {
  const state = states[localizationKey(row, language)];
  const localized = state?.status === 'ready' ? state.rows.get(row.id) : undefined;
  const label = comparisonLanguages.find((item) => item.id === language)!.label;
  return (
    <section className="localized-passage" lang={language} aria-label={`${label} 원문`}>
      <span className="comparison-language-label" lang="ko">
        {label}
      </span>
      {!state ? (
        <p className="comparison-status" role="status" lang="ko">
          원문을 불러오는 중…
        </p>
      ) : state.status === 'error' ? (
        <div className="comparison-status" lang="ko" role="alert">
          <p>원문을 불러오지 못했습니다.</p>
          <button className="text-link" onClick={retry}>
            다시 시도
          </button>
        </div>
      ) : !localized ? (
        <p className="comparison-status" lang="ko">
          연결된 원문이 없습니다.
        </p>
      ) : (
        <>
          {localized.speaker && row.type !== 'choice' && <strong>{localized.speaker}</strong>}
          {row.type === 'choice' && <strong lang="ko">선택지</strong>}
          <p>{localized.text}</p>
        </>
      )}
    </section>
  );
}
