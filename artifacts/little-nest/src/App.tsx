import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { useClerk, useUser } from '@clerk/react';
import { PasteScope } from './hooks/use-paste-session';
import { useCreateNestInvitation, useCreateNestMember, useDeleteNestMember, NestJournalMood, type NestAllowanceEntry, type NestChore, type NestInvitation, type NestJournalEntry, type NestJournalAttachment, type NestJournalReply, type NestNotification } from '@workspace/api-client-react';
import { HouseholdSetup } from './AuthRoot';
import { useNest, type DataSetter } from './hooks/use-nest';
import type { GroceryItem, GroceryFavorite } from './lib/groceries';
import GroceriesPage from './pages/GroceriesPage';
import PasteList from './components/PasteList';
import type { ListSaver, ListRefresher } from './lib/paste-list';
import './components/paste-list.css';
import JournalReplies from './components/JournalReplies';
import TodayNotifications from './components/TodayNotifications';
import TrackingLabelEditor from './components/TrackingLabelEditor';
import BudgetPlanner from './components/BudgetPlanner';
import ChorePaymentLabel from './components/ChorePaymentLabel';
import { categorySuggestions, currentBudgetMonth, type BudgetDraft, type BudgetPlan, type MoneyEntry } from './lib/budget';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, BookHeart, CalendarDays, Check,
  CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Coins,
  Heart, House, LockKeyhole, Pencil, Plus, Settings2, ShoppingBasket,
  Share2, ShieldAlert, Sparkles, Sprout, Trash2, Wallet, X,
} from 'lucide-react';
import MoodHistory from './components/MoodHistory';
import JournalSearch from './components/JournalSearch';
import './components/journal-search.css';
import JournalAttachments, { JournalAttachmentList } from './components/JournalAttachments';
import './components/journal-attachments.css';
import { moodLabel } from './lib/mood-history';
import { AddMemberForm } from './components/AddMemberForm';

type MemberRole = 'parent' | 'child' | 'householdMember';
type Member = { id: string; name: string; role: MemberRole; avatarId?: string; linked: boolean; trackingLabel?: string };
type Chore = NestChore;
type AllowanceEntry = NestAllowanceEntry;
type CalendarEvent = { id: string; title: string; date: string; time: string; memberId: string; category: string };
type SchoolTask = { id: string; title: string; memberId: string; dueDate: string; course: string; done: boolean };
type Goal = { id: string; title: string; memberId: string; progress: number; targetDate: string };
type JournalPrompt = { id: string; text: string; category: string };
type JournalEntry = NestJournalEntry;
const journalMoodOptions: Array<[string, string]> = Object.values(NestJournalMood).map((mood) => [mood, moodLabel(mood)]);
export type AppData = {
  members: Member[]; chores: Chore[]; allowance: AllowanceEntry[]; events: CalendarEvent[];
  money: MoneyEntry[]; budgetPlans: BudgetPlan[]; schoolTasks: SchoolTask[]; goals: Goal[]; prompts: JournalPrompt[]; journal: JournalEntry[];
  groceries: GroceryItem[]; groceryFavorites: GroceryFavorite[];
  journalReplies: NestJournalReply[];
  notifications: NestNotification[];
  activeId: string; role: MemberRole; householdName: string;
};
const roleLabel = (role: MemberRole) => role === 'parent' ? 'Parent' : role === 'child' ? 'Child' : 'Household member';
const invitationErrorMessage = (error: unknown) => {
  const value = error as { data?: { error?: string }; message?: string };
  return value.data?.error ?? value.message ?? 'Could not complete this request. Please try again.';
};

const avatarCategories = [
  { id: 'animals', label: 'Animals', description: 'Soft little animal friends', count: 24 },
  { id: 'bugs', label: 'Bugs', description: 'Tiny garden visitors', count: 24 },
  { id: 'reptiles', label: 'Reptiles & amphibians', description: 'Pond and sunbeam pals', count: 24 },
] as const;
type AvatarCategory = (typeof avatarCategories)[number]['id'];
const avatarChoices = avatarCategories.flatMap((category) =>
  Array.from({ length: 12 }, (_, group) =>
    (['a', 'b'] as const).map((side, index) => ({
      id: `${category.id}-${String(group + 1).padStart(2, '0')}-${side}`,
      category: category.id,
      label: `${category.label} pal ${String(group * 2 + index + 1).padStart(2, '0')}`,
    })),
  ).flat(),
);
const availableAvatarIds = new Set(avatarChoices.map((avatar) => avatar.id));
const memberAvatarId = (member: Member) => {
  const savedAvatarId = member.avatarId;
  if (savedAvatarId && availableAvatarIds.has(savedAvatarId)) return savedAvatarId;
  const previousChoice = savedAvatarId?.match(/^(animals|bugs|reptiles)-(\d{2})-([ab])$/);
  if (previousChoice) {
    const group = ((Number(previousChoice[2]) - 1) % 12) + 1;
    return `${previousChoice[1]}-${String(group).padStart(2, '0')}-${previousChoice[3]}`;
  }
  return member.role === 'child' ? 'reptiles-01-a' : member.role === 'householdMember' ? 'bugs-01-a' : 'animals-01-a';
};
const avatarSource = (avatarId: string) => `${import.meta.env.BASE_URL}avatars/${avatarId}.webp?framing=complete`;

const dayKey = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const todayLong = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
const dateLabel = (value: string) => {
  if (!value) return 'No date';
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed);
};
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
type FormKind = 'chore' | 'allowance' | 'event' | 'money' | 'task' | 'goal' | 'journal';
type FormTarget = { kind: FormKind; item?: Record<string, unknown> } | null;
const navItems = [
  { href: '/', label: 'Today', icon: House },
  { href: '/chores', label: 'Chores', icon: CheckCircle2 },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/groceries', label: 'Groceries', icon: ShoppingBasket },
  { href: '/money', label: 'Money', icon: Wallet },
  { href: '/school', label: 'School & work', icon: ClipboardList },
  { href: '/journal', label: 'Journal', icon: BookHeart },
];

