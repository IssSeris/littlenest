import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import type { AppData } from "../src/App";

// Use the real hook and React lifecycle, with deterministic authorized API responses.
let userId = "parent-account";
let api: Record<string, (...args: any[]) => Promise<any>>;
mock.module("@clerk/react", { namedExports: { useUser: () => ({ user: userId ? { id: userId } : null }) } });
mock.module("@workspace/api-client-react", {
  namedExports: Object.fromEntries(
    ["getNestSnapshot", "createNestRecord", "updateNestRecord", "deleteNestRecord", "updateNestMember"]
      .map((name) => [name, async (...args: any[]) => {
        const result = await api[name](...args);
        // Successful updates always return an ID, even when a test handler only changes state.
        return name === "updateNestRecord" && result === undefined ? { id: args[0] } : result;
      }]),
  ),
});
const { useNest } = await import("../src/hooks/use-nest");
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const browser = new EventTarget();
(globalThis as any).window = Object.assign(browser, { setInterval: () => 1, clearInterval: () => {} });
(globalThis as any).document = Object.assign(new EventTarget(), { visibilityState: "visible" });

const initial = (): AppData => ({
  householdId: "household", householdName: "Nest", role: "parent", activeId: "parent",
  members: [{ id: "parent", name: "Parent", avatarId: "bird", role: "parent" }],
  chores: [{ id: "chore", title: "Dishes", done: false }],
  journal: [{ id: "entry", authorId: "parent", body: "Saved words", promptId: "p1", shared: false, createdAt: "2026-10-03T12:00:00Z" }],
  allowance: [], events: [], money: [], schoolTasks: [], goals: [], groceries: [],
  groceryFavorites: [], journalReplies: [], prompts: [],
}) as unknown as AppData;

const pasteDraft = { id: "draft", title: "Milk, oat", quantity: "2 cartons", assignedTo: "parent", cadence: "Once", dueDate: "2026-10-03" };

for (const kind of ["groceries", "chores"] as const) {
  test(`paste ${kind}: append authenticated independent unchecked rows; reload shares records for child`, async () => {
    userId = "parent-account";
    const server = initial();
    server.groceryFavorites = [{ id: "favorite", title: "Favorite", quantity: "" }];
    server.allowance = [{ id: "allowance", title: "Earned", amount: 5, date: "2026-10-03", status: "earned" }];
    const untouched = structuredClone({ allowance: server.allowance, favorites: server.groceryFavorites });
    api = {
      getNestSnapshot: async () => structuredClone({ ...server, role: userId === "child-account" ? "child" : "parent" }),
      createNestRecord: async (body, options) => {
        assert.equal(options.credentials, "include");
        assert.equal(body.kind, kind);
        assert.equal(body.data.done, false);
        assert.ok(!("id" in body.data));
        const id = `saved-${server[kind].length}`;
        (server[kind] as any[]).push({ ...body.data, id });
        return { id };
      },
      updateNestRecord: async (id, { data }) => {
        (server[kind] as any[]) = server[kind].map((row) => row.id === id ? { ...row, ...data } : row);
      },
    };
    const before = server[kind].length;
    const view = await mount();
    await act(async () => {
      assert.equal((await view.nest.appendListItem(kind, pasteDraft)).status, "saved");
      assert.equal((await view.nest.appendListItem(kind, pasteDraft)).status, "saved");
    });
    assert.equal(view.nest.data![kind].length, before + 2);
    assert.equal(server[kind][before].title, "Milk, oat");
    assert.deepEqual({ allowance: server.allowance, favorites: server.groceryFavorites }, untouched);
    await view.close();
    userId = "child-account";
    const child = await mount();
    assert.equal(child.nest.data![kind].length, before + 2);
    await act(async () => {
      assert.equal(await child.nest.setData((old) => ({ ...old, [kind]: old[kind].map((row) => row.id === `saved-${before}` ? { ...row, title: "Edited after reload" } : row) })), true);
    });
    assert.equal(server[kind][before].title, "Edited after reload");
    await child.close();
  });
}

