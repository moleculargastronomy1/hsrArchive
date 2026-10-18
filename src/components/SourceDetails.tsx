import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export default function SourceDetails({ children }: { children: ReactNode }) {
  return (
    <details className="source-details">
      <summary>
        <span>자료 출처</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="source-details-content">{children}</div>
    </details>
  );
}
