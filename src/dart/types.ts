export interface DartFinancials {
  corpCode: string;
  year: number;
  revenue?: number;
  grossProfit?: number;
  netIncome?: number;
  totalEquity?: number;
  totalLiabilities?: number;
  totalAssets?: number;
}

export interface DartAccountRow {
  account_id?: string;
  account_nm?: string;
  thstrm_amount?: string;
  sj_div?: string;
}
