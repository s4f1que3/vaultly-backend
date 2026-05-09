import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

interface DebtInput {
  id: string;
  name: string;
  balance: number;
  interest_rate: number;
  minimum_payment: number;
}

@Injectable()
export class DebtsService {
  constructor(private readonly supabase: SupabaseService) {}

  private round2(n: number) { return Math.round(n * 100) / 100; }

  async calculatePayoff(userId: string, monthlyBudget: number, strategy: 'avalanche' | 'snowball') {
    const { data, error } = await this.supabase.db
      .from('liabilities')
      .select('*')
      .eq('user_id', userId);

    if (error) throw new BadRequestException(error.message);
    const liabilities = (data ?? []) as DebtInput[];

    if (!liabilities.length) return {
      strategy, monthlyBudget, payoffMonths: 0, payoffDate: new Date().toISOString().split('T')[0],
      totalInterestPaid: 0, totalPaid: 0, schedule: [], debtOrder: [],
    };

    const minPaymentsTotal = liabilities.reduce((s, d) => s + d.minimum_payment, 0);
    if (monthlyBudget < minPaymentsTotal) {
      throw new BadRequestException(
        `Budget ($${monthlyBudget}) is less than minimum payments total ($${minPaymentsTotal.toFixed(2)})`,
      );
    }

    // Work on copies
    const debts = liabilities.map((d) => ({ ...d, balance: d.balance }));

    // Sort by strategy
    if (strategy === 'avalanche') {
      debts.sort((a, b) => b.interest_rate - a.interest_rate);
    } else {
      debts.sort((a, b) => a.balance - b.balance);
    }

    const schedule: {
      month: number; label: string; totalBalance: number; totalPaid: number;
      debts: { id: string; name: string; balance: number; payment: number; interest: number }[];
    }[] = [];
    const debtOrder: { id: string; name: string; payoffMonth: number; payoffLabel: string }[] = [];

    let month = 0;
    let totalInterestPaid = 0;
    let totalPaid = 0;
    const now = new Date();

    while (debts.some((d) => d.balance > 0) && month < 600) {
      month++;
      const date = new Date(now.getFullYear(), now.getMonth() + month, 1);
      const label = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      let remaining = monthlyBudget;
      const monthDebts: typeof schedule[0]['debts'] = [];

      // Pay minimum on all non-priority debts first
      for (const debt of debts) {
        if (debt.balance <= 0) continue;
        const interest = this.round2((debt.balance * (debt.interest_rate / 100)) / 12);
        const minPay = Math.min(debt.minimum_payment, debt.balance + interest);
        debt.balance = this.round2(Math.max(0, debt.balance + interest - minPay));
        remaining -= minPay;
        totalInterestPaid += interest;
        totalPaid += minPay;
        monthDebts.push({ id: debt.id, name: debt.name, balance: debt.balance, payment: minPay, interest });
      }

      // Apply extra to first priority debt (highest interest / lowest balance)
      const targetDebt = debts.find((d) => d.balance > 0);
      if (targetDebt && remaining > 0) {
        const extra = Math.min(remaining, targetDebt.balance);
        targetDebt.balance = this.round2(Math.max(0, targetDebt.balance - extra));
        totalPaid += extra;
        const entry = monthDebts.find((d) => d.id === targetDebt.id);
        if (entry) { entry.payment += extra; entry.balance = targetDebt.balance; }
      }

      // Track payoffs
      for (const debt of debts) {
        if (debt.balance <= 0 && !debtOrder.find((d) => d.id === debt.id)) {
          debtOrder.push({ id: debt.id, name: debt.name, payoffMonth: month, payoffLabel: label });
        }
      }

      const totalBalance = this.round2(debts.reduce((s, d) => s + d.balance, 0));
      schedule.push({ month, label, totalBalance, totalPaid: this.round2(totalPaid), debts: monthDebts });
    }

    const payoffDate = new Date(now.getFullYear(), now.getMonth() + month + 1, 1);

    return {
      strategy,
      monthlyBudget,
      payoffMonths: month,
      payoffDate: payoffDate.toISOString().split('T')[0],
      totalInterestPaid: this.round2(totalInterestPaid),
      totalPaid: this.round2(totalPaid),
      schedule: schedule.slice(0, 120), // cap at 10 years for display
      debtOrder,
    };
  }
}
