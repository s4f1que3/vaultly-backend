import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Injectable()
export class SummariesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
  ) {}

  private round2(n: number) { return Math.round(n * 100) / 100; }

  private monthBounds(month: number, year: number) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = new Date(year, month, 0).toISOString().split('T')[0];
    return { start, end };
  }

  private prevMonthYear(month: number, year: number) {
    return month === 1
      ? { month: 12, year: year - 1 }
      : { month: month - 1, year };
  }

  // ─── Monthly Summary ──────────────────────────────────────────────────────

  async getMonthlySummary(userId: string, month: number, year: number) {
    await this.categories.ensureDefaults(userId);
    const { start, end } = this.monthBounds(month, year);

    // All transactions for the month
    const { data: txs } = await this.supabase.db
      .from('Transactions').select('*')
      .eq('user_id', userId).gte('date', start).lte('date', end)
      .order('date', { ascending: false });

    const allTxs = txs ?? [];
    const expenses = allTxs.filter((t: { type: string }) => t.type === 'expense');
    const income = allTxs.filter((t: { type: string }) => t.type === 'income');

    const totalExpenses = expenses.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const totalIncome = income.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const netSavings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;

    // ── By category ──
    const catMap = new Map<string, number>();
    for (const tx of expenses) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      catMap.set(slug, (catMap.get(slug) ?? 0) + tx.amount);
    }
    const byCategory = [...catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({
        category,
        amount: this.round2(amount),
        percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
      }));

    // ── Budget performance ──
    const { data: budgets } = await this.supabase.db
      .from('Budgets').select('*')
      .eq('user_id', userId).eq('month', month).eq('year', year);

    const budgetPerformance = await Promise.all(
      (budgets ?? []).map(async (b: Record<string, number & string>) => {
        const slug = await this.categories.resolveSlug(userId, b.category_id as string);
        const utilization = b.limit_amount > 0
          ? Math.round((b.spent_amount / b.limit_amount) * 100) : 0;
        return {
          category: slug,
          limit: b.limit_amount,
          spent: this.round2(b.spent_amount),
          remaining: this.round2(b.limit_amount - b.spent_amount),
          utilizationPct: utilization,
          status: b.spent_amount > b.limit_amount ? 'exceeded'
            : utilization >= b.alert_threshold ? 'warning'
            : 'ok',
        };
      }),
    );

    // ── By card ──
    const { data: cards } = await this.supabase.db
      .from('Cards').select('id, card_number, card_holder, card_type')
      .eq('user_id', userId);

    const cardMap = new Map<string, number>();
    for (const tx of expenses) {
      if (tx.card_id) {
        cardMap.set(tx.card_id, (cardMap.get(tx.card_id) ?? 0) + tx.amount);
      }
    }
    const byCard = [...cardMap.entries()]
      .map(([cardId, amount]) => {
        const card = (cards ?? []).find((c: { id: string }) => c.id === cardId) as
          { card_number: string; card_holder: string; card_type: string } | undefined;
        return {
          cardId,
          lastFour: card?.card_number ?? '????',
          holder: card?.card_holder ?? 'Unknown',
          type: card?.card_type ?? 'unknown',
          amount: this.round2(amount),
          percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    // Transactions with no linked card
    const unlinkedTotal = expenses
      .filter((t: { card_id: string | null }) => !t.card_id)
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    if (unlinkedTotal > 0) {
      byCard.push({
        cardId: null as unknown as string,
        lastFour: '—',
        holder: 'Cash / Unlinked',
        type: 'other',
        amount: this.round2(unlinkedTotal),
        percentage: totalExpenses > 0 ? Math.round((unlinkedTotal / totalExpenses) * 100) : 0,
      });
    }

    // ── Top merchants ──
    const merchantMap = new Map<string, { total: number; count: number }>();
    for (const tx of expenses) {
      if (tx.merchant) {
        const curr = merchantMap.get(tx.merchant) ?? { total: 0, count: 0 };
        merchantMap.set(tx.merchant, { total: curr.total + tx.amount, count: curr.count + 1 });
      }
    }
    const topMerchants = [...merchantMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([merchant, s]) => ({
        merchant,
        total: this.round2(s.total),
        transactionCount: s.count,
        avgPerVisit: this.round2(s.total / s.count),
        percentage: totalExpenses > 0 ? Math.round((s.total / totalExpenses) * 100) : 0,
      }));

    // ── Daily spending ──
    const dailyMap = new Map<string, { expenses: number; income: number }>();
    for (const tx of allTxs) {
      const curr = dailyMap.get(tx.date) ?? { expenses: 0, income: 0 };
      if (tx.type === 'expense') curr.expenses += tx.amount;
      if (tx.type === 'income') curr.income += tx.amount;
      dailyMap.set(tx.date, curr);
    }
    const dailyBreakdown = [...dailyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({
        date,
        expenses: this.round2(v.expenses),
        income: this.round2(v.income),
        net: this.round2(v.income - v.expenses),
      }));

    // ── Biggest expense transactions ──
    const topTransactions = await Promise.all(
      [...expenses]
        .sort((a: { amount: number }, b: { amount: number }) => b.amount - a.amount)
        .slice(0, 10)
        .map(async (tx: Record<string, unknown>) => ({
          id: tx.id,
          amount: tx.amount,
          description: tx.description,
          merchant: tx.merchant,
          date: tx.date,
          category: await this.categories.resolveSlug(userId, tx.category_id as string),
          card_id: tx.card_id,
        })),
    );

    // ── Subscriptions charged this month ──
    const { data: subTxs } = await this.supabase.db
      .from('Transactions').select('amount, description')
      .eq('user_id', userId)
      .eq('type', 'expense')
      .ilike('description', '%subscription%')
      .gte('date', start).lte('date', end);
    const subscriptionTotal = (subTxs ?? [])
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);

    // ── Goals snapshot ──
    const { data: goals } = await this.supabase.db
      .from('Savings').select('*').eq('user_id', userId);
    const goalsSnapshot = (goals ?? []).map((g: Record<string, unknown>) => ({
      name: g.name,
      targetAmount: g.target_amount,
      currentAmount: g.current_amount,
      progressPct: (g.target_amount as number) > 0
        ? Math.round(((g.current_amount as number) / (g.target_amount as number)) * 100) : 0,
      status: g.status,
      deadline: g.deadline,
    }));

    // ── Comparison to previous month ──
    const prev = this.prevMonthYear(month, year);
    const { start: prevStart, end: prevEnd } = this.monthBounds(prev.month, prev.year);
    const { data: prevTxs } = await this.supabase.db
      .from('Transactions').select('amount, type')
      .eq('user_id', userId).gte('date', prevStart).lte('date', prevEnd);

    const prevExpenses = (prevTxs ?? [])
      .filter((t: { type: string }) => t.type === 'expense')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const prevIncome = (prevTxs ?? [])
      .filter((t: { type: string }) => t.type === 'income')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);

    return {
      period: {
        month, year,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        start, end,
      },
      overview: {
        totalIncome: this.round2(totalIncome),
        totalExpenses: this.round2(totalExpenses),
        netSavings: this.round2(netSavings),
        savingsRate: Math.round(savingsRate),
        transactionCount: allTxs.length,
        expenseCount: expenses.length,
        incomeCount: income.length,
        subscriptionTotal: this.round2(subscriptionTotal),
        avgDailySpend: this.round2(totalExpenses / new Date(year, month, 0).getDate()),
      },
      vsLastMonth: {
        prevMonth: `${MONTH_NAMES[prev.month - 1]} ${prev.year}`,
        expenseChange: prevExpenses > 0
          ? Math.round(((totalExpenses - prevExpenses) / prevExpenses) * 100) : null,
        incomeChange: prevIncome > 0
          ? Math.round(((totalIncome - prevIncome) / prevIncome) * 100) : null,
        expenseDiff: this.round2(totalExpenses - prevExpenses),
        incomeDiff: this.round2(totalIncome - prevIncome),
      },
      byCategory,
      budgetPerformance,
      byCard,
      topMerchants,
      dailyBreakdown,
      topTransactions,
      goalsSnapshot,
    };
  }

  // ─── Yearly Summary ───────────────────────────────────────────────────────

  async getYearlySummary(userId: string, year: number) {
    await this.categories.ensureDefaults(userId);
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    // All transactions for the year
    const { data: txs } = await this.supabase.db
      .from('Transactions').select('*')
      .eq('user_id', userId).gte('date', start).lte('date', end);

    const allTxs = txs ?? [];
    const expenses = allTxs.filter((t: { type: string }) => t.type === 'expense');
    const income = allTxs.filter((t: { type: string }) => t.type === 'income');

    const totalExpenses = expenses.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const totalIncome = income.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const netSavings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;

    // ── Month-by-month breakdown ──
    const monthlyBreakdown = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const m = i + 1;
        const mExpenses = expenses.filter(
          (t: { date: string }) => new Date(t.date).getMonth() + 1 === m,
        );
        const mIncome = income.filter(
          (t: { date: string }) => new Date(t.date).getMonth() + 1 === m,
        );
        const mExp = mExpenses.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
        const mInc = mIncome.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
        const mNet = mInc - mExp;
        return {
          month: m,
          label: MONTH_NAMES[i],
          income: this.round2(mInc),
          expenses: this.round2(mExp),
          netSavings: this.round2(mNet),
          savingsRate: mInc > 0 ? Math.round((mNet / mInc) * 100) : 0,
          transactionCount: mExpenses.length + mIncome.length,
        };
      }),
    );

    const activeMonths = monthlyBreakdown.filter(m => m.transactionCount > 0);
    const bestMonth = activeMonths.length
      ? activeMonths.reduce((best, m) => m.netSavings > best.netSavings ? m : best, activeMonths[0])
      : null;
    const worstMonth = activeMonths.length
      ? activeMonths.reduce((worst, m) => m.expenses > worst.expenses ? m : worst, activeMonths[0])
      : null;

    // ── By category (full year) ──
    const catMap = new Map<string, number>();
    for (const tx of expenses) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      catMap.set(slug, (catMap.get(slug) ?? 0) + tx.amount);
    }
    const byCategory = [...catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({
        category,
        amount: this.round2(amount),
        percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
        avgPerMonth: this.round2(amount / 12),
      }));

    // ── By card (full year) ──
    const { data: cards } = await this.supabase.db
      .from('Cards').select('id, card_number, card_holder, card_type')
      .eq('user_id', userId);

    const cardMap = new Map<string, number>();
    for (const tx of expenses) {
      if (tx.card_id) {
        cardMap.set(tx.card_id, (cardMap.get(tx.card_id) ?? 0) + tx.amount);
      }
    }
    const byCard = [...cardMap.entries()]
      .map(([cardId, amount]) => {
        const card = (cards ?? []).find((c: { id: string }) => c.id === cardId) as
          { card_number: string; card_holder: string; card_type: string } | undefined;
        return {
          cardId,
          lastFour: card?.card_number ?? '????',
          holder: card?.card_holder ?? 'Unknown',
          type: card?.card_type ?? 'unknown',
          amount: this.round2(amount),
          percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    // ── Top merchants (full year) ──
    const merchantMap = new Map<string, { total: number; count: number }>();
    for (const tx of expenses) {
      if (tx.merchant) {
        const curr = merchantMap.get(tx.merchant) ?? { total: 0, count: 0 };
        merchantMap.set(tx.merchant, { total: curr.total + tx.amount, count: curr.count + 1 });
      }
    }
    const topMerchants = [...merchantMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15)
      .map(([merchant, s]) => ({
        merchant,
        total: this.round2(s.total),
        transactionCount: s.count,
        avgPerVisit: this.round2(s.total / s.count),
        percentage: totalExpenses > 0 ? Math.round((s.total / totalExpenses) * 100) : 0,
      }));

    // ── Budget summary across the year (all months) ──
    const { data: allBudgets } = await this.supabase.db
      .from('Budgets').select('*')
      .eq('user_id', userId).eq('year', year)
      .order('month');

    const budgetYearMap = new Map<string, { totalLimit: number; totalSpent: number; months: number }>();
    for (const b of allBudgets ?? []) {
      const slug = await this.categories.resolveSlug(userId, b.category_id as string);
      const curr = budgetYearMap.get(slug) ?? { totalLimit: 0, totalSpent: 0, months: 0 };
      budgetYearMap.set(slug, {
        totalLimit: curr.totalLimit + b.limit_amount,
        totalSpent: curr.totalSpent + b.spent_amount,
        months: curr.months + 1,
      });
    }
    const budgetYearSummary = [...budgetYearMap.entries()]
      .map(([category, data]) => ({
        category,
        totalLimit: this.round2(data.totalLimit),
        totalSpent: this.round2(data.totalSpent),
        avgMonthlyLimit: this.round2(data.totalLimit / data.months),
        avgMonthlySpent: this.round2(data.totalSpent / data.months),
        overallUtilization: data.totalLimit > 0
          ? Math.round((data.totalSpent / data.totalLimit) * 100) : 0,
        monthsTracked: data.months,
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent);

    // ── Goals progress at year end ──
    const { data: goals } = await this.supabase.db
      .from('Savings').select('*').eq('user_id', userId);
    const goalsSnapshot = (goals ?? []).map((g: Record<string, unknown>) => ({
      name: g.name,
      targetAmount: g.target_amount,
      currentAmount: g.current_amount,
      progressPct: (g.target_amount as number) > 0
        ? Math.round(((g.current_amount as number) / (g.target_amount as number)) * 100) : 0,
      status: g.status,
      deadline: g.deadline,
    }));

    // ── Comparison to previous year ──
    const { data: prevYearTxs } = await this.supabase.db
      .from('Transactions').select('amount, type')
      .eq('user_id', userId)
      .gte('date', `${year - 1}-01-01`)
      .lte('date', `${year - 1}-12-31`);

    const prevYearExpenses = (prevYearTxs ?? [])
      .filter((t: { type: string }) => t.type === 'expense')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const prevYearIncome = (prevYearTxs ?? [])
      .filter((t: { type: string }) => t.type === 'income')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);

    // ── Subscription cost for the year ──
    const { data: subTxs } = await this.supabase.db
      .from('Transactions').select('amount')
      .eq('user_id', userId).eq('type', 'expense')
      .ilike('description', '%subscription%')
      .gte('date', start).lte('date', end);
    const totalSubscriptionCost = (subTxs ?? [])
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);

    return {
      period: { year, label: String(year), start, end },
      overview: {
        totalIncome: this.round2(totalIncome),
        totalExpenses: this.round2(totalExpenses),
        netSavings: this.round2(netSavings),
        savingsRate: Math.round(savingsRate),
        transactionCount: allTxs.length,
        avgMonthlyIncome: this.round2(totalIncome / 12),
        avgMonthlyExpenses: this.round2(totalExpenses / 12),
        avgMonthlySavings: this.round2(netSavings / 12),
        totalSubscriptionCost: this.round2(totalSubscriptionCost),
      },
      vsLastYear: {
        expenseChange: prevYearExpenses > 0
          ? Math.round(((totalExpenses - prevYearExpenses) / prevYearExpenses) * 100) : null,
        incomeChange: prevYearIncome > 0
          ? Math.round(((totalIncome - prevYearIncome) / prevYearIncome) * 100) : null,
        expenseDiff: this.round2(totalExpenses - prevYearExpenses),
        incomeDiff: this.round2(totalIncome - prevYearIncome),
      },
      highlights: {
        bestMonth: bestMonth ? { label: bestMonth.label, netSavings: bestMonth.netSavings } : null,
        worstMonth: worstMonth ? { label: worstMonth.label, expenses: worstMonth.expenses } : null,
        highestSpendCategory: byCategory[0] ?? null,
        topMerchant: topMerchants[0] ?? null,
      },
      monthlyBreakdown,
      byCategory,
      budgetYearSummary,
      byCard,
      topMerchants,
      goalsSnapshot,
    };
  }

  // ─── Available summary periods ─────────────────────────────────────────────
  // Returns all months/years the user has transaction data for

  async getAvailablePeriods(userId: string) {
    const { data } = await this.supabase.db
      .from('Transactions')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    const seen = new Set<string>();
    const months: { month: number; year: number; label: string }[] = [];
    const years = new Set<number>();

    for (const tx of data ?? []) {
      const d = new Date(tx.date);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const key = `${y}-${m}`;
      if (!seen.has(key)) {
        seen.add(key);
        months.push({ month: m, year: y, label: `${MONTH_NAMES[m - 1]} ${y}` });
      }
      years.add(y);
    }

    return {
      months: months.slice(0, 24),
      years: [...years].sort((a, b) => b - a),
    };
  }
}
