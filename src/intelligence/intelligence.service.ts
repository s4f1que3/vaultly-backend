import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';
import { SimulateDto } from './intelligence.dto';

// Built-in merchant → category heuristics (checked before DB rules)
const MERCHANT_PATTERNS: { pattern: RegExp; category: string }[] = [
  { pattern: /amazon|etsy|ebay|shopify|zalando|aliexpress|walmart|target|bestbuy/i, category: 'shopping' },
  { pattern: /uber|lyft|grab|bolt|taxi|transit|metro|bus|train|airline|airbnb|rental\s*car/i, category: 'transport' },
  { pattern: /netflix|spotify|apple\.com|disney|hulu|youtube|twitch|steam|playstation|xbox|prime\s*video/i, category: 'entertainment' },
  { pattern: /mcdonald|starbucks|subway|pizza|restaurant|cafe|grubhub|doordash|ubereats|chipotle|kfc|burger|sushi|diner/i, category: 'food' },
  { pattern: /pharmacy|hospital|clinic|doctor|cvs|walgreens|rite\s*aid|dental|medical|optician|urgent\s*care/i, category: 'health' },
  { pattern: /electricity|water\s*bill|internet|comcast|verizon|at&t|utility|electric|broadband|t-mobile|xfinity/i, category: 'utilities' },
  { pattern: /rent|mortgage|landlord|realty|apartment|property\s*mgmt/i, category: 'housing' },
  { pattern: /school|university|tuition|coursera|udemy|edx|khan\s*academy|linkedin\s*learning|pluralsight/i, category: 'education' },
  { pattern: /payroll|salary|direct\s*deposit|employer\s*pay/i, category: 'salary' },
  { pattern: /robinhood|fidelity|vanguard|schwab|etrade|coinbase|binance|crypto|stocks?|brokerage/i, category: 'investment' },
];

