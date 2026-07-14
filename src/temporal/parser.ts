export type LocalTemporalKind = "datetime" | "date" | "time";

export interface LocalTemporalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
}

type FormatField = "year" | "month" | "day" | "hour" | "minute" | "second" | "zoneHour" | "zoneMinute";
type FormatToken =
  | { kind: "field"; field: FormatField; width: number }
  | { kind: "literal"; value: string; quoted: boolean };

const isDigit = (value: string | undefined): boolean => value !== undefined && value >= "0" && value <= "9";

class TemporalParser {
  private offset = 0;

  constructor(private readonly input: string) {}

  digits(width: number): number | undefined {
    const start = this.offset;
    while (this.offset < this.input.length && this.offset - start < width && isDigit(this.input[this.offset])) {
      this.offset += 1;
    }
    if (this.offset - start !== width) return undefined;
    return Number(this.input.slice(start, this.offset));
  }

  fraction(maxWidth = 6): string | undefined {
    if (!this.consume(".")) return "";
    const start = this.offset;
    while (isDigit(this.input[this.offset])) this.offset += 1;
    const value = this.input.slice(start, this.offset);
    return value.length > 0 && value.length <= maxWidth ? value : undefined;
  }

  consume(value: string): boolean {
    if (!this.input.startsWith(value, this.offset)) return false;
    this.offset += value.length;
    return true;
  }

  remaining(): string {
    return this.input.slice(this.offset);
  }

  done(): boolean {
    return this.offset === this.input.length;
  }
}

const parseDate = (parser: TemporalParser): Pick<LocalTemporalParts, "year" | "month" | "day"> | undefined => {
  const year = parser.digits(4);
  if (year === undefined || !parser.consume("-")) return undefined;
  const month = parser.digits(2);
  if (month === undefined || !parser.consume("-")) return undefined;
  const day = parser.digits(2);
  return day === undefined ? undefined : { year, month, day };
};

const parseTime = (parser: TemporalParser): Pick<LocalTemporalParts, "hour" | "minute" | "second" | "fraction"> | undefined => {
  const hour = parser.digits(2);
  if (hour === undefined || !parser.consume(":")) return undefined;
  const minute = parser.digits(2);
  if (minute === undefined || !parser.consume(":")) return undefined;
  const second = parser.digits(2);
  if (second === undefined) return undefined;
  const fraction = parser.fraction();
  return fraction === undefined ? undefined : { hour, minute, second, fraction };
};

export const parseLocalTemporal = (input: string, kind: LocalTemporalKind): LocalTemporalParts | undefined => {
  const parser = new TemporalParser(input.trim());
  const date = kind === "time" ? { year: 2000, month: 1, day: 1 } : parseDate(parser);
  if (!date) return undefined;
  if (kind === "datetime" && !parser.consume("T") && !parser.consume(" ")) return undefined;
  const time = kind === "date" ? { hour: 0, minute: 0, second: 0, fraction: "" } : parseTime(parser);
  return time && parser.done() ? { ...date, ...time } : undefined;
};

const FORMAT_FIELDS: Array<[string, FormatField, number]> = [
  ["HH24", "hour", 2],
  ["YYYY", "year", 4],
  ["H24", "hour", 2],
  ["TZH", "zoneHour", 2],
  ["TZM", "zoneMinute", 2],
  ["MM", "month", 2],
  ["DD", "day", 2],
  ["MI", "minute", 2],
  ["SS", "second", 2],
];

const tokenizeFormat = (format: string): FormatToken[] | undefined => {
  const tokens: FormatToken[] = [];
  let offset = 0;
  while (offset < format.length) {
    if (format[offset] === '"') {
      const end = format.indexOf('"', offset + 1);
      if (end < 0) return undefined;
      tokens.push({ kind: "literal", value: format.slice(offset + 1, end), quoted: true });
      offset = end + 1;
      continue;
    }
    const field = FORMAT_FIELDS.find(([spelling]) => format.startsWith(spelling, offset));
    if (field) {
      tokens.push({ kind: "field", field: field[1], width: field[2] });
      offset += field[0].length;
      continue;
    }
    tokens.push({ kind: "literal", value: format[offset], quoted: false });
    offset += 1;
  }
  return tokens;
};

export type FormattedTemporalResult =
  | { ok: true; parts: LocalTemporalParts; zone: string | null }
  | { ok: false; reason: "invalidFormat" | "missingZoneFormat" | "unexpectedZoneFormat" | "invalidInput" };

export const parseFormattedTemporal = (
  input: string,
  format: string,
  requireZone: boolean,
): FormattedTemporalResult => {
  const tokens = tokenizeFormat(format);
  if (!tokens) return { ok: false, reason: "invalidFormat" };
  const hasZoneHour = tokens.some((token) => token.kind === "field" && token.field === "zoneHour");
  const hasZone = tokens.some((token) => token.kind === "field" && (token.field === "zoneHour" || token.field === "zoneMinute"));
  if (requireZone && !hasZoneHour) return { ok: false, reason: "missingZoneFormat" };
  if (!requireZone && hasZone) return { ok: false, reason: "unexpectedZoneFormat" };

  const parser = new TemporalParser(input);
  const values: Partial<Record<FormatField, number>> = {};
  let zoneSign = 1;
  for (const token of tokens) {
    if (token.kind === "literal") {
      if (token.quoted && !requireZone) continue;
      if (!parser.consume(token.value)) return { ok: false, reason: "invalidInput" };
      continue;
    }
    if (token.field === "zoneHour") {
      if (parser.consume("-")) zoneSign = -1;
      else parser.consume("+");
    }
    const value = parser.digits(token.width);
    if (value === undefined) return { ok: false, reason: "invalidInput" };
    values[token.field] = value;
  }

  const parts: LocalTemporalParts = {
    year: values.year ?? 2000,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
    fraction: "",
  };
  const zone = requireZone
    ? `${zoneSign < 0 ? "-" : "+"}${String(values.zoneHour).padStart(2, "0")}:${String(values.zoneMinute ?? 0).padStart(2, "0")}`
    : null;
  return { ok: true, parts, zone };
};

export const parseFixedOffsetHours = (input: string): number | undefined => {
  const parser = new TemporalParser(input.trim());
  let sign = 1;
  if (parser.consume("-")) sign = -1;
  else parser.consume("+");
  const first = parser.digits(1);
  if (first === undefined) return undefined;
  let hours = first;
  if (isDigit(parser.remaining()[0])) {
    const second = parser.digits(1);
    if (second === undefined) return undefined;
    hours = first * 10 + second;
  }
  let minutes = 0;
  if (parser.consume(":")) {
    const parsedMinutes = parser.digits(2);
    if (parsedMinutes === undefined) return undefined;
    minutes = parsedMinutes;
  } else if (parser.remaining().length === 2) {
    const parsedMinutes = parser.digits(2);
    if (parsedMinutes === undefined) return undefined;
    minutes = parsedMinutes;
  }
  if (!parser.done() || hours > 23 || minutes > 59) return undefined;
  return sign * (hours + minutes / 60);
};