test("paid chore completion immediately displays its returned allowance without a second creation request", async () => {
  userId = "parent-account";
  const server = initial();
  server.chores[0] = { ...server.chores[0], assignedTo: "household", cadence: "Once", dueDate: "2026-10-03", isPaid: true, payAmount: 3.29, allowanceRecorded: false };
  const allowanceEntry = { id: "automatic-credit", title: "Dishes · Household", amount: 3.29, date: "2026-10-03", status: "earned" as const };
  let updates = 0;
  api = {
    getNestSnapshot: async () => structuredClone(server),
    updateNestRecord: async (id, { data }) => {
      assert.equal("allowanceRecorded" in data, false);
      updates++;
      server.chores[0] = { ...server.chores[0], ...data, allowanceRecorded: true };
      server.allowance.push(allowanceEntry);
      return { id, allowanceEntry };
    },
    createNestRecord: async () => { throw new Error("Automatic allowance must not be created again by the client"); },
  };
  const view = await mount();
  await act(async () => {
    assert.equal(await view.nest.setData((old) => ({ ...old, chores: old.chores.map((chore) => ({ ...chore, done: true, completedOn: "2026-10-03" })) })), true);
  });
  assert.equal(updates, 1);
  assert.equal(view.nest.data!.chores[0].allowanceRecorded, true);
  assert.deepEqual(view.nest.data!.allowance, [allowanceEntry]);
  await view.close();
});

test("paste creation lock prevents double submissions; uncertain committed response requires snapshot review", async () => {
  userId = "parent-account";
  const server = initial();
  const response = deferred<void>();
  let writes = 0;
  let offline = false;
  api = {
    getNestSnapshot: async () => {
      if (offline) throw new Error("Offline");
      return structuredClone(server);
    },
    createNestRecord: async ({ data }) => {
      writes++;
      server.groceries.push({ ...data, id: "saved-id" });
      await response.promise;
      throw new Error("Response lost");
    },
  };
  const view = await mount();
  let save!: ReturnType<typeof view.nest.appendListItem>;
  await act(async () => { save = view.nest.appendListItem("groceries", pasteDraft); });
  await act(async () => { assert.equal((await view.nest.appendListItem("groceries", pasteDraft)).status, "blocked"); });
  await act(async () => { response.resolve(); assert.equal((await save).status, "uncertain"); });
  assert.equal(writes, 1);
  await act(async () => { assert.equal((await view.nest.appendListItem("groceries", pasteDraft)).status, "blocked"); });
  offline = true;
  await act(async () => { assert.equal(await view.nest.refreshList(), null); });
  offline = false;
  await act(async () => { assert.equal((await view.nest.refreshList())!.groceries[0].id, "saved-id"); });
  assert.equal(writes, 1);
  assert.equal(view.nest.data!.groceries[0].title, pasteDraft.title);
  await view.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mount() {
  let nest!: ReturnType<typeof useNest>;
  function Form() {
    nest = useNest();
    const [draft, setDraft] = useState("Unsaved journal words");
    return createElement("input", { value: draft, onChange: (e: any) => setDraft(e.target.value) });
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Form)); });
  return { get nest() { return nest; }, renderer, Form, close: () => act(async () => renderer.unmount()) };
}

