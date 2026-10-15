import type { Category } from '../data/types';
import trailblaze from '../../docs/reference-images/개척 임무 아이콘.webp';
import simulation from '../../docs/reference-images/시뮬레이션 우주 아이콘.webp';
import codex from '../../docs/reference-images/아카이브 아이콘.png';

const icons = { trailblaze, simulation, codex };

export default function CategoryIcon({ category }: { category: Category }) {
  return (
    <span className={`category-icon category-icon-${category}`} aria-hidden="true">
      <img src={icons[category]} alt="" />
    </span>
  );
}