function App() {
  const { user } = useUser();
  const { data, setData, appendListItem, refreshList, needsSetup, loading, saving, loadError, saveError, refresh, clearSaveError } = useNest();
  const { signOut } = useClerk();
  const [modal, setModal] = useState<FormTarget>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [location] = useLocation();
  const [activePrompt, setActivePrompt] = useState('p1');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(dayKey());
  if (loading) return <div className="auth-page"><div className="surface panel" role="status">Opening your little nest…</div></div>;
  if (needsSetup) return <HouseholdSetup onReady={() => void refresh()} />;
  if (loadError || !data) return <div className="auth-page"><div className="surface panel" role="alert"><h2>We couldn’t open your household</h2><p>{loadError || 'Please retry loading your household.'}</p><button className="button button-primary" onClick={() => void refresh()}>Retry</button><button className="button button-soft" onClick={() => void signOut({ redirectUrl: import.meta.env.BASE_URL })}>Sign out</button></div></div>;
  const activeMember = data.members.find((member) => member.id === data.activeId) ?? data.members[0];
  const memberName = (memberId: string) => memberId === 'household' ? 'Household' : data.members.find((member) => member.id === memberId)?.name ?? 'Former household member';
  const open = (kind: FormKind, item?: object) => setModal({ kind, item: item as Record<string, unknown> | undefined });
  const remove = (key: 'chores' | 'allowance' | 'events' | 'money' | 'schoolTasks' | 'goals' | 'journal', itemId: string) => {
    if (window.confirm(key === 'journal' ? 'Remove this journal entry and all of its replies? This cannot be undone.' : 'Remove this item? You can add it again any time.')) {
      setData((old) => ({ ...old, [key]: old[key].filter((item) => item.id !== itemId) }) as AppData);
    }
  };
  const toggleChore = (itemId: string) => setData((old) => ({ ...old, chores: old.chores.map((item) => item.id === itemId ? { ...item, done: !item.done } : item) }));
  const toggleTask = (itemId: string) => setData((old) => ({ ...old, schoolTasks: old.schoolTasks.map((item) => item.id === itemId ? { ...item, done: !item.done } : item) }));
  const togglePaid = (itemId: string) => setData((old) => ({ ...old, allowance: old.allowance.map((item) => item.id === itemId ? { ...item, status: item.status === 'paid' ? 'earned' : 'paid' } : item) }));
  const incrementGoal = (itemId: string, delta: number) => setData((old) => ({ ...old, goals: old.goals.map((goal) => goal.id === itemId ? { ...goal, progress: Math.max(0, Math.min(5, goal.progress + delta)) } : goal) }));
  const saveForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modal) return;
    const form = new FormData(event.currentTarget);
    const val = (key: string) => String(form.get(key) ?? '');
    const common = modal.item ?? {};
    const savedId = String(common.id ?? id());
    const editing = Boolean(common.id);
    const updateList = (key: keyof Pick<AppData, 'chores' | 'allowance' | 'events' | 'money' | 'schoolTasks' | 'goals' | 'journal'>, entry: Record<string, unknown>) => {
      return setData((old) => ({ ...old, [key]: editing ? old[key].map((item) => item.id === savedId ? { ...entry, id: savedId } : item) : [...old[key], { ...entry, id: savedId }] }) as AppData);
    };
    let saved = false;
    if (modal.kind === 'chore') saved = await updateList('chores', { title: val('title').trim(), assignedTo: val('memberId'), cadence: val('cadence'), dueDate: val('dueDate'), done: Boolean(common.done) });
    if (modal.kind === 'allowance') saved = await updateList('allowance', { title: val('title').trim(), amount: Number(val('amount')) || 0, date: val('date'), status: String(common.status ?? 'earned') });
    if (modal.kind === 'event') saved = await updateList('events', { title: val('title').trim(), date: val('date'), time: val('time'), memberId: val('memberId'), category: val('category') });
    if (modal.kind === 'money') saved = await updateList('money', { title: val('title').trim(), amount: Number(val('amount')) || 0, date: val('date'), category: val('category'), kind: val('kind') });
    if (modal.kind === 'task') saved = await updateList('schoolTasks', { title: val('title').trim(), memberId: val('memberId'), dueDate: val('dueDate'), course: val('course'), done: Boolean(common.done) });
    if (modal.kind === 'goal') saved = await updateList('goals', { title: val('title').trim(), memberId: val('memberId'), progress: Number(val('progress')) || 0, targetDate: val('targetDate') });
    if (modal.kind === 'journal') {
      const existing = data.journal.find((entry) => entry.id === savedId);
      saved = await updateList('journal', { promptId: val('promptId'), authorId: existing?.authorId ?? data.activeId, body: val('body').trim(), attachmentIds: form.getAll('attachmentIds').map(String), attachments: (() => { try { return JSON.parse(val('attachmentsMeta') || '[]'); } catch { return []; } })(), createdAt: existing?.createdAt ?? new Date().toISOString(), shared: existing?.shared ?? false, mood: val('mood') || null });
      setActivePrompt(val('promptId'));
    }
    if (saved) setModal(null);
  };
  const titleForModal: Record<FormKind, string> = { chore: 'A little household task', allowance: 'Allowance note', event: 'Add to the calendar', money: 'Add a money note', task: 'A school or work task', goal: 'A gentle goal', journal: 'A journal entry' };
  const eventsToday = data.events.filter((event) => event.date === dayKey()).sort((a, b) => a.time.localeCompare(b.time));
  const pendingChores = data.chores.filter((chore) => !chore.done);
  const pendingTasks = data.schoolTasks.filter((task) => !task.done);
  return (
    <PasteScope.Provider key={`${user?.id}:${data.activeId}`} value={user ? { accountId: user.id, membershipId: data.activeId } : null}>
      {(saving || saveError) && <div className="sync-notice" role={saveError ? 'alert' : 'status'} data-testid="notice-save-status">{saving ? 'Saving to your household…' : saveError}{saveError && <><button className="button button-soft" onClick={() => void refresh()} disabled={saving}>Refresh saved data</button><button className="button button-soft" onClick={clearSaveError}>Dismiss</button></>}</div>}
      <div className="app-shell" inert={saving}>
        <aside className="sidebar">
          <Link href="/" className="brand" data-testid="link-brand"><span className="brand-mark"><Sprout size={21} /></span><span><span className="brand-name">little nest</span><span className="brand-tag">room to breathe</span></span></Link>
          <div className="nav-label">Your household</div>
            <nav className="nav-list" aria-label="Main navigation">{navItems.filter((item) => item.href !== '/money' || data.role === 'parent').map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href ? 'active' : ''}`} data-testid={`link-nav-${href === '/school' ? 'school' : label.toLowerCase()}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></Link>)}</nav>
          <div className="sidebar-bottom">
            <div className="household-card"><div className="household-title"><Heart size={13} /> THE HOME TEAM</div><div className="household-members">{data.members.map((member) => <span className="member-chip" key={member.id} data-testid={`member-chip-${member.id}`}><MemberAvatar member={member} />{member.name}</span>)}</div></div>
            {data.role === 'parent' && <button className="nav-link" onClick={() => setSettingsOpen(true)} data-testid="button-household-settings"><Settings2 size={17} /> Household settings</button>}
            <div className="sidebar-foot">A little more room for real life.</div>
          </div>
        </aside>
        <main className="main">
          <header className="topbar">
            <div className="crumb"><span>Little Nest</span><ArrowRight size={12} /><strong>{navItems.find((item) => item.href === location)?.label ?? 'Today'}</strong></div>
            <div className="top-actions"><span className="date-pill">{todayLong}</span><span className="signed-profile" data-testid="signed-in-profile">{activeMember.name} · {roleLabel(activeMember.role)}</span><button className="icon-btn" onClick={() => void refresh()} aria-label="Refresh household" title="Refresh household" data-testid="button-refresh"><Sprout size={17} /></button><button className="avatar" onClick={() => setSettingsOpen(true)} aria-label={data.role === 'parent' ? 'Open household settings' : 'Choose your avatar'} data-testid="button-open-settings"><MemberAvatar member={activeMember} /></button><button className="button button-soft" onClick={() => void signOut({ redirectUrl: import.meta.env.BASE_URL })} data-testid="button-sign-out">Sign out</button></div>
          </header>
          <div className="content">
            <Switch>
              <Route path="/"><TodayPage data={data} memberName={memberName} onToggle={toggleChore} onOpen={open} chores={pendingChores} events={eventsToday} tasks={pendingTasks} onRefresh={refresh} /></Route>
              <Route path="/chores"><ChoresPage data={data} memberName={memberName} onOpen={open} onToggle={toggleChore} onRemove={(key, itemId) => remove(key, itemId)} onPay={togglePaid} onSaveList={appendListItem} onRefreshList={refreshList} /></Route>
              <Route path="/calendar"><CalendarPage data={data} month={month} setMonth={setMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay} memberName={memberName} onOpen={open} onRemove={(key, itemId) => remove(key, itemId)} /></Route>
              <Route path="/groceries"><GroceriesPage data={data} setData={setData} onSaveList={appendListItem} onRefreshList={refreshList} /></Route>
              <Route path="/money">{data.role === 'parent' ? <MoneyPage data={data} setData={setData} onOpen={open} onRemove={(key, itemId) => remove(key, itemId)} /> : <Empty title="This page is parent-only" detail="Household finances are not available in your account." icon={LockKeyhole} />}</Route>
              <Route path="/school"><SchoolPage data={data} memberName={memberName} onOpen={open} onToggle={toggleTask} onRemove={(key, itemId) => remove(key, itemId)} onGoal={incrementGoal} setData={setData} /></Route>
              <Route path="/journal"><JournalPage data={data} activePrompt={activePrompt} setActivePrompt={setActivePrompt} onOpen={open} onRemove={(key, itemId) => remove(key, itemId)} setData={setData} memberName={memberName} /></Route>
              <Route><NotFound /></Route>
            </Switch>
          </div>
        </main>
        {modal && <Dialog title={titleForModal[modal.kind]} onClose={() => setModal(null)}><EntryForm kind={modal.kind} item={modal.item} data={data} onSubmit={saveForm} onCancel={() => setModal(null)} /></Dialog>}
        {settingsOpen && <Dialog title={data.role === 'parent' ? 'Your little household' : 'Your avatar'} intro={data.role === 'parent' ? 'Make this space feel like yours.' : 'Choose a character for your profile.'} onClose={() => setSettingsOpen(false)} wide><SettingsPanel data={data} setData={setData} refresh={refresh} onClose={() => setSettingsOpen(false)} /></Dialog>}
      </div>
    </PasteScope.Provider>
  );
}

