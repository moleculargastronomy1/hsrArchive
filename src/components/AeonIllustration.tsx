import nanook from '../../docs/reference-images/aeonsIllustration/나누크.webp';
import lan from '../../docs/reference-images/aeonsIllustration/란.webp';
import nous from '../../docs/reference-images/aeonsIllustration/누스.webp';
import xipe from '../../docs/reference-images/aeonsIllustration/시페.webp';
import ix from '../../docs/reference-images/aeonsIllustration/IX.webp';
import qlipoth from '../../docs/reference-images/aeonsIllustration/클리포트.webp';
import yaoshi from '../../docs/reference-images/aeonsIllustration/약사.webp';
import oroboros from '../../docs/reference-images/aeonsIllustration/우로보로스.webp';
import aha from '../../docs/reference-images/aeonsIllustration/아하.webp';
import fuli from '../../docs/reference-images/aeonsIllustration/후리.webp';
import tayzzyronth from '../../docs/reference-images/aeonsIllustration/타이츠론스.webp';
import mythus from '../../docs/reference-images/aeonsIllustration/미토스.webp';
import hooh from '../../docs/reference-images/aeonsIllustration/균형 후.webp';

// Keep artwork tied to the canonical record, including visits through chapter aliases.
const illustrations: Partial<Record<string, string>> = {
  'noun-atlas-102': nanook,
  'noun-atlas-103': lan,
  'noun-atlas-104': nous,
  'noun-atlas-105': xipe,
  'noun-atlas-106': ix,
  'noun-atlas-107': qlipoth,
  'noun-atlas-108': yaoshi,
  'noun-atlas-109': oroboros,
  'noun-atlas-110': aha,
  'noun-atlas-115': fuli,
  'noun-atlas-112': tayzzyronth,
  'noun-atlas-113': mythus,
  'noun-atlas-114': hooh,
};

export default function AeonIllustration({
  chapterId,
  title,
}: {
  chapterId: string;
  title: string;
}) {
  const src = illustrations[chapterId];
  if (!src) return null;

  return (
    <figure className="aeon-illustration">
      <img key={src} src={src} alt={`${title} 일러스트`} decoding="async" />
    </figure>
  );
}
