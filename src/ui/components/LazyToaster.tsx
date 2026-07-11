import { lazy, Suspense } from 'react';
import type { ToasterProps } from 'sonner';

const Toaster = lazy(() => import('./ui/sonner').then((module) => ({ default: module.Toaster })));

export function LazyToaster(props: ToasterProps) {
  return (
    <Suspense fallback={null}>
      <Toaster {...props} />
    </Suspense>
  );
}