function MemberAvatar({ member, className = '' }: { member: Member; className?: string }) {
  return <img className={`member-avatar ${className}`} src={avatarSource(memberAvatarId(member))} alt={`${member.name}'s character avatar`} data-testid={`img-avatar-${member.id}`} />;
}

function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-head"><div className="page-head-copy"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="lead">{description}</p></div>{action}</div>;
}
function Empty({ title, detail, icon: Icon = Sparkles }: { title: string; detail: string; icon?: typeof Sparkles }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon size={20} /></div><strong>{title}</strong><p>{detail}</p></div>;
}
function TodayPage({ data, memberName, onToggle, onOpen, chores, events, tasks, onRefresh }: { data: AppData; memberName: (id: string) => string; onToggle: (id: string) => void; onOpen: (kind: FormKind, item?: object) => void; chores: Chore[]; events: CalendarEvent[]; tasks: SchoolTask[]; onRefresh: () => Promise<void> }) {
  const done = data.chores.filter((item) => item.done).length;
  const pendingToday = data.chores.filter((item) => item.dueDate <= dayKey() && !item.done).length;
  const nextTask = tasks[0];
  const visibleEvents = events.slice(0, 3);
  const upcoming = [...chores].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 4);
  return <>
     <section className="welcome"><div><div className="eyebrow">A softer start to the day</div><h1>Hello, {data.members.find((member) => member.id === data.activeId)?.name || 'friend'}.</h1><p className="welcome-note">You don’t have to hold it all in your head.<br />Here’s what matters for your home today.</p></div><div className="welcome-art"><Sparkles className="welcome-sparkle" size={19} /><div className="welcome-pals">{data.members.map((member) => <MemberAvatar member={member} className="welcome-portrait" key={member.id} />)}</div><span className="welcome-dot" /></div></section>
    <TodayNotifications notifications={data.notifications} memberName={memberName} onRefresh={onRefresh} />
    <div className="summary-grid">
      <div className="surface summary-card"><span className="summary-icon sage"><CheckCircle2 size={18} /></span><div><div className="summary-value">{pendingToday}</div><div className="summary-label">little things still to do</div></div></div>
      <div className="surface summary-card"><span className="summary-icon"><CalendarDays size={18} /></span><div><div className="summary-value">{events.length}</div><div className="summary-label">plans on today’s calendar</div></div></div>
      <div className="surface summary-card"><span className="summary-icon rose"><Sprout size={18} /></span><div><div className="summary-value">{done}<span style={{ fontSize: 14, color: '#95a098' }}> / {data.chores.length}</span></div><div className="summary-label">home rhythms checked off</div></div></div>
    </div>
    <div className="home-grid">
      <section className="surface panel"><div className="panel-head"><h2>Today’s small steps</h2><Link href="/chores" className="panel-link" data-testid="link-today-chores">See routines <ArrowRight size={13} /></Link></div>
        {upcoming.length ? <div className="task-list">{upcoming.map((chore) => { const assignee = data.members.find((member) => member.id === chore.assignedTo); return <div className={`task-row ${chore.done ? 'task-done' : ''}`} key={chore.id} data-testid={`row-today-chore-${chore.id}`}><button className={`check ${chore.done ? 'checked' : ''}`} onClick={() => onToggle(chore.id)} aria-label={chore.done ? 'Mark not done' : 'Mark done'} data-testid={`button-check-chore-${chore.id}`}>{chore.done && <Check size={13} />}</button><div className="task-copy"><div className="task-title">{chore.title}</div><div className="task-sub">{chore.done ? 'Done for now' : `${memberName(chore.assignedTo)} · ${chore.dueDate === dayKey() ? 'Today' : dateLabel(chore.dueDate)}`}</div><ChorePaymentLabel chore={chore} /></div><span className={`small-tag ${assignee && assignee.role !== 'parent' ? 'child' : ''}`}>{memberName(chore.assignedTo)}</span></div>; })}</div> : <Empty title="Nothing pressing right now" detail="The day has a little breathing room. Add a home rhythm when you need one." />}
      </section>
      <section className="surface panel"><div className="panel-head"><h2>Coming up</h2><Link href="/calendar" className="panel-link" data-testid="link-home-calendar">Open calendar <ArrowRight size={13} /></Link></div>
        {visibleEvents.length ? visibleEvents.map((event) => <div className="event-card" key={event.id} data-testid={`event-home-${event.id}`}><span className="event-time">{event.time}</span><div><div className="event-title">{event.title}</div><div className="event-meta">{memberName(event.memberId)} · {event.category}</div></div></div>) : <Empty title="A clear calendar" detail="Add one thing you’d like to remember." icon={CalendarDays} />}
        <div style={{ borderTop: '1px solid #efeee6', paddingTop: 14, marginTop: 5 }}><div className="panel-head" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 17 }}>Next school or work step</h2><Link href="/school" className="panel-link" data-testid="link-home-school">View tasks <ArrowRight size={13} /></Link></div>{nextTask ? <div className="task-row" style={{ borderTop: 0, padding: 4 }}><div className="task-copy"><div className="task-title">{nextTask.title}</div><div className="task-sub">{memberName(nextTask.memberId)} · due {dateLabel(nextTask.dueDate)}</div></div></div> : <div className="task-sub">All caught up for now.</div>}</div>
      </section>
    </div>
    <div className="toolbar" style={{ marginTop: 19 }}><button className="button button-soft" onClick={() => onOpen('chore')} data-testid="button-quick-add-chore"><Plus size={15} /> Add a home task</button><button className="button button-soft" onClick={() => onOpen('event')} data-testid="button-quick-add-event"><Plus size={15} /> Add a plan</button><Link href="/journal" className="button button-soft" data-testid="link-quick-journal"><BookHeart size={15} /> Take a small check-in</Link></div>
  </>;
}

