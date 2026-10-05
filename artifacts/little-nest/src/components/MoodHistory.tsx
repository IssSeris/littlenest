import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { NestJournalEntry } from '@workspace/api-client-react';
import { moodLabel, ownMoodHistory, recentMoodRange } from '../lib/mood-history';
import './mood-history.css';

type Props = {
  entries: NestJournalEntry[];
  authorId: string;
  prompts: Array<{ id: string; text: string }>;
};

export default function MoodHistory({ entries, authorId, prompts }: Props) {
  const [range, setRange] = useState('all');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const bounds = range === 'custom' ? { start, end } : range === 'all' ? { start: '', end: '' } : recentMoodRange(Number(range));
  const invalid = Boolean(bounds.start && bounds.end && bounds.start > bounds.end);
  const history = ownMoodHistory(entries, authorId, bounds.start, bounds.end);
  const hasMoods = ownMoodHistory(entries, authorId).length > 0;
  return <section className="surface section-panel mood-history" aria-labelledby="mood-history-title" data-testid="section-mood-history">
    <div className="panel-head">
      <div><div className="eyebrow">Only what you chose to record</div><h2 id="mood-history-title">Your mood history</h2></div>
      <span className="visibility"><LockKeyhole size={12} /> Only your entries</span>
    </div>
    <p className="list-meta">Look back at the moods you selected, newest first. Other members’ entries and entries without a mood are not included.</p>
    <div className="mood-history-filters">
      <label className="field-wrap"><span className="field-label">Date range</span>
        <select className="select" value={range} onChange={(event) => setRange(event.target.value)} data-testid="select-mood-history-range">
          <option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="custom">Custom dates</option>
        </select>
      </label>
      {range === 'custom' && <>
        <label className="field-wrap"><span className="field-label">From</span><input className="field" type="date" value={start} onChange={(event) => setStart(event.target.value)} aria-invalid={invalid} aria-describedby={invalid ? 'mood-range-error' : undefined} data-testid="input-mood-history-start" /></label>
        <label className="field-wrap"><span className="field-label">Through</span><input className="field" type="date" value={end} onChange={(event) => setEnd(event.target.value)} aria-invalid={invalid} aria-describedby={invalid ? 'mood-range-error' : undefined} data-testid="input-mood-history-end" /></label>
      </>}
    </div>
    {invalid ? <p id="mood-range-error" role="alert">Choose an end date on or after the start date.</p> : history.length ? <ol className="mood-history-list">
      {history.map((entry) => <li key={entry.id} data-testid={`row-mood-history-${entry.id}`}>
        <time dateTime={entry.createdAt}>{new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(entry.createdAt))}</time>
        <span className="small-tag" data-testid={`text-mood-history-${entry.id}`}>{moodLabel(entry.mood!)}</span>
        <a href={`#journal-entry-${entry.id}`} onClick={(event) => {
          const target = document.getElementById(`journal-entry-${entry.id}`);
          if (target) { event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'center' }); }
        }} data-testid={`link-mood-history-${entry.id}`}>View entry<span className="sr-only">: {prompts.find((prompt) => prompt.id === entry.promptId)?.text ?? 'Journal check-in'}</span></a>
      </li>)}
    </ol> : <p className="mood-history-empty" role="status" data-testid="text-mood-history-empty">{hasMoods ? 'No recorded moods in this date range. Try different dates or All time.' : 'No moods recorded yet. You can choose a mood when writing or editing your own entry; leaving it blank is always okay.'}</p>}
  </section>;
}