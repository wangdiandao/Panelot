import type { ThreadMeta } from '../../db/types';
import { t } from '../i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

export function ThreadDeleteDialog({
  thread,
  onClose,
  onDelete,
}: {
  thread: ThreadMeta;
  onClose: () => void;
  onDelete: (thread: ThreadMeta) => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('app.deleteConfirmTitle')} <b>{thread.title || t('app.untitled')}</b>
          </AlertDialogTitle>
          <AlertDialogDescription>{t('app.deleteConfirmBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onDelete(thread);
              onClose();
            }}
          >
            {t('app.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
