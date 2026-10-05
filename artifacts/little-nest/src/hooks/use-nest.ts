import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useUser } from "@clerk/react";
import {
  getNestSnapshot, createNestRecord, updateNestRecord, deleteNestRecord, updateNestMember,
   type NestSnapshot, type NestRecordResult,
} from "@workspace/api-client-react";
import type { AppData } from "../App";
import { draftPayload, validateDraft, type ListSaver, type ListRefresher } from "../lib/paste-list";

export type DataSetter = (value: SetStateAction<AppData>) => Promise<boolean>;
const kinds = ["chores", "allowance", "events", "money", "budgetPlans", "schoolTasks", "goals", "journal", "groceries", "groceryFavorites", "journalReplies"] as const;
const labels: Record<typeof kinds[number], string> = {
  chores: "chore", allowance: "allowance note", events: "calendar event", money: "money note", budgetPlans: "budget plan",
  schoolTasks: "school task", goals: "goal", journal: "journal entry", groceries: "grocery item",
  groceryFavorites: "grocery favorite", journalReplies: "journal reply",
};
export const journalPrompts = [
  { id: "p1", text: "What felt like a small win today?", category: "A little lighter" },
  { id: "p2", text: "What is taking up the most space in your mind?", category: "Check in" },
  { id: "p3", text: "What would make tomorrow feel easier?", category: "Looking ahead" },
  { id: "p4", text: "What is something you want me to understand?", category: "For us" },
];
const fromSnapshot = (snapshot: NestSnapshot): AppData => ({
  ...snapshot, money: snapshot.money ?? [], budgetPlans: snapshot.budgetPlans ?? [], groceries: snapshot.groceries ?? [], groceryFavorites: snapshot.groceryFavorites ?? [], journalReplies: snapshot.journalReplies ?? [], prompts: journalPrompts,
}) as unknown as AppData;
const payload = (item: object) => {
  const { id: _id, authorId: _author, createdAt: _created, attachments: _attachments, allowanceRecorded: _allowanceRecorded, ...data } = item as Record<string, unknown>;
  return data;
};
const explain = (error: unknown): string => {
  const e = error as { data?: { error?: string }; message?: string };
  return e.data?.error ?? e.message ?? "The connection failed. Please try again.";
};

