import { useState } from 'react';
import type { NestJournalEntry } from '@workspace/api-client-react';
import { searchOwnJournal } from '../lib/journal-search';

export default function JournalSearch({ entries, authorId }: { entries: NestJournalEntry[]; authorId: string }) {
  const [query, setQuery] = useState('');
  const searching = Boolean(query.trim());
  const results = searchOwnJournal(entries, authorId, query);
  const hasEntries = entries.some((entry) => entry.authorId === authorId);

  return <section className="surface section-panel journal-search" aria-labelledby="journal-search-title" data-testid="section-journal-search">
    <div className="panel-head"><h2 id="journal-search-title">Search your entries</h2><span className="visibility">Only your entries</span></div>
    <p id="journal-search-help" className="list-meta">Find words or a phrase you wrote, with or without a mood. Other members’ entries and replies are not searched. Uppercase and lowercase both match.</p>
    <div className="journal-search-controls">
      <label className="field-wrap"><span className="field-label">Words or phrase</span>
        <input className="field" type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-describedby="journal-search-help" placeholder="Search your written words" autoComplete="off" maxLength={20000} data-testid="input-journal-search" />
      </label>
      {query && <button className="button button-soft" onClick={() => setQuery('')} data-testid="button-clear-journal-search">Clear search</button>}
    </div>
    <p role="status" data-testid="text-journal-search-status">
      {!hasEntries ? 'No journal entries of your own yet. Write a check-in to get started.'
        : !searching ? 'Type words or a phrase to search your entries.'
        : results.length ? `${results.length} matching ${results.length === 1 ? 'entry' : 'entries'}, newest first.`
        : 'No entries match those words. Try different words or clear your search.'}
    </p>
    {searching && results.length > 0 && <ol className="journal-search-results">
      {results.map((entry) => <li key={entry.id} data-testid={`result-journal-search-${entry.id}`}>
        <time dateTime={entry.createdAt}>{new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(entry.createdAt))}</time>
        <p className="journal-search-preview">{entry.body.length > 240 ? `${entry.body.slice(0, 240)}…` : entry.body}</p>
        <a href={`#journal-entry-${entry.id}`} onClick={(event) => {
          const target = document.getElementById(`journal-entry-${entry.id}`);
          if (target) { event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'center' }); }
        }} data-testid={`link-journal-search-${entry.id}`}>View entry<span className="sr-only"> from {new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(entry.createdAt))}</span></a>
      </li>)}
    </ol>}
  </section>;
}