function ChoresPage({ data, memberName, onOpen, onToggle, onRemove, onPay, onSaveList, onRefreshList }: { data: AppData; memberName: (id: string) => string; onOpen: (kind: FormKind, item?: object) => void; onToggle: (id: string) => void; onRemove: (key: 'chores' | 'allowance', id: string) => void; onPay: (id: string) => void; onSaveList: ListSaver; onRefreshList: ListRefresher }) {
  const earned = data.allowance.filter((entry) => entry.status === 'earned').reduce((sum, entry) => sum + entry.amount, 0);
  return <>
    <PageHead eyebrow="Home, one thing at a time" title="Chores & routines" description="A shared list of small things that keep the house moving. Done is done — no perfect streak required." action={<button className="button button-primary" onClick={() => onOpen('chore')} data-testid="button-add-chore"><Plus size={16} /> Add a routine</button>} />
    <PasteList kind="chores" data={data} onSave={onSaveList} onRefresh={onRefreshList} />
    <div className="section-grid">
      <section className="surface section-panel"><div className="panel-head"><h2>Household rhythms</h2><span className="small-tag">{data.chores.filter((c) => !c.done).length} left</span></div>
        {data.chores.length ? data.chores.map((chore) => <div className="list-item" key={chore.id} data-testid={`row-chore-${chore.id}`}><button className={`check ${chore.done ? 'checked' : ''}`} onClick={() => onToggle(chore.id)} aria-label={chore.done ? 'Mark not done' : 'Mark done'} data-testid={`button-toggle-chore-${chore.id}`}>{chore.done && <Check size={13} />}</button><div className="list-info"><div className="list-title" style={chore.done ? { textDecoration: 'line-through', color: '#a1aaa1' } : undefined}>{chore.title}</div><div className="list-meta">{memberName(chore.assignedTo)} · {chore.cadence} · due {dateLabel(chore.dueDate)}</div><ChorePaymentLabel chore={chore} /></div><button className="icon-btn" onClick={() => onOpen('chore', chore)} aria-label="Edit routine" data-testid={`button-edit-chore-${chore.id}`}><Pencil size={15} /></button><button className="icon-btn" onClick={() => onRemove('chores', chore.id)} aria-label="Delete routine" data-testid={`button-delete-chore-${chore.id}`}><Trash2 size={15} /></button></div>) : <Empty title="A fresh start" detail="Add a routine when something needs a little reminder." icon={Sprout} />}
      </section>
      <section className="surface section-panel"><div className="panel-head"><h2>Allowance jar</h2><span className="summary-value" style={{ fontSize: 21 }}>{money(earned)}<span style={{ font: '11px DM Sans', color: '#929b93' }}> to pay</span></span></div><p className="list-meta" style={{ margin: '-6px 0 10px' }}>A simple record, not a bank account.</p>
        <button className="button button-soft" onClick={() => onOpen('allowance')} data-testid="button-add-allowance"><Plus size={14} /> Add an earned task</button>
        {data.allowance.length ? <div style={{ marginTop: 13 }}>{data.allowance.map((entry) => <div className="list-item" key={entry.id} data-testid={`row-allowance-${entry.id}`}><span className="summary-icon" style={{ width: 34, height: 34, borderRadius: 11 }}><Coins size={16} /></span><div className="list-info"><div className="list-title">{entry.title}</div><div className="list-meta">{dateLabel(entry.date)} · {entry.status === 'paid' ? 'Paid' : 'Earned'}</div></div><strong style={{ fontSize: 13 }}>{money(entry.amount)}</strong><button className={`button ${entry.status === 'paid' ? 'button-soft' : 'button-primary'}`} style={{ padding: '7px 9px', fontSize: 10 }} onClick={() => onPay(entry.id)} data-testid={`button-pay-allowance-${entry.id}`}>{entry.status === 'paid' ? 'Undo' : 'Mark paid'}</button><button className="icon-btn" onClick={() => onOpen('allowance', entry)} aria-label="Edit allowance entry" data-testid={`button-edit-allowance-${entry.id}`}><Pencil size={14} /></button><button className="icon-btn" onClick={() => onRemove('allowance', entry.id)} aria-label="Delete allowance entry" data-testid={`button-delete-allowance-${entry.id}`}><Trash2 size={14} /></button></div>)}</div> : <Empty title="The jar is waiting" detail="Add a little task when you want to keep track." icon={Coins} />}
      </section>
    </div>
  </>;
}

function CalendarPage({ data, month, setMonth, selectedDay, setSelectedDay, memberName, onOpen, onRemove }: { data: AppData; month: Date; setMonth: (date: Date) => void; selectedDay: string; setSelectedDay: (day: string) => void; memberName: (id: string) => string; onOpen: (kind: FormKind, item?: object) => void; onRemove: (key: 'events', id: string) => void }) {
  const year = month.getFullYear(); const monthNumber = month.getMonth();
  const first = new Date(year, monthNumber, 1); const start = new Date(year, monthNumber, 1 - first.getDay());
  const days = Array.from({ length: 35 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const selectedEvents = data.events.filter((event) => event.date === selectedDay).sort((a, b) => a.time.localeCompare(b.time));
  const shift = (delta: number) => setMonth(new Date(year, monthNumber + delta, 1));
  return <>
    <PageHead eyebrow="Plans, all in one place" title="Household calendar" description="School, work, home, and the things you want to remember." action={<button className="button button-primary" onClick={() => onOpen('event')} data-testid="button-add-event"><Plus size={16} /> Add an event</button>} />
    <div className="calendar-layout">
      <section className="surface panel"><div className="month-head"><button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month" data-testid="button-calendar-prev"><ChevronLeft size={19} /></button><strong data-testid="text-calendar-month">{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(month)}</strong><button className="icon-btn" onClick={() => shift(1)} aria-label="Next month" data-testid="button-calendar-next"><ChevronRight size={19} /></button></div>
        <div className="month-days">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div className="day-label" key={`${d}${i}`}>{d}</div>)}{days.map((date) => {
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const count = data.events.filter((event) => event.date === key).length;
          return <button key={key} className={`calendar-day ${date.getMonth() !== monthNumber ? 'muted-day' : ''} ${key === dayKey() ? 'today' : ''} ${selectedDay === key ? 'selected' : ''}`} onClick={() => setSelectedDay(key)} data-testid={`button-calendar-day-${key}`}><span>{date.getDate()}</span>{count > 0 && <div>{Array.from({ length: Math.min(count, 3) }, (_, index) => <span className="day-dot" key={index} />)}</div>}</button>;
        })}</div>
      </section>
      <section className="surface panel"><div className="panel-head"><h2>{selectedDay === dayKey() ? 'Today' : dateLabel(selectedDay)}</h2><span className="small-tag">{selectedEvents.length} plans</span></div>
        {selectedEvents.length ? selectedEvents.map((event) => <div className="list-item" key={event.id} data-testid={`row-calendar-event-${event.id}`}><span className="event-time">{event.time}</span><div className="list-info"><div className="list-title">{event.title}</div><div className="list-meta">{memberName(event.memberId)} · {event.category}</div></div><button className="icon-btn" onClick={() => onOpen('event', event)} aria-label="Edit event" data-testid={`button-edit-event-${event.id}`}><Pencil size={14} /></button><button className="icon-btn" onClick={() => onRemove('events', event.id)} aria-label="Delete event" data-testid={`button-delete-event-${event.id}`}><Trash2 size={14} /></button></div>) : <Empty title="A bit of breathing room" detail="Add an event here when you want to remember it." icon={CalendarDays} />}
      </section>
    </div>
  </>;
}

