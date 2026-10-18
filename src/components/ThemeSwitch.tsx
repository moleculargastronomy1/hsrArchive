import nightIcon from '../../docs/reference-images/darkmodeicon/Night.webp';
import dayIcon from '../../docs/reference-images/darkmodeicon/DAY.webp';

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
        <img src={nightIcon} alt="" width={24} height={24} />
        <span>다크</span>
      </button>
      <button
        type="button"
        aria-label="라이트 모드"
        aria-pressed={theme === 'light'}
        title="라이트 모드"
        onClick={() => onChange('light')}
      >
        <img src={dayIcon} alt="" width={24} height={24} />
        <span>라이트</span>
      </button>
    </div>
  );
}
