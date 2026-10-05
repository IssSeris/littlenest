import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { markNestNotificationsRead, type NestNotification } from '@workspace/api-client-react';
import { Bell, CheckCheck, ChevronDown, ChevronUp, ExternalLink, Check, Sparkles } from 'lucide-react';
import './today-notifications.css';

type Props = {
  notifications: NestNotification[];
  memberName: (id: string) => string;
  onRefresh: () => Promise<void>;
};

const RECENT = 5;
const stamp = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};

export default function TodayNotifications({ notifications, memberName, onRefresh }: Props) {
  const [, navigate] = useLocation();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [localRead, setLocalRead] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<{ ids: string[]; target?: string } | null>(null);

  const isRead = (n: NestNotification) => Boolean(n.readAt || localRead[n.id]);
  const unread = notifications.filter((n) => !isRead(n));
  const shown = expanded ? notifications : notifications.slice(0, RECENT);

  const save = async (ids: string[], target?: string) => {
    if (busy || !ids.length) return;
    setBusy(true);
    setFailed(null);
    try {
      await markNestNotificationsRead({ ids: ids.slice(0, 50) }, { credentials: 'include' });
      if (!live.current) return;
    } catch {
      if (!live.current) return;
      setFailed({ ids, target });
      setBusy(false);
      return;
    }
    const now = new Date().toISOString();
    setLocalRead((old) => ({ ...old, ...Object.fromEntries(ids.map((i) => [i, now])) }));
    try { await onRefresh(); } catch { /* polling will hydrate */ }
    if (!live.current) return;
    setBusy(false);
    if (target) navigate(target);
  };

  const open = (n: NestNotification) => (isRead(n) ? navigate(n.targetPath) : void save([n.id], n.targetPath));

  const renderItem = (n: NestNotification) => {
    const read = isRead(n);
    const who = memberName(n.actorId);
    return (
      <li key={n.id} className={`nn-item ${read ? '' : 'unread'}`} data-testid={`notification-${n.id}`}>
        <span className="nn-dot" aria-hidden="true" />
        <div className="nn-body">
          <div className="nn-summary">{n.summary}</div>
          <div className="nn-meta">{read ? 'Read' : 'Unread'} · {who} · <time dateTime={n.createdAt}>{stamp(n.createdAt)}</time></div>
          <div className="nn-actions">
            <button type="button" className="button button-primary" disabled={busy} onClick={() => open(n)} data-testid={`button-open-notification-${n.id}`}>
              <ExternalLink size={13} /> Open<span className="sr-only"> update from {who}</span>
            </button>
            {!read && (
              <button type="button" className="button button-soft" disabled={busy} onClick={() => void save([n.id])} data-testid={`button-read-notification-${n.id}`}>
                <Check size={13} /> Mark read
              </button>
            )}
          </div>
        </div>
      </li>
    );
  };

  return (
    <section className="surface nn-panel" aria-labelledby="nn-title" data-testid="notifications-panel">
      <div className="nn-head">
        <div>
          <h2 id="nn-title"><Bell size={18} /> Household updates
            <span className={`nn-count ${unread.length ? '' : 'zero'}`} data-testid="notifications-unread-count" aria-label={`${unread.length} unread`}>{unread.length}</span>
          </h2>
          <p className="nn-sub" role="status">{unread.length ? `${unread.length} new since you last checked` : 'Nothing new right now'}</p>
        </div>
        {unread.length > 0 && (
          <button type="button" className="button button-soft" disabled={busy} onClick={() => void save(unread.slice(0, 50).map((n) => n.id))} data-testid="button-read-all-notifications">
            <CheckCheck size={14} /> {busy ? 'Saving…' : 'Mark all read'}
          </button>
        )}
      </div>
      {failed && (
        <div className="nn-error" role="alert" data-testid="notifications-error">
          <span>We couldn’t save that as read, so it’s still unread. Please try again.</span>
          <button type="button" className="button button-soft" disabled={busy} onClick={() => void save(failed.ids, failed.target)} data-testid="button-retry-notifications">Retry</button>
        </div>
      )}
      {notifications.length === 0 ? (
        <div className="nn-empty" data-testid="notifications-empty">
          <div className="empty-symbol"><Sparkles size={17} /></div>
          <div><strong>All quiet</strong>Changes, shared journal entries and replies will show up here.</div>
        </div>
      ) : (
        <>
          {notifications.length > RECENT && <p className="nn-label">{expanded ? `All ${notifications.length} updates` : 'Recent'}</p>}
          <ul className="nn-list">{shown.map(renderItem)}</ul>
          {notifications.length > RECENT && (
            <button type="button" className="button button-plain nn-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} data-testid="button-toggle-notifications">
              {expanded ? <><ChevronUp size={14} /> Show fewer</> : <><ChevronDown size={14} /> {notifications.length - RECENT} more updates</>}
            </button>
          )}
          {unread.length === 0 && <p className="nn-sub" data-testid="notifications-caught-up">You’re all caught up.</p>}
        </>
      )}
    </section>
  );
}