function MoneyPage({ data, setData, onOpen, onRemove }: { data: AppData; setData: DataSetter; onOpen: (kind: FormKind, item?: object) => void; onRemove: (key: 'money', id: string) => void }) {
  const income = data.money.filter((entry) => entry.kind === 'income').reduce((sum, entry) => sum + entry.amount, 0);
  const expense = data.money.filter((entry) => entry.kind === 'expense').reduce((sum, entry) => sum + entry.amount, 0);
  const balance = income - expense;
  const saveBudget = (draft: BudgetDraft, existingId?: string): Promise<boolean> => {
    if ((existingId && !data.budgetPlans.some((plan) => plan.id === existingId)) || (!existingId && data.budgetPlans.some((plan) => plan.month === draft.month))) return Promise.resolve(false);
    const savedId = existingId ?? id();
    return setData((old) => ({ ...old, budgetPlans: existingId ? old.budgetPlans.map((plan) => plan.id === savedId ? { ...draft, id: savedId } : plan) : [...old.budgetPlans, { ...draft, id: savedId }] }));
  };
  return <>
    <PageHead eyebrow="A clear picture, no pressure" title="Money & budget" description="Make a monthly plan and track household income and spending. Nothing here connects to a bank or financial account." action={<button className="button button-primary" onClick={() => onOpen('money')} data-testid="button-add-money"><Plus size={16} /> Add a money note</button>} />
    <div className="budget-hero"><div><div className="eyebrow" style={{ marginBottom: 6 }}>This list’s net total</div><div className="budget-total" data-testid="text-money-balance">{money(balance)}</div><div className="budget-label">Manual notes only · not a connected account</div></div><div style={{ textAlign: 'right' }}><div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', color: '#64846a', fontSize: 12, marginBottom: 8 }}><ArrowDownLeft size={15} /> {money(income)} in</div><div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', color: '#bd7968', fontSize: 12 }}><ArrowUpRight size={15} /> {money(expense)} out</div></div></div>
    <BudgetPlanner plans={data.budgetPlans} entries={data.money} onSave={saveBudget} onDelete={(planId) => setData((old) => ({ ...old, budgetPlans: old.budgetPlans.filter((plan) => plan.id !== planId) }))} onAddMoney={(category, selectedMonth) => onOpen('money', { category: category ?? 'Household', date: selectedMonth === currentBudgetMonth() ? dayKey() : `${selectedMonth}-01`, kind: 'expense' })} />
    <section className="surface section-panel"><div className="panel-head"><h2>Recent notes</h2><span className="small-tag">{data.money.length} entries</span></div>
      {data.money.length ? [...data.money].sort((a, b) => b.date.localeCompare(a.date)).map((entry) => <div className="money-row" key={entry.id} data-testid={`row-money-${entry.id}`}><div className="list-info"><div className="list-title">{entry.title}</div><div className="list-meta">{dateLabel(entry.date)} · {entry.category}</div></div><span className={`amount ${entry.kind === 'income' ? 'positive' : 'negative'}`}>{entry.kind === 'income' ? '+' : '−'}{money(entry.amount)}</span><button className="icon-btn" onClick={() => onOpen('money', entry)} aria-label="Edit money note" data-testid={`button-edit-money-${entry.id}`}><Pencil size={14} /></button><button className="icon-btn" onClick={() => onRemove('money', entry.id)} aria-label="Delete money note" data-testid={`button-delete-money-${entry.id}`}><Trash2 size={14} /></button></div>) : <Empty title="No notes yet" detail="Add a manual entry when you want to keep a clearer picture." icon={Wallet} />}
    </section>
  </>;
}

function SchoolPage({ data, memberName, onOpen, onToggle, onRemove, onGoal, setData }: { data: AppData; memberName: (id: string) => string; onOpen: (kind: FormKind, item?: object) => void; onToggle: (id: string) => void; onRemove: (key: 'schoolTasks' | 'goals', id: string) => void; onGoal: (id: string, delta: number) => void; setData: DataSetter }) {
  const renderMemberTasks = (member: Member) => {
    const list = data.schoolTasks.filter((task) => task.memberId === member.id);
    return <section className="surface section-panel" key={member.id}><div className="panel-head"><div><div className="eyebrow">{member.name}</div><h2 style={{ overflowWrap: 'anywhere' }} data-testid={`text-tracking-label-${member.id}`}>{member.trackingLabel || 'School & work'}</h2></div><span className={`small-tag ${member.role !== 'parent' ? 'child' : ''}`}>{list.filter((task) => !task.done).length} active</span></div>
      {(data.role === 'parent' || data.activeId === member.id) && <TrackingLabelEditor member={member} setData={setData} />}
      {list.length ? list.map((task) => <div className="list-item" key={task.id} data-testid={`row-school-task-${task.id}`}><button className={`check ${task.done ? 'checked' : ''}`} onClick={() => onToggle(task.id)} aria-label={task.done ? 'Mark incomplete' : 'Mark complete'} data-testid={`button-toggle-task-${task.id}`}>{task.done && <Check size={13} />}</button><div className="list-info"><div className="list-title" style={task.done ? { textDecoration: 'line-through', color: '#a1aaa1' } : undefined}>{task.title}</div><div className="list-meta">{task.course} · due {dateLabel(task.dueDate)}</div></div><button className="icon-btn" onClick={() => onOpen('task', task)} aria-label="Edit task" data-testid={`button-edit-task-${task.id}`}><Pencil size={14} /></button><button className="icon-btn" onClick={() => onRemove('schoolTasks', task.id)} aria-label="Delete task" data-testid={`button-delete-task-${task.id}`}><Trash2 size={14} /></button></div>) : <Empty title="Nothing to chase" detail="Add classes, projects, training, or work tasks when they come up." icon={BookHeart} />}
    </section>;
  };
  const goals = data.goals;
  return <>
    <PageHead eyebrow="Your plans, at every stage" title="School, work & goals" description="Track classes, work projects, training, or whatever comes next. Customize each person's space as their plans change." action={<button className="button button-primary" onClick={() => onOpen('task')} data-testid="button-add-school-task"><Plus size={16} /> Add a task</button>} />
    <div className="section-grid">{data.members.map(renderMemberTasks)}</div>
    <section className="surface section-panel" style={{ marginTop: 17 }}><div className="panel-head"><div><div className="eyebrow">Forward, at your own pace</div><h2 style={{ marginBottom: 0 }}>Small goals</h2></div><button className="button button-soft" onClick={() => onOpen('goal')} data-testid="button-add-goal"><Plus size={14} /> Add a goal</button></div>
      {goals.length ? <div className="section-grid">{goals.map((goal) => <div className="list-item" style={{ border: '1px solid #efeee6', borderRadius: 13, padding: 14 }} key={goal.id} data-testid={`card-goal-${goal.id}`}><span className="summary-icon sage"><Sprout size={17} /></span><div className="list-info"><div className="list-title">{goal.title}</div><div className="list-meta">{memberName(goal.memberId)} · by {dateLabel(goal.targetDate)}</div><div className="toolbar" style={{ marginTop: 9 }}>{Array.from({ length: 5 }, (_, n) => <button key={n} onClick={() => onGoal(goal.id, n < goal.progress ? n - goal.progress : n + 1 - goal.progress)} aria-label={`Set progress ${n + 1} of 5`} className={`check ${n < goal.progress ? 'checked' : ''}`} style={{ width: 16, height: 16, borderRadius: 6 }} data-testid={`button-goal-progress-${goal.id}-${n + 1}`}>{n < goal.progress && <Check size={10} />}</button>)}<span className="list-meta">{goal.progress}/5 steps</span></div></div><button className="icon-btn" onClick={() => onOpen('goal', goal)} aria-label="Edit goal" data-testid={`button-edit-goal-${goal.id}`}><Pencil size={14} /></button><button className="icon-btn" onClick={() => onRemove('goals', goal.id)} aria-label="Delete goal" data-testid={`button-delete-goal-${goal.id}`}><Trash2 size={14} /></button></div>)}</div> : <Empty title="Room to grow" detail="Add one small goal if something is worth keeping in view." icon={Sprout} />}
    </section>
  </>;
}

