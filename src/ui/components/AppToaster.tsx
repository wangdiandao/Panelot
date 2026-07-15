import type { ToasterProps } from 'sonner';
import { Toaster } from './ui/sonner';

export function AppToaster(props: ToasterProps) {
  return <Toaster {...props} />;
}
