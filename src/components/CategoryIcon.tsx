import type { Category } from '../data/types';
import { LibraryBig } from 'lucide-react';
import trailblaze from '../../docs/reference-images/개척 임무 아이콘.webp';
import simulation from '../../docs/reference-images/시뮬레이션 우주 아이콘.webp';

const icons = { trailblaze, simulation };

export default function CategoryIcon({ category }: { category: Category }) {
  return (
    <span className={`category-icon category-icon-${category}`} aria-hidden="true">
      {category === 'books' ? (
        <LibraryBig size={27} strokeWidth={1.5} />
      ) : category === 'codex' ? (
        <span className="archive-line-symbol" />
      ) : (
        <img src={icons[category]} alt="" />
      )}
    </span>
  );
}