@Injectable()
export class IntelligenceService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
  ) {}

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }

  private daysFromNow(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  }

  private round2(n: number) {
    return Math.round(n * 100) / 100;
  }

  // ─── 1. Real-Time Safe-to-Spend ───────────────────────────────────────────
  // Balance − committed bills this month − projected daily burn − goal pacing

  async getSafeToSpend(userId: string) {
    const today = new Date();
    const daysLeftInMonth =
      new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      .toISOString().split('T')[0];

    // Total balance across all cards
    const { data: cards } = await this.supabase.db
      .from('Cards').select('balance').eq('user_id', userId);
    const totalBalance = (cards ?? []).reduce(
      (s: number, c: { balance: number }) => s + (c.balance || 0), 0,
    );

    // Upcoming subscriptions due before end of current month
    const { data: subs } = await this.supabase.db
      .from('Subscriptions')
      .select('amount, next_due_date, company')
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('next_due_date', endOfMonth);
    const committedBills = (subs ?? []).reduce(
      (s: number, sub: { amount: number }) => s + sub.amount, 0,
    );

    // Average daily spending over the last 30 days
    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('type', 'expense')
      .gte('date', this.daysAgo(30));
    const avgDailySpend =
      (txs ?? []).reduce((s: number, t: { amount: number }) => s + t.amount, 0) / 30;

    // Monthly pacing required for active goals with deadlines
    const { data: goals } = await this.supabase.db
      .from('Savings').select('target_amount, current_amount, deadline')
      .eq('user_id', userId).eq('status', 'active');
    let goalCommitments = 0;
    for (const goal of goals ?? []) {
      if (goal.deadline) {
        const monthsLeft = Math.max(
          1,
          (new Date(goal.deadline).getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 30),
        );
        const remaining = goal.target_amount - goal.current_amount;
        goalCommitments += Math.max(0, remaining / monthsLeft);
      }
    }

    const projectedSpend = avgDailySpend * daysLeftInMonth;
    const safeToSpend = Math.max(0, totalBalance - committedBills - projectedSpend - goalCommitments);

    return {
      safeToSpend: this.round2(safeToSpend),
      totalBalance: this.round2(totalBalance),
      breakdown: {
        committedBills: this.round2(committedBills),
        projectedDailySpend: this.round2(projectedSpend),
        goalCommitments: this.round2(goalCommitments),
        avgDailySpend: this.round2(avgDailySpend),
        daysLeftInMonth,
      },
      upcomingBills: (subs ?? []).map((s: { company: string; amount: number; next_due_date: string }) => ({
        name: s.company,
        amount: s.amount,
        dueDate: s.next_due_date,
      })),
    };
  }

  // ─── 2. Decision Simulator ────────────────────────────────────────────────
  // "If I buy X, what happens to my budget / goals / cash flow?"

  async simulate(userId: string, dto: SimulateDto) {
    const { amount, category } = dto;
    const today = new Date();

    const sts = await this.getSafeToSpend(userId);

    // Budget impact for this category — current month only
    await this.categories.ensureDefaults(userId);
    const categoryId = await this.categories.resolveId(userId, category);
    const { data: budget } = await this.supabase.db
      .from('Budgets').select('*')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month', today.getMonth() + 1)
      .eq('year', today.getFullYear())
      .single();

    let budgetImpact: object | null = null;
    if (budget) {
      const newSpent = (budget.spent_amount as number) + amount;
      budgetImpact = {
        category,
        currentSpent: budget.spent_amount,
        limit: budget.limit_amount,
        newSpent,
        remaining: this.round2((budget.limit_amount as number) - newSpent),
        percentageUsed: Math.round((newSpent / (budget.limit_amount as number)) * 100),
        wouldExceed: newSpent > (budget.limit_amount as number),
        wouldTriggerAlert:
          newSpent / (budget.limit_amount as number) >= (budget.alert_threshold as number) / 100,
      };
    }

    // Monthly income vs expense to calculate savings rate
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString().split('T')[0];
    const { data: monthTxs } = await this.supabase.db
      .from('Transactions').select('amount, type')
      .eq('user_id', userId).gte('date', startOfMonth);

    const monthlyIncome = (monthTxs ?? [])
      .filter((t: { type: string }) => t.type === 'income')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const monthlyExpenses = (monthTxs ?? [])
      .filter((t: { type: string }) => t.type === 'expense')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);

    // Annualise to full-month projection based on elapsed days
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const elapsed = dayOfMonth / daysInMonth;
    const projectedMonthlySavings = elapsed > 0
      ? (monthlyIncome - monthlyExpenses) / elapsed
      : 0;

    // How many days does this purchase delay each active goal?
    const { data: goals } = await this.supabase.db
      .from('Savings').select('*').eq('user_id', userId).eq('status', 'active');
    const goalImpacts = (goals ?? []).map((goal: {
      id: string; name: string; target_amount: number; current_amount: number;
    }) => {
      const remaining = goal.target_amount - goal.current_amount;
      if (projectedMonthlySavings <= 0) {
        return { goalId: goal.id, name: goal.name, daysDelayed: null, message: 'Cannot calculate — no projected savings' };
      }
      const currentMonths = remaining / projectedMonthlySavings;
      const newMonths = remaining / Math.max(1, projectedMonthlySavings - amount);
      const daysDelayed = Math.round((newMonths - currentMonths) * 30);
      return {
        goalId: goal.id,
        name: goal.name,
        daysDelayed,
        message: daysDelayed > 0
          ? `Delays "${goal.name}" by ~${daysDelayed} day${daysDelayed !== 1 ? 's' : ''}`
          : 'Minimal impact on this goal',
      };
    });

    // Cash flow risk
    const safeToSpendAfter = this.round2(Math.max(0, sts.safeToSpend - amount));
    const newBalance = this.round2(sts.totalBalance - amount);
    const daysOfRunway = sts.breakdown.avgDailySpend > 0
      ? Math.floor(newBalance / sts.breakdown.avgDailySpend)
      : 999;

    return {
      purchase: { amount, category, description: dto.description },
      safeToSpendBefore: sts.safeToSpend,
      safeToSpendAfter,
      budgetImpact,
      goalImpacts,
      cashflowRisk: {
        newBalance,
        daysOfRunway,
        isRisky: daysOfRunway < 14,
        riskLevel: daysOfRunway < 7 ? 'high' : daysOfRunway < 14 ? 'medium' : 'low',
        message: daysOfRunway < 7
          ? 'High risk: less than a week of spending runway'
          : daysOfRunway < 14
          ? 'Moderate risk: under 2 weeks of spending runway'
          : 'Low risk — you have comfortable runway',
      },
    };
  }

  // ─── 3. Forward Cash Flow Projections ────────────────────────────────────
  // Day-by-day balance forecast: daily burn + subscriptions + detected income patterns

  async getProjections(userId: string, days = 30) {
    const sts = await this.getSafeToSpend(userId);
    const today = new Date();
    const LOW_BALANCE_THRESHOLD = 200;

    // Subscriptions due within the window
    const windowEnd = this.daysFromNow(days);
    const { data: subs } = await this.supabase.db
      .from('Subscriptions')
      .select('amount, next_due_date, company')
      .eq('user_id', userId).eq('is_active', true)
      .lte('next_due_date', windowEnd);

    // Map subscriptions by date for O(1) lookup
    const subsMap = new Map<string, { company: string; amount: number }[]>();
    for (const sub of subs ?? []) {
      if (!subsMap.has(sub.next_due_date)) subsMap.set(sub.next_due_date, []);
      subsMap.get(sub.next_due_date)!.push({ company: sub.company, amount: sub.amount });
    }

    // Detect recurring income: days of month with ≥ 2 income events in last 90 days
    const { data: incomeTxs } = await this.supabase.db
      .from('Transactions').select('amount, date')
      .eq('user_id', userId).eq('type', 'income')
      .gte('date', this.daysAgo(90)).order('date');

    const incomeByDay = new Map<number, number[]>();
    for (const tx of incomeTxs ?? []) {
      const dom = new Date(tx.date).getDate();
      if (!incomeByDay.has(dom)) incomeByDay.set(dom, []);
      incomeByDay.get(dom)!.push(tx.amount);
    }
    const recurringIncomeDays = new Map<number, number>();
    for (const [dom, amounts] of incomeByDay) {
      if (amounts.length >= 2) {
        recurringIncomeDays.set(dom, amounts.reduce((s, a) => s + a, 0) / amounts.length);
      }
    }

    // Build the projection
    let runningBalance = sts.totalBalance;
    const projection: {
      date: string;
      projected: number;
      dailyBurn: number;
      events: { label: string; amount: number; type: 'expense' | 'income' }[];
      isLow: boolean;
    }[] = [];

    for (let d = 0; d < days; d++) {
      const date = new Date(today);
      date.setDate(today.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const events: { label: string; amount: number; type: 'expense' | 'income' }[] = [];

      // Daily average burn
      const dailyBurn = sts.breakdown.avgDailySpend;
      runningBalance -= dailyBurn;

      // Recurring income
      const incomeAmt = recurringIncomeDays.get(date.getDate());
      if (incomeAmt) {
        runningBalance += incomeAmt;
        events.push({ label: 'Expected income', amount: incomeAmt, type: 'income' });
      }

      // Subscriptions due today
      for (const sub of subsMap.get(dateStr) ?? []) {
        runningBalance -= sub.amount;
        events.push({ label: sub.company, amount: sub.amount, type: 'expense' });
      }

      projection.push({
        date: dateStr,
        projected: this.round2(runningBalance),
        dailyBurn: this.round2(dailyBurn),
        events,
        isLow: runningBalance < LOW_BALANCE_THRESHOLD,
      });
    }

    const lowDays = projection.filter(p => p.isLow);
    const lowestPoint = projection.reduce(
      (min, p) => p.projected < min.projected ? p : min, projection[0],
    );

    return {
      projection,
      summary: {
        currentBalance: sts.totalBalance,
        projectedBalance: projection[projection.length - 1]?.projected ?? sts.totalBalance,
        lowestPoint: lowestPoint?.projected,
        lowestDate: lowestPoint?.date,
        lowBalanceDays: lowDays.length,
        firstLowBalanceDate: lowDays[0]?.date ?? null,
        hasRecurringIncome: recurringIncomeDays.size > 0,
        recurringIncomeDays: [...recurringIncomeDays.keys()].sort((a, b) => a - b),
      },
    };
  }

  // ─── 4. Behavioral Insights ───────────────────────────────────────────────
  // Weekend patterns, spending velocity, category trends, merchant habits

  async getInsights(userId: string) {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString().split('T')[0];
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      .toISOString().split('T')[0];
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0)
      .toISOString().split('T')[0];

    const { data: txs } = await this.supabase.db
      .from('Transactions').select('amount, date, category_id, merchant')
      .eq('user_id', userId).eq('type', 'expense')
      .gte('date', this.daysAgo(90));
    const allExpenses = txs ?? [];

    // ── Day-of-week pattern ──
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayTotals = new Array(7).fill(0);
    const dayCounts = new Array(7).fill(0);
    for (const tx of allExpenses) {
      const dow = new Date(tx.date).getDay();
      dayTotals[dow] += tx.amount;
      dayCounts[dow]++;
    }
    const weeklyPattern = DAYS.map((day, i) => ({
      day,
      totalSpent: this.round2(dayTotals[i]),
      avgPerOccurrence: dayCounts[i] > 0 ? this.round2(dayTotals[i] / dayCounts[i]) : 0,
      transactionCount: dayCounts[i],
    }));

    // Weekend vs weekday average daily spend
    const weekendPerDay = (dayTotals[0] + dayTotals[6]) / 2;
    const weekdayPerDay = dayTotals.slice(1, 6).reduce((s: number, v: number) => s + v, 0) / 5;
    const weekendRatio = weekdayPerDay > 0 ? weekendPerDay / weekdayPerDay : 1;

    // ── Spending velocity (this month vs last month, pace-adjusted) ──
    const thisMonthTxs = allExpenses.filter((t: { date: string }) => t.date >= startOfMonth);
    const lastMonthTxs = allExpenses.filter(
      (t: { date: string }) => t.date >= startOfLastMonth && t.date <= endOfLastMonth,
    );
    const thisMonthTotal = thisMonthTxs.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const lastMonthTotal = lastMonthTxs.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const projectedThisMonth = dayOfMonth > 0 ? (thisMonthTotal / dayOfMonth) * daysInMonth : 0;
    const velocityRatio = lastMonthTotal > 0 ? thisMonthTotal / lastMonthTotal : 1;

    // ── Top merchants (last 90 days) ──
    const merchantMap = new Map<string, { total: number; count: number }>();
    for (const tx of allExpenses) {
      if (tx.merchant) {
        const curr = merchantMap.get(tx.merchant) ?? { total: 0, count: 0 };
        merchantMap.set(tx.merchant, { total: curr.total + tx.amount, count: curr.count + 1 });
      }
    }
    const topMerchants = [...merchantMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([merchant, stats]) => ({
        merchant,
        totalSpent: this.round2(stats.total),
        visitCount: stats.count,
        avgPerVisit: this.round2(stats.total / stats.count),
      }));

    // ── Category trends: last 30d vs prior 30d ──
    await this.categories.ensureDefaults(userId);
    const recent30 = allExpenses.filter((t: { date: string }) => t.date >= this.daysAgo(30));
    const prev30 = allExpenses.filter(
      (t: { date: string }) => t.date >= this.daysAgo(60) && t.date < this.daysAgo(30),
    );

    const catRecent = new Map<string, number>();
    const catPrev = new Map<string, number>();
    for (const tx of recent30) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      catRecent.set(slug, (catRecent.get(slug) ?? 0) + tx.amount);
    }
    for (const tx of prev30) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      catPrev.set(slug, (catPrev.get(slug) ?? 0) + tx.amount);
    }

    const total30 = [...catRecent.values()].reduce((s, v) => s + v, 0);
    const categoryTrends = [...catRecent.entries()]
      .map(([category, amount]) => {
        const prev = catPrev.get(category) ?? 0;
        const change = prev > 0 ? ((amount - prev) / prev) * 100 : 0;
        return {
          category,
          amount: this.round2(amount),
          percentage: total30 > 0 ? Math.round((amount / total30) * 100) : 0,
          prevAmount: this.round2(prev),
          changePercent: Math.round(change),
          trend: change > 10 ? 'increasing' : change < -10 ? 'decreasing' : 'stable' as string,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    // ── Human-readable habit observations ──
    const habits: { insight: string; severity: 'info' | 'warning' | 'positive' }[] = [];
    if (weekendRatio > 1.3) {
      habits.push({
        insight: `You spend ${Math.round((weekendRatio - 1) * 100)}% more on weekends than weekdays`,
        severity: 'info',
      });
    }
    if (velocityRatio > 1.15) {
      habits.push({
        insight: `You're on pace to spend ${Math.round((velocityRatio - 1) * 100)}% more than last month`,
        severity: 'warning',
      });
    } else if (velocityRatio < 0.85) {
      habits.push({
        insight: `You're on pace to spend ${Math.round((1 - velocityRatio) * 100)}% less than last month`,
        severity: 'positive',
      });
    }
    const highTrend = categoryTrends.find(c => c.trend === 'increasing' && c.changePercent > 20);
    if (highTrend) {
      habits.push({
        insight: `${highTrend.category} spending is up ${highTrend.changePercent}% from last month`,
        severity: 'warning',
      });
    }
    if (topMerchants[0]) {
      habits.push({
        insight: `Your top merchant is ${topMerchants[0].merchant} ($${topMerchants[0].totalSpent} over 90 days)`,
        severity: 'info',
      });
    }
    const peakDay = weeklyPattern.reduce((max, d) => d.totalSpent > max.totalSpent ? d : max, weeklyPattern[0]);
    habits.push({ insight: `${peakDay.day} is your highest-spend day of the week`, severity: 'info' });

    return {
      weeklyPattern,
      weekendVsWeekday: {
        weekendAvgPerDay: this.round2(weekendPerDay),
        weekdayAvgPerDay: this.round2(weekdayPerDay),
        ratio: this.round2(weekendRatio),
        insight: weekendRatio > 1.3
          ? `You spend ${Math.round((weekendRatio - 1) * 100)}% more on weekends`
          : 'Spending is consistent across the week',
      },
      spendingVelocity: {
        thisMonth: this.round2(thisMonthTotal),
        lastMonth: this.round2(lastMonthTotal),
        projectedThisMonth: this.round2(projectedThisMonth),
        ratio: this.round2(velocityRatio),
        trend: velocityRatio > 1.1 ? 'accelerating' : velocityRatio < 0.9 ? 'decelerating' : 'steady',
      },
      categoryTrends,
      topMerchants,
      habits,
    };
  }

  // ─── 5. Adaptive Budget Suggestions ──────────────────────────────────────
  // Analyse 3-month history per category and recommend budget amounts + mode

  async getBudgetSuggestions(userId: string) {
    await this.categories.ensureDefaults(userId);

    const { data: txs } = await this.supabase.db
      .from('Transactions').select('amount, date, category_id')
      .eq('user_id', userId).eq('type', 'expense')
      .gte('date', this.daysAgo(90));

    // Group spending by category + month
    const byCategory = new Map<string, Map<string, number>>();
    for (const tx of txs ?? []) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      const month = (tx.date as string).slice(0, 7);
      if (!byCategory.has(slug)) byCategory.set(slug, new Map());
      const prev = byCategory.get(slug)!.get(month) ?? 0;
      byCategory.get(slug)!.set(month, prev + tx.amount);
    }

    // Fetch existing budgets
    const { data: budgets } = await this.supabase.db
      .from('Budgets').select('*').eq('user_id', userId);
    const budgetMap = new Map<string, { limit_amount: number; spent_amount: number }>();
    for (const b of budgets ?? []) {
      const slug = await this.categories.resolveSlug(userId, b.category_id);
      budgetMap.set(slug, b as { limit_amount: number; spent_amount: number });
    }

    const suggestions: {
      category: string;
      suggestedLimit: number;
      currentLimit: number | null;
      analytics: { avgMonthly: number; maxMonthly: number; minMonthly: number; monthsAnalyzed: number };
      trend: string;
      hasBudget: boolean;
      action: string;
    }[] = [];
    for (const [category, monthlyMap] of byCategory) {
      const amounts = [...monthlyMap.values()];
      if (!amounts.length) continue;

      const avg = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const max = Math.max(...amounts);
      const min = Math.min(...amounts);
      const suggested = Math.ceil(avg * 1.1);
      const existing = budgetMap.get(category);

      const sorted = [...monthlyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const recent = sorted.slice(-2).map(([, v]) => v);
      const trend = recent.length >= 2 && recent[1] > recent[0] * 1.1
        ? 'increasing' : recent.length >= 2 && recent[1] < recent[0] * 0.9
        ? 'decreasing' : 'stable';

      const currentLimit = existing?.limit_amount ?? null;
      const driftPct = currentLimit ? Math.abs(suggested - currentLimit) / currentLimit : 1;

      suggestions.push({
        category,
        suggestedLimit: suggested,
        currentLimit,
        analytics: {
          avgMonthly: this.round2(avg),
          maxMonthly: this.round2(max),
          minMonthly: this.round2(min),
          monthsAnalyzed: amounts.length,
        },
        trend,
        hasBudget: !!existing,
        action: !existing ? 'create' : driftPct > 0.15 ? 'update' : 'ok',
      });
    }

    suggestions.sort((a, b) => b.analytics.avgMonthly - a.analytics.avgMonthly);

    // Income context for budgeting mode recommendation
    const { data: incomeTxs } = await this.supabase.db
      .from('Transactions').select('amount')
      .eq('user_id', userId).eq('type', 'income')
      .gte('date', this.daysAgo(90));
    const avgMonthlyIncome =
      (incomeTxs ?? []).reduce((s: number, t: { amount: number }) => s + t.amount, 0) / 3;
    const totalAvgSpend = suggestions.reduce((s, c) => s + c.analytics.avgMonthly, 0);
    const savingsRate = avgMonthlyIncome > 0
      ? (avgMonthlyIncome - totalAvgSpend) / avgMonthlyIncome : 0;

    return {
      suggestions,
      totalAvgMonthlySpend: this.round2(totalAvgSpend),
      avgMonthlyIncome: this.round2(avgMonthlyIncome),
      savingsRate: Math.round(savingsRate * 100),
      recommendedBudgetingMode:
        savingsRate < 0.05 ? 'zero-based'
        : savingsRate < 0.20 ? 'envelope'
        : '50/30/20',
    };
  }

  // ─── 6. Cash Flow Intelligence ────────────────────────────────────────────
  // Subscription audit: cancellation candidates + autopay optimisation

  async getCashflowIntelligence(userId: string) {
    const { data: subs } = await this.supabase.db
      .from('Subscriptions').select('*')
      .eq('user_id', userId).eq('is_active', true)
      .order('amount', { ascending: false });

    const allSubs = subs ?? [];
    const monthlyCost = allSubs.reduce((s: number, sub: { amount: number; period: string }) => {
      return s + (sub.period === 'yearly' ? sub.amount / 12 : sub.amount);
    }, 0);

    // Flag subscriptions not charged in 60+ days (possible unused)
    const sixtyDaysAgo = this.daysAgo(60);
    const cancellationCandidates = allSubs
      .filter((sub: { last_processed_date: string | null; amount: number }) =>
        !sub.last_processed_date || sub.last_processed_date < sixtyDaysAgo,
      )
      .map((sub: { company: string; amount: number; period: string }) => ({
        company: sub.company,
        amount: sub.amount,
        period: sub.period,
        yearlyCost: sub.period === 'yearly' ? sub.amount : sub.amount * 12,
        reason: 'No activity in 60+ days — consider cancelling',
      }));

    // Bills due in the next 14 days
    const twoWeeksOut = this.daysFromNow(14);
    const upcoming = allSubs
      .filter((sub: { next_due_date: string }) => sub.next_due_date <= twoWeeksOut)
      .map((sub: { company: string; amount: number; next_due_date: string }) => ({
        company: sub.company,
        amount: sub.amount,
        dueDate: sub.next_due_date,
        daysUntilDue: Math.ceil(
          (new Date(sub.next_due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        ),
      }))
      .sort((a: { daysUntilDue: number }, b: { daysUntilDue: number }) => a.daysUntilDue - b.daysUntilDue);

    // Income smoothing: detect if income is irregular (std dev > 30% of mean)
    const { data: incomeTxs } = await this.supabase.db
      .from('Transactions').select('amount, date')
      .eq('user_id', userId).eq('type', 'income')
      .gte('date', this.daysAgo(90)).order('date');

    const incomeAmounts = (incomeTxs ?? []).map((t: { amount: number }) => t.amount);
    const incomeAvg = incomeAmounts.length
      ? incomeAmounts.reduce((s: number, a: number) => s + a, 0) / incomeAmounts.length : 0;
    const incomeStdDev = incomeAmounts.length > 1
      ? Math.sqrt(
          incomeAmounts.reduce((s: number, a: number) => s + Math.pow(a - incomeAvg, 2), 0)
          / incomeAmounts.length,
        )
      : 0;
    const incomeIsIrregular = incomeAvg > 0 && incomeStdDev / incomeAvg > 0.3;

    return {
      subscriptionSummary: {
        totalActive: allSubs.length,
        estimatedMonthlyCost: this.round2(monthlyCost),
        estimatedYearlyCost: this.round2(monthlyCost * 12),
      },
      cancellationCandidates,
      upcomingBills: upcoming,
      incomeSmoothing: {
        avgMonthlyIncome: this.round2(incomeAvg),
        isIrregular: incomeIsIrregular,
        variabilityPct: incomeAvg > 0 ? Math.round((incomeStdDev / incomeAvg) * 100) : 0,
        advice: incomeIsIrregular
          ? 'Your income varies significantly. Consider keeping 2–3 months of expenses as a buffer.'
          : 'Your income appears consistent.',
      },
    };
  }

  // ─── 7. Auto-Categorization ───────────────────────────────────────────────
  // Pattern-match merchant names; learn from user corrections via Merchant_Rules table

  suggestCategory(merchant: string): string | null {
    if (!merchant?.trim()) return null;
    for (const { pattern, category } of MERCHANT_PATTERNS) {
      if (pattern.test(merchant)) return category;
    }
    return null;
  }

  async getLearnedCategory(userId: string, merchant: string): Promise<string | null> {
    if (!merchant?.trim()) return null;
    try {
      const { data } = await this.supabase.db
        .from('Merchant_Rules')
        .select('category_slug')
        .eq('user_id', userId)
        .eq('merchant', merchant.toLowerCase().trim())
        .single();
      return (data as { category_slug: string } | null)?.category_slug ?? null;
    } catch {
      return null; // table may not exist yet
    }
  }

  async learnMerchantRule(userId: string, merchant: string, categorySlug: string): Promise<void> {
    if (!merchant?.trim()) return;
    try {
      await this.supabase.db.from('Merchant_Rules').upsert(
        { user_id: userId, merchant: merchant.toLowerCase().trim(), category_slug: categorySlug },
        { onConflict: 'user_id,merchant' },
      );
    } catch {
      // Silently ignore if table doesn't exist
    }
  }

  // Resolve the best category for a merchant: learned rule > pattern match > null
  async resolveMerchantCategory(userId: string, merchant?: string): Promise<string | null> {
    if (!merchant) return null;
    const learned = await this.getLearnedCategory(userId, merchant);
    if (learned) return learned;
    return this.suggestCategory(merchant);
  }
}
