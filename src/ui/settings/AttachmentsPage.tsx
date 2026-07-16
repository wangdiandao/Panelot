import { useEffect, useMemo, useState } from 'react';
import { FileArchive, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AttachmentRepository } from '../../data/attachments';
import { PanelotDB } from '../../db/schema';
import type { Attachment } from '../../db/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import {
  Attachment as AttachmentItem,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '../components/ui/attachment';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import { getLang, t } from '../i18n';

const db = new PanelotDB();
const repository = new AttachmentRepository(db);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsPage() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const totalBytes = useMemo(
    () => attachments.reduce((sum, attachment) => sum + attachment.bytes.size, 0),
    [attachments],
  );
  const refresh = () => repository.list().then(setAttachments);

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">{t('settings.section.attachments')}</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t('settings.attachments.summary', {
            count: attachments.length,
            size: formatBytes(totalBytes),
          })}
        </p>
      </div>

      {attachments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileArchive />
            </EmptyMedia>
            <EmptyTitle>{t('settings.attachments.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.attachments.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <AttachmentGroup className="flex-col items-stretch overflow-visible py-0">
          {attachments.map((attachment) => (
            <AttachmentItem key={attachment.id} className="w-full">
              <AttachmentMedia>
                <FileArchive />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>
                  {attachment.meta?.title ?? attachment.sourceRef ?? attachment.id}
                </AttachmentTitle>
                <AttachmentDescription>
                  {attachment.mime} · {formatBytes(attachment.bytes.size)} ·{' '}
                  {new Date(attachment.createdAt).toLocaleString(getLang())}
                </AttachmentDescription>
                <AttachmentDescription className="flex flex-wrap gap-2 overflow-visible whitespace-normal">
                  <Badge variant="secondary">{attachment.kind}</Badge>
                  <Badge variant={attachment.trust === 'untrusted' ? 'outline' : 'secondary'}>
                    {attachment.trust ?? t('settings.attachments.unclassified')}
                  </Badge>
                  <Badge variant="outline">
                    {attachment.provenance ?? t('settings.attachments.unknownSource')}
                  </Badge>
                  <Badge variant="outline">{attachment.threadId}</Badge>
                  {attachment.refs?.nodeIds && attachment.refs.nodeIds.length > 0 && (
                    <Badge variant="outline">
                      {t('settings.attachments.nodeRefs', {
                        count: attachment.refs.nodeIds.length,
                      })}
                    </Badge>
                  )}
                </AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  variant="destructive"
                  size="icon-sm"
                  aria-label={t('settings.attachments.delete')}
                  onClick={() => setDeleting(attachment)}
                >
                  <Trash2 data-icon="inline-start" />
                </AttachmentAction>
              </AttachmentActions>
            </AttachmentItem>
          ))}
        </AttachmentGroup>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.attachments.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.attachments.deleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  void repository.remove(deleting.id).then(refresh);
                  toast.success(t('settings.attachments.deleted'));
                }
                setDeleting(null);
              }}
            >
              {t('settings.attachments.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