function JournalPage({ data, activePrompt, setActivePrompt, onOpen, onRemove, setData, memberName }: { data: AppData; activePrompt: string; setActivePrompt: (id: string) => void; onOpen: (kind: FormKind, item?: object) => void; onRemove: (key: 'journal', id: string) => void; setData: DataSetter; memberName: (id: string) => string }) {
  const requestedEntry = new URLSearchParams(window.location.search).get('entry');
  useEffect(() => {
    if (!requestedEntry) return;
    const article = document.getElementById(`journal-entry-${requestedEntry}`);
    article?.scrollIntoView({ block: 'start' });
    article?.focus({ preventScroll: true });
  }, [requestedEntry]);
  const currentPrompt = data.prompts.find((prompt) => prompt.id === activePrompt) ?? data.prompts[0];
  const visible = data.journal.filter((entry) => entry.shared || entry.authorId === data.activeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const share = (entryId: string) => setData((old) => ({ ...old, journal: old.journal.map((entry) => entry.id === entryId ? { ...entry, shared: !entry.shared } : entry) }));
  return <>
    <PageHead eyebrow="A place to put the thoughts down" title="Journal & check-ins" description="Private drafts stay with their author until they choose to share. A prompt is just an invitation, never homework." action={<button className="button button-primary" onClick={() => onOpen('journal', { promptId: currentPrompt?.id ?? 'p1' })} data-testid="button-write-journal"><Plus size={16} /> Write a check-in</button>} />
    {requestedEntry && !data.journal.some((entry) => entry.id === requestedEntry) && <div className="privacy-note" role="status" data-testid="notice-unavailable-journal">This journal entry is no longer shared or has been removed.</div>}
    <MoodHistory key={`moods-${data.activeId}`} entries={data.journal} authorId={data.activeId} prompts={data.prompts} />
    <JournalSearch key={`search-${data.activeId}`} entries={data.journal} authorId={data.activeId} />
    <div className="journal-grid">
      <section className="surface prompt-list"><div className="eyebrow" style={{ padding: '8px 11px 6px' }}>A prompt, if helpful</div>{data.prompts.map((prompt) => <button className={`prompt-option ${prompt.id === activePrompt ? 'selected' : ''}`} key={prompt.id} onClick={() => setActivePrompt(prompt.id)} data-testid={`button-prompt-${prompt.id}`}><div className="prompt-category">{prompt.category}</div><div className="prompt-copy">{prompt.text}</div></button>)}</section>
      <section className="surface section-panel"><div className="panel-head"><div><div className="eyebrow">Your words, your choice</div><h2 style={{ marginBottom: 0 }}>{currentPrompt?.text ?? 'A small check-in'}</h2></div><span className="visibility"><LockKeyhole size={12} /> Private by default</span></div>
        {visible.length ? visible.map((entry) => {
          const prompt = data.prompts.find((item) => item.id === entry.promptId);
          return <article className="journal-entry" id={`journal-entry-${entry.id}`} tabIndex={-1} key={entry.id} data-testid={`entry-journal-${entry.id}`}>
            <div className="entry-meta"><span>{memberName(entry.authorId)} · {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(entry.createdAt))}{prompt ? ` · ${prompt.category}` : ''}</span><span className="visibility" style={!entry.shared ? { background: '#f4eee2', color: '#8a7958' } : undefined}>{entry.shared ? <><Share2 size={11} /> Shared with household</> : <><LockKeyhole size={11} /> Private draft</>}</span></div>
            {entry.mood && <div style={{ margin: '8px 0' }}><span className="small-tag" data-testid={`text-journal-mood-${entry.id}`}>Mood: {moodLabel(entry.mood)}</span></div>}
            <div className="entry-body">{entry.body}</div>
            <JournalAttachmentList attachments={entry.attachments} />
            <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 10 }}>{entry.authorId === data.activeId && <>
              <button className="button button-soft" style={{ fontSize: 10, padding: '7px 10px' }} onClick={() => onOpen('journal', entry)} data-testid={`button-edit-journal-${entry.id}`}><Pencil size={12} /> Edit</button>
              <button className={`button ${entry.shared ? 'button-soft' : 'button-primary'}`} style={{ fontSize: 10, padding: '7px 10px' }} onClick={() => share(entry.id)} data-testid={`button-share-journal-${entry.id}`}>{entry.shared ? <><LockKeyhole size={12} /> Make private</> : <><Share2 size={12} /> Share with household</>}</button>
              <button className="icon-btn" onClick={() => onRemove('journal', entry.id)} aria-label="Delete journal entry" data-testid={`button-delete-journal-${entry.id}`}><Trash2 size={14} /></button>
            </>}</div>
            <JournalReplies entryId={entry.id} data={data} setData={setData} memberName={memberName} />
          </article>;
        }) : <Empty title="Your page is open" detail="Choose a prompt, or write whatever is on your mind. Nothing is shared until you decide." icon={BookHeart} />}
      </section>
    </div>
    <div className="privacy-note" data-testid="notice-journal-privacy"><strong><LockKeyhole size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />Your words stay yours.</strong> Private entries are accessible only to their author’s account, even when the other person is a parent. Sharing makes an entry visible to your household; only you can edit it or make it private again. Changes refresh while the app is open. Making an entry private cannot erase a copy someone already saw or saved. Sign out on shared devices.</div>
  </>;
}

