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

  // ─── 7. Spending Anomaly Detection ───────────────────────────────────────
  // Flags price spikes, new recurring charges, large transactions

  async getAnomalies(userId: string) {
    await this.categories.ensureDefaults(userId);
    const anomalies: {
      type: string; severity: string; title: string; description: string;
      amount: number; merchant?: string; date: string; category?: string;
    }[] = [];

    const thirtyDaysAgo = this.daysAgo(30);
    const sixtyDaysAgo = this.daysAgo(60);

    const { data: recentTxs } = await this.supabase.db
      .from('Transactions').select('*').eq('user_id', userId).gte('date', thirtyDaysAgo);
    const { data: prevTxs } = await this.supabase.db
      .from('Transactions').select('*').eq('user_id', userId)
      .gte('date', sixtyDaysAgo).lt('date', thirtyDaysAgo);

    // 1. Price spikes: merchant charged >50% more than their prior 30-day average
    const prevMerchant = new Map<string, { total: number; count: number }>();
    for (const tx of prevTxs ?? []) {
      if (!tx.merchant) continue;
      const curr = prevMerchant.get(tx.merchant) ?? { total: 0, count: 0 };
      prevMerchant.set(tx.merchant, { total: curr.total + tx.amount, count: curr.count + 1 });
    }
    for (const tx of recentTxs ?? []) {
      if (!tx.merchant) continue;
      const prev = prevMerchant.get(tx.merchant);
      if (prev && prev.count > 0) {
        const avgPrev = prev.total / prev.count;
        if (tx.amount > avgPrev * 1.5 && tx.amount - avgPrev > 10) {
          anomalies.push({
            type: 'price_spike', severity: tx.amount > avgPrev * 2 ? 'high' : 'medium',
            title: `Price spike at ${tx.merchant}`,
            description: `Charged $${tx.amount.toFixed(2)} — ${Math.round((tx.amount / avgPrev - 1) * 100)}% above your usual $${avgPrev.toFixed(2)}`,
            amount: tx.amount, merchant: tx.merchant, date: tx.date,
            category: await this.categories.resolveSlug(userId, tx.category_id),
          });
        }
      }
    }

    // 2. New recurring charges: merchant 2+ times in last 30d, never before
    const recentMerchantCounts = new Map<string, number>();
    for (const tx of recentTxs ?? []) {
      if (!tx.merchant || tx.type !== 'expense') continue;
      recentMerchantCounts.set(tx.merchant, (recentMerchantCounts.get(tx.merchant) ?? 0) + 1);
    }
    const prevMerchantNames = new Set((prevTxs ?? []).map((t: { merchant: string }) => t.merchant).filter(Boolean));
    for (const [merchant, count] of recentMerchantCounts) {
      if (count >= 2 && !prevMerchantNames.has(merchant)) {
        const latestTx = (recentTxs ?? []).find((t: { merchant: string }) => t.merchant === merchant);
        anomalies.push({
          type: 'new_recurring', severity: 'medium',
          title: `New recurring charge: ${merchant}`,
          description: `Charged ${count} times in the last 30 days — new merchant not seen before`,
          amount: latestTx?.amount ?? 0, merchant, date: latestTx?.date ?? new Date().toISOString(),
        });
      }
    }

    // 3. Large transaction: single expense > 5× average daily spend
    const avgDailySpend = (recentTxs ?? [])
      .filter((t: { type: string }) => t.type === 'expense')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0) / 30;
    for (const tx of (recentTxs ?? []).filter((t: { type: string; amount: number }) => t.type === 'expense' && t.amount > 100)) {
      if (avgDailySpend > 0 && tx.amount > avgDailySpend * 5) {
        anomalies.push({
          type: 'large_transaction', severity: tx.amount > avgDailySpend * 10 ? 'high' : 'medium',
          title: 'Large transaction',
          description: `$${tx.amount.toFixed(2)} — ${Math.round(tx.amount / avgDailySpend)}× your daily average`,
          amount: tx.amount, merchant: tx.merchant, date: tx.date,
          category: await this.categories.resolveSlug(userId, tx.category_id),
        });
      }
    }

    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    anomalies.sort((a, b) =>
      (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2) || b.date.localeCompare(a.date),
    );

    return { anomalies, total: anomalies.length };
  }

  // ─── 8. Spending Forecaster ──────────────────────────────────────────────
  // Weighted moving average (recent months weighted higher) per category.
  // Returns predicted next-month spend + pace vs current month so far.

  async getSpendingForecast(userId: string) {
    await this.categories.ensureDefaults(userId);

    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount, date, category_id')
      .eq('user_id', userId)
      .eq('type', 'expense')
      .gte('date', this.daysAgo(180));

    // Group by category + YYYY-MM
    const byCategory = new Map<string, Map<string, number>>();
    for (const tx of txs ?? []) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      const month = (tx.date as string).slice(0, 7);
      if (!byCategory.has(slug)) byCategory.set(slug, new Map());
      byCategory.get(slug)!.set(month, (byCategory.get(slug)!.get(month) ?? 0) + tx.amount);
    }

    // Current month progress for pace calculation
    const today = new Date();
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const monthElapsed = dayOfMonth / daysInMonth;
    const currentMonthKey = today.toISOString().slice(0, 7);

    const forecasts: {
      category: string;
      forecastedAmount: number;
      currentMonthSpend: number;
      projectedCurrentMonth: number;
      pace: 'ahead' | 'behind' | 'on_track';
      pacePercent: number;
      monthlyHistory: { month: string; amount: number }[];
    }[] = [];

    // Weights: most recent month = 3, two months ago = 2, older = 1
    const WEIGHTS = [3, 2, 1, 1, 1, 1];

    for (const [category, monthMap] of byCategory) {
      const sorted = [...monthMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .filter(([m]) => m !== currentMonthKey); // exclude current in-progress month

      if (sorted.length === 0) continue;

      const recent = sorted.slice(-6).reverse(); // most recent first
      let weightedSum = 0;
      let weightTotal = 0;
      for (let i = 0; i < recent.length; i++) {
        const w = WEIGHTS[i] ?? 1;
        weightedSum += recent[i][1] * w;
        weightTotal += w;
      }
      const forecastedAmount = this.round2(weightedSum / weightTotal);

      const currentMonthSpend = monthMap.get(currentMonthKey) ?? 0;
      const projectedCurrentMonth = monthElapsed > 0
        ? this.round2(currentMonthSpend / monthElapsed)
        : 0;

      const pacePercent = forecastedAmount > 0
        ? Math.round(((projectedCurrentMonth - forecastedAmount) / forecastedAmount) * 100)
        : 0;

      forecasts.push({
        category,
        forecastedAmount,
        currentMonthSpend: this.round2(currentMonthSpend),
        projectedCurrentMonth,
        pace: pacePercent > 10 ? 'ahead' : pacePercent < -10 ? 'behind' : 'on_track',
        pacePercent,
        monthlyHistory: sorted.slice(-6).map(([month, amount]) => ({ month, amount: this.round2(amount) })),
      });
    }

    forecasts.sort((a, b) => b.forecastedAmount - a.forecastedAmount);

    const totalForecast = this.round2(forecasts.reduce((s, f) => s + f.forecastedAmount, 0));
    const totalCurrentProjected = this.round2(forecasts.reduce((s, f) => s + f.projectedCurrentMonth, 0));

    return {
      forecasts,
      summary: {
        totalForecastedMonthly: totalForecast,
        totalCurrentProjected,
        overallPacePercent: totalForecast > 0
          ? Math.round(((totalCurrentProjected - totalForecast) / totalForecast) * 100)
          : 0,
        monthElapsedPercent: Math.round(monthElapsed * 100),
      },
    };
  }

  // ─── 9. Predictive Budget Alerts ─────────────────────────────────────────
  // Uses spending pace to predict which budgets will be breached before month end,
  // and by how much — fires before the damage is done.

  async getPredictiveBudgetAlerts(userId: string) {
    await this.categories.ensureDefaults(userId);

    const today = new Date();
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - dayOfMonth;
    const monthElapsed = dayOfMonth / daysInMonth;

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const { data: budgets } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('month', today.getMonth() + 1)
      .eq('year', today.getFullYear());

    const alerts: {
      category: string;
      severity: 'warning' | 'danger' | 'critical';
      currentSpend: number;
      limit: number;
      projectedSpend: number;
      projectedOverageAmount: number;
      projectedOveragePercent: number;
      daysLeft: number;
      message: string;
    }[] = [];

    for (const budget of budgets ?? []) {
      if (!budget.limit_amount || budget.limit_amount <= 0) continue;

      const slug = await this.categories.resolveSlug(userId, budget.category_id);
      const spent = budget.spent_amount ?? 0;
      const effectiveLimit = (budget.limit_amount ?? 0) + (budget.rollover_amount ?? 0);

      // Current utilization
      const utilization = spent / effectiveLimit;

      // If already exceeded, that's handled by regular budget alerts — skip
      if (utilization >= 1) continue;

      // Project spend to end of month based on current pace
      const projectedSpend = monthElapsed > 0 ? spent / monthElapsed : spent;
      const projectedOverage = projectedSpend - effectiveLimit;

      if (projectedOverage > 0) {
        const overagePct = Math.round((projectedOverage / effectiveLimit) * 100);
        alerts.push({
          category: slug,
          severity: overagePct > 25 ? 'critical' : overagePct > 10 ? 'danger' : 'warning',
          currentSpend: this.round2(spent),
          limit: this.round2(effectiveLimit),
          projectedSpend: this.round2(projectedSpend),
          projectedOverageAmount: this.round2(projectedOverage),
          projectedOveragePercent: overagePct,
          daysLeft,
          message: `At your current pace you'll exceed your ${slug} budget by ${this.round2(projectedOverage).toFixed(0)} (${overagePct}% over) — ${daysLeft} days left`,
        });
      } else if (utilization >= 0.7 && daysLeft <= 10) {
        // Close to limit with little time left
        const remaining = this.round2(effectiveLimit - spent);
        alerts.push({
          category: slug,
          severity: 'warning',
          currentSpend: this.round2(spent),
          limit: this.round2(effectiveLimit),
          projectedSpend: this.round2(projectedSpend),
          projectedOverageAmount: 0,
          projectedOveragePercent: 0,
          daysLeft,
          message: `Only ${remaining.toFixed(0)} left in ${slug} budget with ${daysLeft} days to go`,
        });
      }
    }

    const severityOrder = { critical: 0, danger: 1, warning: 2 };
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // Persist critical/danger alerts as notifications (deduplicated by day)
    const todayStr = today.toISOString().split('T')[0];
    for (const alert of alerts.filter((a) => a.severity !== 'warning')) {
      const { data: existing } = await this.supabase.db
        .from('Notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('type', 'budget_alert')
        .ilike('title', `%${alert.category}%predictive%`)
        .gte('created_at', todayStr)
        .single();

      if (!existing) {
        await this.supabase.db.from('Notifications').insert({
          user_id: userId,
          type: 'budget_alert',
          title: `Predictive alert: ${alert.category}`,
          body: alert.message,
          is_read: false,
        });
      }
    }

    return { alerts, total: alerts.length };
  }

  // ─── 10. Goal Feasibility Scorer ──────────────────────────────────────────
  // Rates each active goal: realistic / tight / unreachable based on current savings rate.

  async getGoalFeasibility(userId: string) {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];

    const [goalsRes, txsRes] = await Promise.all([
      this.supabase.db.from('Savings').select('*').eq('user_id', userId).eq('status', 'active'),
      this.supabase.db.from('Transactions').select('amount, type').eq('user_id', userId).gte('date', this.daysAgo(90)),
    ]);

    const goals = goalsRes.data ?? [];
    const txs = txsRes.data ?? [];

    // 3-month average monthly net savings
    const totalIncome = txs.filter((t: { type: string }) => t.type === 'income')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const totalExpenses = txs.filter((t: { type: string }) => t.type === 'expense')
      .reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const avgMonthlySavings = (totalIncome - totalExpenses) / 3;

    // Total monthly savings commitment across all goals with deadlines
    const goalCommitments = goals
      .filter((g: { deadline: string }) => g.deadline)
      .reduce((s: number, g: { target_amount: number; current_amount: number; deadline: string }) => {
        const monthsLeft = Math.max(1,
          (new Date(g.deadline).getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 30),
        );
        return s + Math.max(0, (g.target_amount - g.current_amount) / monthsLeft);
      }, 0);

    const results = goals.map((goal: {
      id: string; name: string; target_amount: number; current_amount: number;
      deadline?: string; icon?: string; color?: string;
    }) => {
      const remaining = goal.target_amount - goal.current_amount;
      const progressPct = goal.target_amount > 0
        ? Math.round((goal.current_amount / goal.target_amount) * 100)
        : 0;

      if (!goal.deadline) {
        // No deadline — just show months at current rate
        const monthsNeeded = avgMonthlySavings > 0
          ? Math.ceil(remaining / avgMonthlySavings)
          : null;
        return {
          goalId: goal.id,
          name: goal.name,
          icon: goal.icon,
          color: goal.color,
          target: goal.target_amount,
          current: goal.current_amount,
          remaining: this.round2(remaining),
          progressPct,
          deadline: null,
          feasibility: 'no_deadline' as const,
          monthsNeeded,
          monthlySavingsRequired: null,
          shortfallPerMonth: null,
          message: monthsNeeded
            ? `At your current savings rate, you'd reach this in ~${monthsNeeded} month${monthsNeeded !== 1 ? 's' : ''}`
            : 'Set a deadline to get a feasibility score',
        };
      }

      const deadlineDate = new Date(goal.deadline);
      const monthsLeft = Math.max(0.5,
        (deadlineDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 30),
      );
      const monthlyRequired = this.round2(remaining / monthsLeft);

      // Available savings after other goal commitments
      const availableForThisGoal = avgMonthlySavings - (goalCommitments - monthlyRequired);
      const shortfall = this.round2(Math.max(0, monthlyRequired - availableForThisGoal));
      const ratio = availableForThisGoal > 0 ? monthlyRequired / availableForThisGoal : Infinity;

      let feasibility: 'realistic' | 'tight' | 'unreachable';
      let message: string;

      if (ratio <= 0.8) {
        feasibility = 'realistic';
        message = `On track — save ${this.round2(monthlyRequired).toFixed(0)}/mo to hit your ${deadlineDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} deadline`;
      } else if (ratio <= 1.2) {
        feasibility = 'tight';
        message = `Tight — requires ${this.round2(monthlyRequired).toFixed(0)}/mo which is close to your available savings`;
      } else {
        feasibility = 'unreachable';
        message = `Unreachable at current pace — need ${this.round2(monthlyRequired).toFixed(0)}/mo but only ~${this.round2(availableForThisGoal).toFixed(0)} available. Save ${shortfall.toFixed(0)} more/mo or extend the deadline`;
      }

      return {
        goalId: goal.id,
        name: goal.name,
        icon: goal.icon,
        color: goal.color,
        target: goal.target_amount,
        current: goal.current_amount,
        remaining: this.round2(remaining),
        progressPct,
        deadline: goal.deadline,
        feasibility,
        monthsNeeded: Math.ceil(monthsLeft),
        monthlySavingsRequired: monthlyRequired,
        shortfallPerMonth: shortfall > 0 ? shortfall : null,
        message,
      };
    });

    return {
      goals: results,
      context: {
        avgMonthlySavings: this.round2(avgMonthlySavings),
        totalGoalCommitmentsPerMonth: this.round2(goalCommitments),
        availableSavings: this.round2(avgMonthlySavings - goalCommitments),
      },
    };
  }

  // ─── 11. Financial Health Score ───────────────────────────────────────────
  // 0–100 score from: savings rate, budget adherence, emergency fund, goal progress, debt.

  async getHealthScore(userId: string) {
    await this.categories.ensureDefaults(userId);
    const today = new Date();

    const [cardsRes, budgetsRes, goalsRes, liabRes, txsRes] = await Promise.all([
      this.supabase.db.from('Cards').select('balance').eq('user_id', userId),
      this.supabase.db.from('Budgets').select('*')
        .eq('user_id', userId).eq('month', today.getMonth() + 1).eq('year', today.getFullYear()),
      this.supabase.db.from('Savings').select('target_amount, current_amount, status').eq('user_id', userId),
      this.supabase.db.from('liabilities').select('balance').eq('user_id', userId),
      this.supabase.db.from('Transactions').select('amount, type').eq('user_id', userId).gte('date', this.daysAgo(90)),
    ]);

    const totalBalance = (cardsRes.data ?? []).reduce((s: number, c: { balance: number }) => s + (c.balance ?? 0), 0);
    const budgets = budgetsRes.data ?? [];
    const goals = goalsRes.data ?? [];
    const totalDebt = (liabRes.data ?? []).reduce((s: number, l: { balance: number }) => s + l.balance, 0);
    const txs = txsRes.data ?? [];

    const income3mo = txs.filter((t: { type: string }) => t.type === 'income').reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const expenses3mo = txs.filter((t: { type: string }) => t.type === 'expense').reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const avgMonthlyIncome = income3mo / 3;
    const avgMonthlyExpenses = expenses3mo / 3;
    const savingsRate = avgMonthlyIncome > 0 ? (avgMonthlyIncome - avgMonthlyExpenses) / avgMonthlyIncome : 0;

    const components: { name: string; score: number; maxScore: number; insight: string }[] = [];

    // 1. Savings rate (25 pts): 20%+ = full, linear below
    const savingsScore = Math.min(25, Math.round(Math.max(0, savingsRate) * 125));
    components.push({
      name: 'Savings Rate',
      score: savingsScore,
      maxScore: 25,
      insight: savingsRate >= 0.2
        ? `Great — you're saving ${Math.round(savingsRate * 100)}% of income`
        : savingsRate >= 0.1
        ? `Saving ${Math.round(savingsRate * 100)}% — aim for 20%`
        : savingsRate > 0
        ? `Only saving ${Math.round(savingsRate * 100)}% — increase income or cut expenses`
        : 'Spending more than you earn',
    });

    // 2. Budget adherence (20 pts): pct of budgets not exceeded
    const activeBudgets = budgets.filter((b: { limit_amount: number }) => b.limit_amount > 0);
    const adherenceScore = activeBudgets.length > 0
      ? Math.round((activeBudgets.filter((b: { spent_amount: number; limit_amount: number }) =>
          b.spent_amount <= b.limit_amount).length / activeBudgets.length) * 20)
      : 10; // neutral if no budgets set
    const exceededCount = activeBudgets.filter((b: { spent_amount: number; limit_amount: number }) => b.spent_amount > b.limit_amount).length;
    components.push({
      name: 'Budget Adherence',
      score: adherenceScore,
      maxScore: 20,
      insight: activeBudgets.length === 0
        ? 'Set budgets to track adherence'
        : exceededCount === 0
        ? 'All budgets on track this month'
        : `${exceededCount} budget${exceededCount > 1 ? 's' : ''} exceeded this month`,
    });

    // 3. Emergency fund (20 pts): 3mo expenses = full score
    const emergencyMonths = avgMonthlyExpenses > 0 ? totalBalance / avgMonthlyExpenses : 0;
    const emergencyScore = Math.min(20, Math.round((emergencyMonths / 3) * 20));
    components.push({
      name: 'Emergency Fund',
      score: emergencyScore,
      maxScore: 20,
      insight: emergencyMonths >= 3
        ? `${emergencyMonths.toFixed(1)} months of expenses covered`
        : emergencyMonths >= 1
        ? `${emergencyMonths.toFixed(1)} months covered — build to 3`
        : 'Less than 1 month of expenses in reserve',
    });

    // 4. Goal progress (20 pts): average progress across active goals
    const activeGoals = goals.filter((g: { status: string }) => g.status === 'active');
    const avgGoalProgress = activeGoals.length > 0
      ? activeGoals.reduce((s: number, g: { target_amount: number; current_amount: number }) =>
          s + (g.target_amount > 0 ? g.current_amount / g.target_amount : 0), 0) / activeGoals.length
      : 0.5; // neutral if no goals
    const goalScore = Math.round(avgGoalProgress * 20);
    components.push({
      name: 'Goal Progress',
      score: goalScore,
      maxScore: 20,
      insight: activeGoals.length === 0
        ? 'Set savings goals to track progress'
        : `${Math.round(avgGoalProgress * 100)}% average progress across ${activeGoals.length} goal${activeGoals.length > 1 ? 's' : ''}`,
    });

    // 5. Debt load (15 pts): 0 debt = full, scales down with debt-to-income
    const debtToIncome = avgMonthlyIncome > 0 ? totalDebt / (avgMonthlyIncome * 12) : 0;
    const debtScore = Math.round(Math.max(0, Math.min(15, (1 - Math.min(1, debtToIncome)) * 15)));
    components.push({
      name: 'Debt Load',
      score: debtScore,
      maxScore: 15,
      insight: totalDebt === 0
        ? 'No liabilities recorded'
        : debtToIncome < 0.3
        ? `Debt-to-income ratio is healthy (${Math.round(debtToIncome * 100)}%)`
        : `Debt-to-income ratio is ${Math.round(debtToIncome * 100)}% — work on reducing balances`,
    });

    const totalScore = components.reduce((s, c) => s + c.score, 0);
    const grade =
      totalScore >= 85 ? 'A' :
      totalScore >= 70 ? 'B' :
      totalScore >= 55 ? 'C' :
      totalScore >= 40 ? 'D' : 'F';

    const trend =
      totalScore >= 75 ? 'Excellent shape' :
      totalScore >= 60 ? 'Good — a few areas to improve' :
      totalScore >= 45 ? 'Fair — meaningful improvements available' :
      'Needs attention';

    return {
      score: totalScore,
      maxScore: 100,
      grade,
      trend,
      components,
      lastUpdated: today.toISOString(),
    };
  }

  // ─── 12. Seasonality Modeler ──────────────────────────────────────────────
  // Detects which months historically spike or dip per category (needs 12+ months).
  // Returns monthly multipliers to improve budget suggestions.

  async getSeasonality(userId: string) {
    await this.categories.ensureDefaults(userId);

    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount, date, category_id')
      .eq('user_id', userId)
      .eq('type', 'expense')
      .gte('date', this.daysAgo(365));

    // Group by category + month-of-year (1-12)
    const byCategory = new Map<string, Map<number, number[]>>();
    for (const tx of txs ?? []) {
      const slug = await this.categories.resolveSlug(userId, tx.category_id);
      const month = new Date(tx.date).getMonth() + 1;
      if (!byCategory.has(slug)) byCategory.set(slug, new Map());
      if (!byCategory.get(slug)!.has(month)) byCategory.get(slug)!.set(month, []);
      byCategory.get(slug)!.get(month)!.push(tx.amount);
    }

    const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const results: {
      category: string;
      hasSeasonality: boolean;
      peakMonth: string | null;
      troughMonth: string | null;
      peakMultiplier: number;
      troughMultiplier: number;
      monthlyMultipliers: { month: string; multiplier: number }[];
    }[] = [];

    for (const [category, monthMap] of byCategory) {
      const monthTotals: number[] = Array(12).fill(0);
      const monthCounts: number[] = Array(12).fill(0);

      for (const [month, amounts] of monthMap) {
        monthTotals[month - 1] = amounts.reduce((s, a) => s + a, 0);
        monthCounts[month - 1] = amounts.length;
      }

      const activeTotals = monthTotals.filter((t) => t > 0);
      if (activeTotals.length < 3) continue; // not enough data

      const avg = activeTotals.reduce((s, v) => s + v, 0) / activeTotals.length;

      const multipliers = monthTotals.map((total) =>
        total > 0 ? this.round2(total / avg) : null,
      );

      const peakIdx = multipliers.reduce((best, m, i) =>
        m !== null && (multipliers[best] === null || m > (multipliers[best] ?? 0)) ? i : best, 0);
      const troughIdx = multipliers.reduce((best, m, i) =>
        m !== null && (multipliers[best] === null || m < (multipliers[best] ?? Infinity)) ? i : best, 0);

      const peakMult = multipliers[peakIdx] ?? 1;
      const troughMult = multipliers[troughIdx] ?? 1;

      // Only flag if variance is meaningful (>20% swing)
      const hasSeasonality = peakMult - troughMult > 0.4;

      results.push({
        category,
        hasSeasonality,
        peakMonth: hasSeasonality ? MONTH_LABELS[peakIdx] : null,
        troughMonth: hasSeasonality ? MONTH_LABELS[troughIdx] : null,
        peakMultiplier: peakMult,
        troughMultiplier: troughMult,
        monthlyMultipliers: MONTH_LABELS.map((month, i) => ({
          month,
          multiplier: multipliers[i] ?? 0,
        })),
      });
    }

    const currentMonth = new Date().getMonth();
    const upcomingSpikes = results
      .filter((r) => r.hasSeasonality)
      .map((r) => {
        const nextHighMonth = r.monthlyMultipliers
          .map((m, i) => ({ ...m, idx: i }))
          .filter((m) => m.multiplier > 1.2 && m.idx > currentMonth)
          .sort((a, b) => a.idx - b.idx)[0];
        return nextHighMonth ? { category: r.category, month: nextHighMonth.month, multiplier: nextHighMonth.multiplier } : null;
      })
      .filter(Boolean)
      .slice(0, 5);

    return {
      categories: results,
      upcomingSpikes,
      hasEnoughData: results.length > 0,
    };
  }

  // ─── 13. Auto-Categorization ───────────────────────────────────────────────
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
