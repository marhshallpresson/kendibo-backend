// Money: internal authority is integer kobo (bigint). No floats.
// NGN 25,000 == 2_500_000n kobo. Adapters convert at the boundary:
// - Bachs.io wants decimal strings ("7000.00") + ISO currency — never minor units.

export type Kobo = bigint;
export const CURRENCY = 'NGN' as const;

export function nairaToKobo(naira: number | string): Kobo {
  const [whole, frac = ''] = String(naira).split('.');
  const koboStr = `${whole}${(frac + '00').slice(0, 2)}`;
  const v = BigInt(koboStr === '' ? '0' : koboStr);
  if (v <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  return v;
}

/** kobo -> Bachs decimal string e.g. 700000n -> "7000.00" */
export function koboToBachsDecimal(kobo: Kobo): string {
  if (kobo <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  const naira = kobo / 100n;
  const rem = kobo % 100n;
  return `${naira.toString()}.${rem.toString().padStart(2, '0')}`;
}

/** Bachs decimal string -> kobo e.g. "7000.00" -> 700000n */
export function bachsDecimalToKobo(decimal: string): Kobo {
  return nairaToKobo(decimal);
}


export function formatNaira(kobo: Kobo): string {
  const sign = kobo < 0n ? '-' : '';
  const abs = kobo < 0n ? -kobo : kobo;
  return `${sign}₦${(Number(abs) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}