test("earlier chore saves, later journal fails: reconcile before returning false and keep form input", async () => {
  userId = "parent-account";
  let server = initial();
  const calls: string[] = [];
  let snapshots = 0;
  api = {
    getNestSnapshot: async (options) => {
      assert.equal(options.credentials, "include");
      assert.equal(options.cache, "no-store");
      snapshots++;
      return structuredClone(server);
    },
    updateNestRecord: async (id, { data }, options) => {
      assert.equal(options.credentials, "include");
      assert.ok(!("authorId" in data));
      calls.push(id);
      if (id === "entry") throw { status: 403, data: { error: "Only the author may edit this entry." } };
      server = { ...server, chores: server.chores.map((row) => ({ ...row, ...data })) };
    },
    updateNestMember: async () => { throw new Error("Must not send later member change"); },
  };
  const view = await mount();
  const attempted = {
    ...view.nest.data!,
    chores: view.nest.data!.chores.map((row) => ({ ...row, done: true })),
    journal: view.nest.data!.journal.map((row) => ({ ...row, body: "Pending edit" })),
    members: view.nest.data!.members.map((row) => ({ ...row, name: "Pending name" })),
  };
  let saved = true;
  await act(async () => { saved = await view.nest.setData(attempted); });
  assert.equal(saved, false); // caller must not close/reset its form
  assert.deepEqual(calls, ["chore", "entry"]);
  assert.equal(snapshots, 2);
  assert.equal(view.nest.data!.chores[0].done, true);
  assert.equal(view.nest.data!.journal[0].body, "Saved words");
  assert.equal(view.nest.data!.members[0].name, "Parent");
  assert.match(view.nest.saveError, /Confirmed saved: 1 chore update/);
  assert.match(view.nest.saveError, /Could not confirm journal entry update: Only the author/);
  assert.match(view.nest.saveError, /1 remaining change was not sent/);
  assert.doesNotMatch(view.nest.saveError, /unchanged/);
  assert.equal(attempted.journal[0].body, "Pending edit");
  assert.equal(view.renderer.root.findByType("input").props.value, "Unsaved journal words");

  // Retry diffs from reconciled server data; the chore is not sent a second time.
  api.updateNestRecord = async (id) => { calls.push(id); throw new Error("Still unavailable"); };
  await act(async () => { await view.nest.setData(attempted); });
  assert.deepEqual(calls, ["chore", "entry", "entry"]);
  await view.close();
});

test("journal creation succeeds before a member failure, without modifying the caller's draft ID", async () => {
  userId = "parent-account";
  let server = initial();
  api = {
    getNestSnapshot: async () => structuredClone(server),
    createNestRecord: async ({ kind, data }) => {
      assert.equal(kind, "journal");
      assert.ok(!("authorId" in data));
      assert.ok(!("createdAt" in data));
      server.journal.push({ ...data, id: "server-entry", authorId: "parent", createdAt: "2026-10-03T13:00:00Z" });
      return { id: "server-entry" };
    },
    updateNestMember: async () => { throw new Error("Member update failed"); },
  };
  const view = await mount();
  const draft = { ...server.journal[0], id: "draft-id", body: "New private entry" };
  const attempted = { ...view.nest.data!, journal: [...view.nest.data!.journal, draft], members: view.nest.data!.members.map((row) => ({ ...row, name: "New name" })) };
  await act(async () => { assert.equal(await view.nest.setData(attempted), false); });
  assert.equal(draft.id, "draft-id");
  assert.equal(view.nest.data!.journal[1].id, "server-entry");
  assert.equal(view.nest.data!.journal[1].authorId, "parent");
  assert.match(view.nest.saveError, /Confirmed saved: 1 journal entry addition/);
  assert.match(view.nest.saveError, /Could not confirm member profile update/);
  await view.close();
});

test("journal and an earlier member update stay saved when a later member update fails", async () => {
  userId = "parent-account";
  let server = initial();
  server.members.push({ ...server.members[0], id: "child", name: "Child", role: "child" });
  api = {
    getNestSnapshot: async () => structuredClone(server),
    updateNestRecord: async (_id, { data }) => { server.journal[0] = { ...server.journal[0], ...data }; },
    updateNestMember: async (id, data) => {
      if (id === "child") throw new Error("Child profile failed");
      server.members = server.members.map((row) => row.id === id ? { ...row, ...data } : row);
    },
  };
  const view = await mount();
  await act(async () => {
    assert.equal(await view.nest.setData((old) => ({
      ...old, journal: old.journal.map((row) => ({ ...row, body: "Saved edit" })),
      members: old.members.map((row) => ({ ...row, name: `${row.name} edited` })),
    })), false);
  });
  assert.equal(view.nest.data!.journal[0].body, "Saved edit");
  assert.deepEqual(view.nest.data!.members.map((row) => row.name), ["Parent edited", "Child"]);
  assert.match(view.nest.saveError, /Confirmed saved: 1 journal entry update, 1 member profile update/);
  await view.close();
});