function Dialog({ title, intro, onClose, children, wide = false }: { title: string; intro?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="dialog-top"><div><h2>{title}</h2>{intro && <p className="dialog-intro">{intro}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Close dialog" data-testid="button-close-dialog"><X size={18} /></button></div>{children}</section></div>;
}
function EntryForm({ kind, item, data, onSubmit, onCancel }: { kind: FormKind; item?: Record<string, unknown>; data: AppData; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [attachmentsPending, setAttachmentsPending] = useState(false);
  const value = (key: string, fallback = '') => String(item?.[key] ?? fallback);
  const isEdit = Boolean(item?.id);
  const members = data.members;
  const promptDefault = value('promptId', data.prompts[0]?.id ?? '');
  const field = (name: string, label: string, type = 'text', fallback = '', required = true) => <label className="field-wrap"><span className="field-label">{label}</span><input className="field" name={name} type={type} defaultValue={value(name, fallback)} required={required} min={type === 'number' ? 0 : undefined} max={name === 'progress' ? 5 : undefined} step={type === 'number' ? (name === 'progress' ? 1 : 0.01) : undefined} maxLength={name === 'title' ? 300 : undefined} data-testid={`input-${kind}-${name}`} /></label>;
  const choose = (name: string, label: string, options: Array<[string, string]>, fallback: string) => {
    const selected = value(name, name === 'memberId' ? String(item?.assignedTo ?? fallback) : fallback);
    const safeOptions = selected === 'household' && !options.some(([key]) => key === selected)
      ? [...options, ['household', 'Household'] as [string, string]]
      : selected && !options.some(([key]) => key === selected)
      ? [...options, [selected, 'Former household member (keep existing assignment)'] as [string, string]]
      : options;
    return <label className="field-wrap"><span className="field-label">{label}</span><select className="select" name={name} defaultValue={selected} data-testid={`select-${kind}-${name}`}>{safeOptions.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select></label>;
  };
  const memberOptions: Array<[string, string]> = members.map((member) => [member.id, member.name]);
  let fields: ReactNode;
  if (kind === 'chore') fields = <>{field('title', 'What needs doing?')}{choose('memberId', 'Who is it for?', memberOptions, members[0]?.id ?? '')}{choose('cadence', 'Repeats', [['Once', 'Just once'], ['Daily', 'Daily'], ['Weekdays', 'Weekdays'], ['Weekly', 'Weekly']], 'Weekly')}{field('dueDate', 'Next due', 'date', dayKey())}</>;
  else if (kind === 'allowance') fields = <>{field('title', 'Task or reason')}{field('amount', 'Amount', 'number', '2.00')}{field('date', 'Date', 'date', dayKey())}</>;
  else if (kind === 'event') fields = <>{field('title', 'What’s happening?')}{field('date', 'Date', 'date', dayKey())}{field('time', 'Time', 'text', 'All day', false)}{choose('memberId', 'Who is it for?', memberOptions, members[0]?.id ?? '')}{choose('category', 'Kind', [['Home', 'Home'], ['School', 'School'], ['Appointment', 'Appointment'], ['Family', 'Family'], ['Other', 'Other']], 'Home')}</>;
  else if (kind === 'money') fields = <>{field('title', 'What was it?')}{field('amount', 'Amount', 'number', '0.00')}{field('date', 'Date', 'date', dayKey())}{choose('kind', 'In or out?', [['expense', 'Expense · money out'], ['income', 'Income · money in']], 'expense')}<label className="field-wrap"><span className="field-label">Category</span><input className="field" name="category" defaultValue={value('category', 'Household')} list="money-category-options" required maxLength={100} data-testid="input-money-category" /></label><datalist id="money-category-options">{Array.from(new Set([...categorySuggestions, ...data.money.map((entry) => entry.category), ...data.budgetPlans.flatMap((plan) => plan.categories.map((line) => line.category))])).map((category) => <option key={category} value={category} />)}</datalist></>;
  else if (kind === 'task') fields = <>{field('title', 'What needs doing?')}{choose('memberId', 'For whom?', memberOptions, data.activeId)}{field('course', 'Subject, project, or work area', 'text', 'General')}{field('dueDate', 'Due date', 'date', dayKey())}<p className="list-meta full">Use any subject or project name, for school, work, training, or personal learning.</p></>;
  else if (kind === 'goal') fields = <>{field('title', 'A small goal')}{choose('memberId', 'For whom?', memberOptions, members[0]?.id ?? '')}{field('targetDate', 'Aim for', 'date', dayKey(14))}{field('progress', 'Steps done (0–5)', 'number', '0')}</>;
  else fields = <>
    <label className="field-wrap full"><span className="field-label">Prompt</span><select className="select" name="promptId" defaultValue={promptDefault} data-testid="select-journal-prompt">{data.prompts.map((prompt) => <option value={prompt.id} key={prompt.id}>{prompt.text}</option>)}</select></label>
    {choose('mood', 'How are you feeling? (optional)', [['', 'No mood selected'], ...journalMoodOptions], '')}
    <label className="field-wrap full"><span className="field-label">What would you like to remember?</span><textarea className="textarea" name="body" defaultValue={value('body')} placeholder="A few words is enough. You can keep this private, or share it later." required={!(Array.isArray(item?.attachments) && item.attachments.length)} maxLength={20000} data-testid="input-journal-body" /></label>
    <JournalAttachments initial={item?.attachments as NestJournalAttachment[] | undefined} onBusyChange={setUploading} onPendingChange={setAttachmentsPending} />
    <div className="field-wrap full" style={{ fontSize: 11, lineHeight: 1.5, color: '#887c61' }}><LockKeyhole size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />{isEdit ? 'Editing keeps your existing sharing choice.' : 'Saved as private. You’ll choose explicitly if you want to share it.'}</div>
  </>;
  return <form onSubmit={onSubmit}><div className="form-grid">{fields}</div><div className="form-actions"><button type="button" className="button button-soft" onClick={onCancel} disabled={uploading} data-testid="button-cancel-form">Cancel</button><button type="submit" className="button button-primary" disabled={uploading || attachmentsPending} data-testid="button-save-form">{isEdit ? 'Save changes' : 'Add to Little Nest'}</button></div></form>;
}
function SettingsPanel({ data, setData, refresh, onClose }: { data: AppData; setData: DataSetter; refresh: () => Promise<void>; onClose: () => void }) {
  const [avatarCategory, setAvatarCategory] = useState<AvatarCategory>('animals');
  const [targetMemberId, setTargetMemberId] = useState(data.activeId);
  const [memberError, setMemberError] = useState('');
  const createMember = useCreateNestMember({ request: { credentials: 'include' } });
  const deleteMember = useDeleteNestMember({ request: { credentials: 'include' } });
  const canManageHousehold = data.role === 'parent';
  const parentCount = data.members.filter((member) => member.role === 'parent').length;
  const avatarMembers = data.members.filter((member) => canManageHousehold || member.id === data.activeId);
  const updateName = (memberId: string, name: string) => setData((old) => ({ ...old, members: old.members.map((member) => member.id === memberId ? { ...member, name } : member) }));
  const targetMember = avatarMembers.find((member) => member.id === targetMemberId) ?? avatarMembers[0];
  const chooseAvatar = (avatarId: string) => setData((old) => ({ ...old, members: old.members.map((member) => member.id === targetMember?.id ? { ...member, avatarId } : member) }));
  const updateRole = async (memberId: string, role: MemberRole) => {
    setMemberError('');
    const saved = await setData((old) => ({
      ...old,
      members: old.members.map((member) => member.id === memberId ? { ...member, role } : member),
    }));
    if (!saved) setMemberError('The role was not changed. Check the save notice above for details.');
  };
  const removeMember = async (member: Member) => {
    setMemberError('');
    const confirmed = window.confirm(
      `Remove ${member.name} from this household? Their account will lose access, but their sign-in account will not be deleted. Any unused invitation is revoked. Private journals, moods, and saved attachments stay stored and hidden from remaining members; journals they chose to share remain visible. Synced grocery and chore drafts, unsaved journal uploads, and household notifications for this profile are deleted. Existing records and assigned work stay in history. Browser-local drafts on the original device are not changed. This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await deleteMember.mutateAsync({ id: member.id });
      await refresh();
    } catch (error) {
      setMemberError(invitationErrorMessage(error));
    }
  };
  const choices = avatarChoices.filter((avatar) => avatar.category === avatarCategory);
  return <div className="settings-panel">
    {canManageHousehold && <>
      <AddMemberForm onCreate={(values) => createMember.mutateAsync({ data: values })} onSaved={refresh} />
      <section aria-labelledby="member-roster-title">
        <div className="member-section-heading"><h3 id="member-roster-title">Household roster</h3><span>{data.members.length} {data.members.length === 1 ? 'person' : 'people'}</span></div>
        <div className="profile-editors" data-testid="household-roster">
          {data.members.map((member) => <div className="member-editor member-roster-card" key={member.id} data-testid={`settings-member-${member.id}`}>
            <MemberAvatar member={member} className="settings-portrait" />
            <div className="member-roster-content">
              <div className="member-roster-heading"><span className="field-label">{roleLabel(member.role)}</span><span className={`member-link-status ${member.linked ? 'linked' : 'unlinked'}`} data-testid={`member-link-status-${member.id}`}>{member.linked ? 'Account linked' : 'Not linked'}</span></div>
              <label className="member-name-field"><span className="sr-only">Name for {roleLabel(member.role)} profile</span><input className="field" defaultValue={member.name} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== member.name) void updateName(member.id, event.target.value); }} required maxLength={80} aria-label={`Name for ${roleLabel(member.role)} profile`} data-testid={`input-member-name-${member.id}`} /></label>
              <label className="field-wrap"><span className="field-label">Household role</span><select className="select" value={member.role} disabled={member.role === 'parent' && parentCount <= 1} onChange={(event) => void updateRole(member.id, event.target.value as MemberRole)} aria-label={`Role for ${member.name}`} data-testid={`select-member-role-${member.id}`}><option value="parent">Parent</option><option value="child">Child</option><option value="householdMember">Household member</option></select></label>
              {member.role === 'parent' && parentCount <= 1 && <p className="list-meta">At least one parent must remain in the household.</p>}
              {!member.linked && <InvitationPanel member={member} />}
              <button className="button button-soft" type="button" disabled={deleteMember.isPending || (member.role === 'parent' && parentCount <= 1)} onClick={() => void removeMember(member)} data-testid={`button-remove-member-${member.id}`}><Trash2 size={14} /> Remove profile</button>
            </div>
          </div>)}
        </div>
        {memberError && <p role="alert" data-testid="error-household-member">{memberError}</p>}
      </section>
    </>}
    <section className="avatar-picker" aria-labelledby="avatar-picker-title">
      <div className="avatar-picker-heading"><div><div className="eyebrow">A little character for your corner</div><h3 id="avatar-picker-title">Choose an avatar</h3><p>{canManageHousehold ? 'Pick a profile, then choose a friend.' : 'Choose a friend for your own profile.'}</p></div><span className="avatar-picked-note"><Heart size={13} /> Saved with this household</span></div>
      <div className="avatar-profile-tabs" role="group" aria-label="Choose whose avatar to change">{avatarMembers.map((member) => <button key={member.id} type="button" className={`avatar-profile-tab ${targetMember?.id === member.id ? 'selected' : ''}`} onClick={() => setTargetMemberId(member.id)} aria-pressed={targetMember?.id === member.id} data-testid={`button-avatar-profile-${member.id}`}><MemberAvatar member={member} className="tab-portrait" /><span><strong>{member.name}</strong><small>{roleLabel(member.role)}</small></span></button>)}</div>
      <div className="avatar-category-tabs" role="group" aria-label="Avatar collections">{avatarCategories.map((category) => <button key={category.id} type="button" aria-pressed={avatarCategory === category.id} className={`avatar-category-tab ${avatarCategory === category.id ? 'selected' : ''}`} onClick={() => setAvatarCategory(category.id)} data-testid={`tab-avatar-${category.id}`}>{category.label}<span>{category.count}</span></button>)}</div>
      <div className="avatar-grid" role="group" aria-label={`${avatarCategories.find((category) => category.id === avatarCategory)?.label} avatars`}>{choices.map((avatar, index) => {
        const isSelected = targetMember ? memberAvatarId(targetMember) === avatar.id : false;
        return <button type="button" key={avatar.id} className={`avatar-choice ${isSelected ? 'selected' : ''}`} onClick={() => chooseAvatar(avatar.id)} aria-label={`Choose ${avatar.label} for ${targetMember?.name ?? 'profile'}`} aria-pressed={isSelected} title={avatar.label} data-testid={`button-select-avatar-${avatar.id}`}><img src={avatarSource(avatar.id)} alt="" loading="lazy" /><span>{String(index + 1).padStart(2, '0')}</span>{isSelected && <span className="avatar-check"><Check size={13} /></span>}</button>;
      })}</div>
      <p className="avatar-helper">{avatarCategories.find((category) => category.id === avatarCategory)?.description}. Your choice saves automatically.</p>
    </section>
    {canManageHousehold ? <div className="privacy-note" data-testid="notice-storage-settings"><strong><ShieldAlert size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />Separate accounts, shared household.</strong> Chores, routines, calendar, school/work tasks, goals, and allowance are shared. Household money, invitations, profile names, and roles are parent-only; each person can customize their own avatar and tracking name. Journal entries are private unless their author shares them. Removing a profile revokes its household access and pending invite; the sign-in account itself remains. Private journals, moods, and saved attachments stay hidden from remaining members; intentionally shared entries stay shared. Synced grocery/chore drafts, unsaved journal uploads, and that profile’s notifications are deleted. Existing records and assignments stay in history. Browser-local data is not changed or uploaded.</div> : <p className="avatar-helper">You can change your own avatar here. Other profiles and household settings remain parent-only.</p>}
    <div className="form-actions"><button className="button button-primary" onClick={onClose} data-testid="button-close-settings">All set</button></div>
  </div>;
}
function InvitationPanel({ member }: { member: Member }) {
  const [invite, setInvite] = useState<NestInvitation | null>(null);
  const [error, setError] = useState('');
  const createInvitation = useCreateNestInvitation({ request: { credentials: 'include' } });
  useEffect(() => { setInvite(null); setError(''); }, [member.role]);
  const create = async () => {
    setError('');
    try { setInvite(await createInvitation.mutateAsync({ data: { memberId: member.id } })); }
    catch (err) { setError(invitationErrorMessage(err)); }
  };
  return <section className="invitation-panel" data-testid={`household-invitation-${member.id}`}>
    <p>Each person signs in with their own account. This single-use code is assigned the {roleLabel(member.role)} role.</p>
    <button className="button button-soft" type="button" disabled={createInvitation.isPending} onClick={() => void create()} data-testid={`button-create-invitation-${member.id}`}>{createInvitation.isPending ? 'Creating code…' : invite ? 'Replace invitation code' : 'Create invitation code'}</button>
    {invite && <div className="invitation-code"><label className="field-label" htmlFor={`invite-code-${member.id}`}>Invitation code for {member.name}</label><input id={`invite-code-${member.id}`} className="field" readOnly value={invite.code} onFocus={(event) => event.target.select()} data-testid={`input-invitation-code-${member.id}`} /><p>Expires {new Date(invite.expiresAt).toLocaleString()}. Share this code privately; replacing it will not affect anyone else’s code.</p></div>}
    {createInvitation.isPending && <p role="status">Creating invitation…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
function NotFound() {
  return <div className="empty-state surface" style={{ marginTop: 35 }}><div className="empty-symbol"><House size={20} /></div><strong>This little path doesn’t exist</strong><p>Try one of the household pages from the menu.</p><Link href="/" className="button button-primary" style={{ marginTop: 15 }} data-testid="link-not-found-home">Back to today</Link></div>;
}

export default App;
