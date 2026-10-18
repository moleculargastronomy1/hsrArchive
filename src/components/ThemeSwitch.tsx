import { Moon, Sun } from 'lucide-react';

export default function ThemeSwitch({
  theme,
  onChange,
}: {
  theme: 'dark' | 'light';
  onChange: (theme: 'dark' | 'light') => void;
}) {
  return (
    <div className="theme-switch" role="group" aria-label="화면 테마">
      <button
        type="button"
        aria-label="다크 모드"
        aria-pressed={theme === 'dark'}
        title="다크 모드"
        onClick={() => onChange('dark')}
      >
        <Moon size={14} />
        <span>다크</span>
      </button>
      <button
        type="button"
        aria-label="라이트 모드"
        aria-pressed={theme === 'light'}
        title="라이트 모드"
        onClick={() => onChange('light')}
      >
        <Sun size={14} />
        <span>라이트</span>
      </button>
    </div>
  );
}
