/** ORB-2973 - the date-time and URL grammar zod 3 read; a module of its own so the web entry, which installs the message map, does not load zod's schemas with it. */
import * as zod from 'zod';

const DATE = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`;
const TIME = String.raw`([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`;
const UTC_DATETIME = new RegExp(`^${DATE}T${TIME}(Z)$`);
const OFFSET_DATETIME = new RegExp(`^${DATE}T${TIME}(Z|([+-]\\d{2}:?\\d{2}))$`);

/** An ISO date-time as zod 3 read it: seconds may be left out, and with `offset` the offset may be written without a colon or reach `+99:99`; zod 4's own `.datetime()` refuses all three. */
export function isoDateTime(options: { offset?: boolean } = {}): zod.ZodCustomStringFormat<'datetime'> {
  return zod.stringFormat('datetime', options.offset ? OFFSET_DATETIME : UTC_DATETIME);
}

/** A URL as zod 3 read it: any string `new URL()` parses, returned untouched; `URL.canParse()` under zod 4 turns false for a Latin-1 host on Node 22.23.4 once the call is hot, and zod 4's own `.url()` trims the value and strips TAB, LF and CR. */
export function urlString(): zod.ZodCustomStringFormat<'url'> {
  return zod.stringFormat('url', (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
}
