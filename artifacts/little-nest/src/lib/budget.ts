import type { NestBudgetPlan } from "@workspace/api-client-react";

export type BudgetPlan = NestBudgetPlan;
export type BudgetDraft = Omit<BudgetPlan, "id">;
export type MoneyEntry = { id: string; title: string; amount: number; date: string; category: string; kind: "income" | "expense" };
export const categorySuggestions = ["Housing", "Groceries", "Utilities", "Transportation", "Health", "Family", "Subscriptions", "Entertainment", "Household", "Other"];
export const normalizeCategory = (category: string) => category.trim().replace(/\s+/g, " ").toLocaleLowerCase();
export const formatMoney = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
export const currentBudgetMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};
export const shiftBudgetMonth = (month: string, offset: number) => {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(year, number - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
export const budgetMonthLabel = (month: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00`));
const cents = (amount: number) => Math.round(amount * 100);

export function summarizeBudget(entries: MoneyEntry[], month: string, plan?: BudgetPlan) {
  const monthly = entries.filter((entry) => entry.date.startsWith(`${month}-`));
  const income = monthly.filter((entry) => entry.kind === "income").reduce((sum, entry) => sum + cents(entry.amount), 0);
  const spending = monthly.filter((entry) => entry.kind === "expense").reduce((sum, entry) => sum + cents(entry.amount), 0);
  const spentByCategory = new Map<string, { category: string; cents: number }>();
  for (const entry of monthly.filter((entry) => entry.kind === "expense")) {
    const key = normalizeCategory(entry.category);
    const group = spentByCategory.get(key) ?? { category: entry.category.trim(), cents: 0 };
    group.cents += cents(entry.amount);
    spentByCategory.set(key, group);
  }
  const planned = (plan?.categories ?? []).reduce((sum, line) => sum + cents(line.amount), 0);
  const categories = (plan?.categories ?? []).map((line) => {
    const actual = spentByCategory.get(normalizeCategory(line.category))?.cents ?? 0;
    return { ...line, spent: actual / 100, remaining: (cents(line.amount) - actual) / 100, percent: line.amount > 0 ? actual / cents(line.amount) * 100 : 0 };
  });
  const plannedKeys = new Set(categories.map((line) => normalizeCategory(line.category)));
  const unbudgeted = [...spentByCategory.entries()].filter(([key]) => !plannedKeys.has(key)).map(([, group]) => ({ category: group.category, spent: group.cents / 100 })).sort((a, b) => b.spent - a.spent);
  return {
    income: income / 100, spending: spending / 100, net: (income - spending) / 100,
    plannedSpending: planned / 100, remaining: (planned - spending) / 100,
    unassigned: (cents(plan?.incomeTarget ?? 0) - planned - cents(plan?.savingsTarget ?? 0)) / 100,
    categories, unbudgeted, entryCount: monthly.length,
  };
}