test("journal deletion reconciles its atomically removed replies after a later failure", async () => {
  userId = "parent-account";
  let server = initial();
  server.journalReplies = [{ id: "reply", entryId: "entry", authorId: "parent", body: "Reply", createdAt: "2026-10-03T12:00:00Z" }];
  api = {
    getNestSnapshot: async () => structuredClone(server),
    deleteNestRecord: async (id) => {
      assert.equal(id, "entry"); // no separate deletion of its replies
      server = { ...server, journal: [], journalReplies: [] };
    },
    updateNestMember: async () => { throw new Error("Member profile failed"); },
  };
  const view = await mount();
  await act(async () => {
    assert.equal(await view.nest.setData((old) => ({
      ...old, journal: [], members: old.members.map((row) => ({ ...row, name: "Pending name" })),
    })), false);
  });
  assert.deepEqual(view.nest.data!.journal, []);
  assert.deepEqual(view.nest.data!.journalReplies, []);
  assert.match(view.nest.saveError, /Confirmed saved: 1 journal entry deletion/);
  await view.close();
});

test("reconciliation finishes before save returns and does not allow overlapping writes", async () => {
  userId = "parent-account";
  const snapshot = deferred<AppData>();
  let reads = 0;
  let writes = 0;
  api = {
    getNestSnapshot: async () => ++reads === 1 ? initial() : snapshot.promise,
    updateNestRecord: async () => { writes++; throw new Error("Journal update failed"); },
  };
  const view = await mount();
  let save!: Promise<boolean>;
  let finished = false;
  const edit = (old: AppData) => ({ ...old, journal: old.journal.map((row) => ({ ...row, body: "Pending" })) });
  await act(async () => { save = view.nest.setData(edit).then((result) => { finished = true; return result; }); });
  assert.equal(finished, false);
  assert.equal(view.nest.saving, true);
  await act(async () => {
    assert.equal(await view.nest.setData(edit), false);
    await view.nest.refresh();
  });
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  await act(async () => { snapshot.resolve(initial()); assert.equal(await save, false); });
  assert.equal(view.nest.saving, false);
  await view.close();
});

test("a lost response can still have saved: use the snapshot, never claim rollback", async () => {
  userId = "parent-account";
  let server = initial();
  api = {
    getNestSnapshot: async () => structuredClone(server),
    updateNestRecord: async (_id, { data }) => {
      server.journal[0] = { ...server.journal[0], ...data };
      throw new Error("Response lost");
    },
  };
  const view = await mount();
  await act(async () => {
    assert.equal(await view.nest.setData((old) => ({ ...old, journal: old.journal.map((row) => ({ ...row, body: "Actually saved" })) })), false);
  });
  assert.equal(view.nest.data!.journal[0].body, "Actually saved");
  assert.match(view.nest.saveError, /Could not confirm journal entry update/);
  assert.match(view.nest.saveError, /latest saved household data/);
  await view.close();
});

