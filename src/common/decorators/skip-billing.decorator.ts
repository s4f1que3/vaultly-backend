import { SetMetadata } from '@nestjs/common';

export const SKIP_BILLING_KEY = 'skipBilling';
export const SkipBillingCheck = () => SetMetadata(SKIP_BILLING_KEY, true);
