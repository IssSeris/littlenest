import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeBudget, normalizeCategory, shiftBudgetMonth, type BudgetPlan, type MoneyEntry } from "./budget";

const plan: BudgetPlan = { id: "plan", month: "2026-10", incomeTarget: 2000, savingsTarget: 300, note: "", categories: [{ category: "Groceries", amount: 200 }, { category: "Home care", amount: 100 }] };
const entry = (id: string, amount: number, category: string, kind: "income" | "expense" = "expense", date = "2026-10-03"): MoneyEntry => ({ id, title: "Repeated titles are valid", amount, category, kind, date });

test("budget actuals include all matching notes and exclude other months", () => {
  const result = summarizeBudget([
    entry("1", 2000, "Pay", "income"), entry("2", 100, " groceries "), entry("3", 150, "GROCERIES"),
    entry("4", 50, "Home  care"), entry("5", 25, "Transport"), entry("6", 999, "Groceries", "expense", "2026-09-30"),
  ], "2026-10", plan);
  assert.equal(result.income, 2000);
  assert.equal(result.spending, 325);
  assert.equal(result.net, 1675);
  assert.equal(result.plannedSpending, 300);
  assert.equal(result.remaining, -25);
  assert.equal(result.unassigned, 1400);
  assert.equal(result.categories[0].spent, 250);
  assert.equal(result.categories[0].remaining, -50);
  assert.equal(result.categories[0].percent, 125);
  assert.equal(result.categories[1].spent, 50);
  assert.deepEqual(result.unbudgeted, [{ category: "Transport", spent: 25 }]);
});
test("currency totals use cents, and an empty plan still reports actuals", () => {
  const result = summarizeBudget([entry("1", 0.1, "Food"), entry("2", 0.2, "Food")], "2026-10");
  assert.equal(result.spending, 0.3);
  assert.equal(result.net, -0.3);
  assert.deepEqual(result.categories, []);
});
test("month navigation crosses year boundaries and category matching ignores case and spacing", () => {
  assert.equal(shiftBudgetMonth("2026-12", 1), "2027-01");
  assert.equal(shiftBudgetMonth("2026-01", -1), "2025-12");
  assert.equal(normalizeCategory(" Home  CARE "), "home care");
});