export function useNest() {
  const { user } = useUser();
  const userId = user?.id ?? "";
  const [data, setState] = useState<AppData | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const current = useRef<AppData | null>(null);
  const pending = useRef(false);
  const live = useRef(true);
  const requestVersion = useRef(0);
  const saveBlocked = useRef(false);
  const recoveryOutcome = useRef("");

  const refresh = useCallback(async () => {
    if (pending.current || !userId) return;
    const version = ++requestVersion.current;
    try {
      const result = await getNestSnapshot({ credentials: "include", cache: "no-store" });
      if (!live.current || version !== requestVersion.current) return;
      current.current = fromSnapshot(result);
      setState(current.current);
      setNeedsSetup(false);
      setLoadError("");
      if (saveBlocked.current && recoveryOutcome.current) {
        setSaveError(`${recoveryOutcome.current} Showing the latest saved household data. Your form input has been kept.`);
      }
      saveBlocked.current = false;
      recoveryOutcome.current = "";
    } catch (error) {
      if (!live.current || version !== requestVersion.current) return;
      if ((error as { status?: number }).status === 404) {
        setNeedsSetup(true);
        current.current = null;
        setState(null);
        setLoadError("");
      } else {
        if (!saveBlocked.current || [401, 403].includes((error as { status?: number }).status ?? 0)) {
          setLoadError(`Could not load your household. ${explain(error)}`);
        }
        // During save recovery, a temporary polling failure must not unmount forms.
        // Do not keep showing journal data when access can no longer be checked.
        if ([401, 403].includes((error as { status?: number }).status ?? 0)) {
          current.current = null;
          setState(null);
        }
      }
    } finally {
      if (live.current && version === requestVersion.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    live.current = true;
    current.current = null;
    setState(null);
    setLoading(true);
    setNeedsSetup(false);
    setLoadError("");
    setSaveError("");
    pending.current = false;
    saveBlocked.current = false;
    recoveryOutcome.current = "";
    setSaving(false);
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      live.current = false;
      requestVersion.current++;
      current.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const setData: DataSetter = async (value) => {
    if (pending.current || saveBlocked.current || !current.current || loadError || !userId) return false;
    const previous = current.current;
    let next = typeof value === "function" ? value(previous) : value;
    const deletedEntries = new Set(previous.journal.filter((entry) => !next.journal.some((row) => row.id === entry.id)).map((entry) => entry.id));
    if (deletedEntries.size) next = { ...next, journalReplies: next.journalReplies.filter((reply) => !deletedEntries.has(reply.entryId)) };
    pending.current = true;
    const version = ++requestVersion.current; // invalidate an in-flight snapshot
    const isCurrent = () => live.current && version === requestVersion.current;
    const operations: Array<{ label: string; run: () => Promise<unknown> }> = [];
    const confirmed: string[] = [];
    let failedAt = "";
    let reconciled = false;
    const applyAllowance = (result: NestRecordResult) => {
      if (!result.allowanceEntry) return;
      const entry = result.allowanceEntry;
      next = { ...next, allowance: next.allowance.some((row) => row.id === entry.id) ? next.allowance : [...next.allowance, entry],
        chores: next.chores.map((row) => row.id === result.id ? { ...row, allowanceRecorded: true } : row) };
    };
    setSaving(true);
    setSaveError("");
    try {
      for (const kind of kinds) {
        const before = previous[kind] as Array<{ id: string }>;
        const after = next[kind] as Array<{ id: string }>;
        for (const item of before) {
          // The server atomically removes replies with their journal entry.
          if (kind === "journalReplies" && deletedEntries.has((item as { id: string; entryId: string }).entryId)) continue;
          if (!after.some((row) => row.id === item.id)) operations.push({
            label: `${labels[kind]} deletion`,
            run: () => deleteNestRecord(item.id, { credentials: "include" }),
          });
        }
        for (const item of after) {
          const old = before.find((row) => row.id === item.id);
          if (!old) {
            operations.push({
              label: `${labels[kind]} addition`,
              run: async () => {
                const result = await createNestRecord({ kind, data: payload(item) }, { credentials: "include" });
                // Do not mutate the caller's pending form data.
                next = { ...next, [kind]: next[kind].map((row) => row.id === item.id ? { ...row, id: result.id } : row) };
                applyAllowance(result);
              },
            });
          } else if (JSON.stringify(old) !== JSON.stringify(item)) {
            operations.push({
              label: `${labels[kind]} update`,
              run: async () => { const result = await updateNestRecord(item.id, { data: payload(item) }, { credentials: "include" }); applyAllowance(result); },
            });
          }
        }
      }
      for (const member of next.members) {
        const old = previous.members.find((m) => m.id === member.id);
        if (old && (old.name !== member.name || old.avatarId !== member.avatarId || old.trackingLabel !== member.trackingLabel || old.role !== member.role)) {
          operations.push({
            label: "member profile update",
            run: () => updateNestMember(member.id, {
              ...(old.name !== member.name ? { name: member.name.trim() } : {}),
              ...(old.avatarId !== member.avatarId ? { avatarId: member.avatarId } : {}),
              ...(old.trackingLabel !== member.trackingLabel ? { trackingLabel: member.trackingLabel } : {}),
              ...(old.role !== member.role ? { role: member.role } : {}),
            }, { credentials: "include" }),
          });
        }
      }
      for (const operation of operations) {
        if (!isCurrent()) return false;
        failedAt = operation.label;
        await operation.run();
        confirmed.push(operation.label);
      }
      if (!isCurrent()) return false;
      current.current = next;
      setState(next);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      const counts = new Map<string, number>();
      for (const label of confirmed) counts.set(label, (counts.get(label) ?? 0) + 1);
      const saved = confirmed.length ? [...counts].map(([label, count]) => `${count} ${label}${count > 1 ? "s" : ""}`).join(", ") : "none";
      const remaining = operations.length - confirmed.length - 1;
      const outcome = `Update incomplete. Confirmed saved: ${saved}. Could not confirm ${failedAt}: ${explain(error)}${remaining > 0 ? ` ${remaining} remaining change${remaining > 1 ? "s were" : " was"} not sent.` : ""}`;
      // Do not call refresh here: it intentionally skips while a save is pending.
      // Even a rejected request may have committed before its response was lost.
      try {
        const snapshot = await getNestSnapshot({ credentials: "include", cache: "no-store" });
        if (!isCurrent()) return false;
        current.current = fromSnapshot(snapshot);
        setState(current.current);
        setNeedsSetup(false);
        setLoadError("");
        saveBlocked.current = false;
        recoveryOutcome.current = "";
        setSaveError(`${outcome} Showing the latest saved household data. Your form input has been kept.`);
      } catch (refreshError) {
        if (!isCurrent()) return false;
        saveBlocked.current = true;
        recoveryOutcome.current = outcome;
        setSaveError(`${outcome} Could not check the latest saved data: ${explain(refreshError)} Some changes may have saved. Your form input has been kept; saving is paused until the household can be refreshed.`);
        const status = (refreshError as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) {
          // Never retain journal data after household authorization is lost.
          current.current = null;
          setState(null);
          setLoadError(`Could not load your household. ${explain(refreshError)}`);
          if (status === 404) setNeedsSetup(true);
        }
      }
      reconciled = true;
      return false;
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setSaving(false);
        if (!reconciled) void refresh();
      }
    }
  };
  // Paste imports use one authenticated creation per draft. Unlike setData's
  // boolean contract, callers must know whether a request was actually sent.
  const refreshList: ListRefresher = async () => {
    if (pending.current || !userId || !current.current) return null;
    const version = ++requestVersion.current;
    pending.current = true;
    try {
      const snapshot = await getNestSnapshot({ credentials: "include", cache: "no-store" });
      if (!live.current || version !== requestVersion.current) return null;
      current.current = fromSnapshot(snapshot);
      setState(current.current);
      saveBlocked.current = false;
      recoveryOutcome.current = "";
      setSaveError("");
      return current.current;
    } catch (error) {
      if (live.current && version === requestVersion.current) {
        setSaveError(`Could not refresh the saved list. ${explain(error)}`);
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) {
          current.current = null;
          setState(null);
          setLoadError(`Could not load your household. ${explain(error)}`);
          if (status === 404) setNeedsSetup(true);
        }
      }
      return null;
    } finally {
      if (live.current && version === requestVersion.current) pending.current = false;
    }
  };

  const appendListItem: ListSaver = async (kind, row) => {
    if (pending.current || saveBlocked.current || !current.current || loadError || !userId) {
      return { status: "blocked", error: "Nothing was sent. Refresh your household before trying again." };
    }
    const errors = validateDraft(kind, row, current.current.members);
    if (errors.length) return { status: "blocked", error: errors.join(" ") };
    const version = ++requestVersion.current;
    const isCurrent = () => live.current && version === requestVersion.current;
    pending.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const fields = draftPayload(kind, row);
      const result = await createNestRecord({ kind, data: fields }, { credentials: "include" });
      if (!isCurrent() || !current.current) return { status: "uncertain", error: "The account changed before this save could be confirmed." };
      current.current = { ...current.current, [kind]: [...current.current[kind], { ...fields, id: result.id }] } as AppData;
      setState(current.current);
      return { status: "saved" };
    } catch (error) {
      if (isCurrent()) {
        // A lost response does not prove a failed write. Require the paste UI's
        // explicit snapshot review before it permits this draft to be retried.
        saveBlocked.current = true;
        recoveryOutcome.current = "A pasted item may have saved. Check the saved list before retrying that draft.";
        setSaveError(`${recoveryOutcome.current} ${explain(error)}`);
      }
      return { status: "uncertain", error: `Could not confirm this item. ${explain(error)}` };
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setSaving(false);
      }
    }
  };
  return { data, setData, appendListItem, refreshList, needsSetup, loading, saving, loadError, saveError, refresh, clearSaveError: () => setSaveError("") };
}