test("failed reconciliation preserves form input and pauses writes until refresh succeeds", async () => {
  userId = "parent-account";
  let reads = 0;
  let writes = 0;
  api = {
    getNestSnapshot: async () => {
      if (++reads > 1) throw new Error("Offline");
      return initial();
    },
    updateNestRecord: async () => { writes++; throw new Error("Offline"); },
  };
  const view = await mount();
  const edit = (old: AppData) => ({ ...old, journal: old.journal.map((row) => ({ ...row, body: "Pending" })) });
  await act(async () => { assert.equal(await view.nest.setData(edit), false); });
  assert.equal(view.nest.loadError, "");
  assert.equal(view.renderer.root.findByType("input").props.value, "Unsaved journal words");
  assert.match(view.nest.saveError, /Some changes may have saved/);
  await act(async () => { assert.equal(await view.nest.setData(edit), false); });
  assert.equal(writes, 1);
  await act(async () => { await view.nest.refresh(); }); // polling remains offline
  assert.equal(view.nest.loadError, "");
  assert.equal(view.renderer.root.findByType("input").props.value, "Unsaved journal words");
  api.getNestSnapshot = async () => initial();
  await act(async () => { await view.nest.refresh(); });
  assert.match(view.nest.saveError, /Showing the latest saved household data/);
  assert.doesNotMatch(view.nest.saveError, /saving is paused/);
  await act(async () => { await view.nest.setData(edit); });
  assert.equal(writes, 2);
  await view.close();
});

for (const status of [401, 403, 404]) {
  test(`reconciliation clears private data when authorized snapshot returns ${status}`, async () => {
    userId = "parent-account";
    let reads = 0;
    api = {
      getNestSnapshot: async () => {
        if (++reads > 1) throw { status, message: "Access lost" };
        return initial();
      },
      updateNestRecord: async () => { throw new Error("Save failed"); },
    };
    const view = await mount();
    await act(async () => {
      await view.nest.setData((old) => ({ ...old, journal: old.journal.map((row) => ({ ...row, body: "Pending" })) }));
    });
    assert.equal(view.nest.data, null);
    assert.equal(view.nest.needsSetup, status === 404);
    await view.close();
  });
}

test("switching accounts during a mutation stops old writes and rejects old snapshots", async () => {
  userId = "parent-account";
  const mutation = deferred<void>();
  const calls: string[] = [];
  api = {
    getNestSnapshot: async () => userId === "parent-account" ? initial() : { ...initial(), householdId: "other-household", journal: [] },
    updateNestRecord: async (id) => { calls.push(id); await mutation.promise; },
  };
  const view = await mount();
  let save!: Promise<boolean>;
  await act(async () => {
    save = view.nest.setData((old) => ({ ...old, chores: old.chores.map((row) => ({ ...row, done: true })), journal: old.journal.map((row) => ({ ...row, body: "Do not send" })) }));
  });
  userId = "other-account";
  await act(async () => { view.renderer.update(createElement(view.Form)); });
  await act(async () => { mutation.resolve(); assert.equal(await save, false); });
  assert.deepEqual(calls, ["chore"]);
  assert.equal(view.nest.data!.householdId, "other-household");
  assert.deepEqual(view.nest.data!.journal, []);
  assert.equal(view.nest.saveError, "");
  assert.equal(view.nest.saving, false);
  await view.close();
});

test("a reconciliation snapshot arriving after an account switch is discarded", async () => {
  userId = "parent-account";
  const snapshot = deferred<AppData>();
  let reads = 0;
  api = {
    getNestSnapshot: async () => {
      if (++reads === 2) return snapshot.promise;
      return userId === "parent-account" ? initial() : { ...initial(), householdId: "other-household", journal: [] };
    },
    updateNestRecord: async () => { throw new Error("Save failed"); },
  };
  const view = await mount();
  let save!: Promise<boolean>;
  await act(async () => {
    save = view.nest.setData((old) => ({ ...old, journal: old.journal.map((row) => ({ ...row, body: "Pending" })) }));
  });
  userId = "other-account";
  await act(async () => { view.renderer.update(createElement(view.Form)); });
  await act(async () => { snapshot.resolve(initial()); assert.equal(await save, false); });
  assert.equal(view.nest.data!.householdId, "other-household");
  assert.deepEqual(view.nest.data!.journal, []);
  assert.equal(view.nest.saveError, "");
  await view.close();
});