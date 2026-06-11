// Client-side datatype classes mirroring the `gel` (gel-js) driver's
// wire-compatible value types. These are intentionally minimal: enough to
// round-trip the values the sqlite-ts engine produces and to present the
// same surface (`.toString()` / `.toJSON()` / named accessors) the gel-js
// docs promise. Values are constructed by the result codec (codec.ts).

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");

export class LocalDate {
  constructor(
    public readonly year: number,
    public readonly month: number,
    public readonly day: number,
  ) {}

  toString(): string {
    return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
  }

  toJSON(): string {
    return this.toString();
  }

  static fromString(value: string): LocalDate | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    return new LocalDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
}

export class LocalTime {
  constructor(
    public readonly hour: number = 0,
    public readonly minute: number = 0,
    public readonly second: number = 0,
    public readonly millisecond: number = 0,
    public readonly microsecond: number = 0,
  ) {}

  toString(): string {
    const base = `${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}`;
    const micros = this.millisecond * 1000 + this.microsecond;
    return micros > 0 ? `${base}.${String(micros).padStart(6, "0").replace(/0+$/, "")}` : base;
  }

  toJSON(): string {
    return this.toString();
  }

  static fromString(value: string): LocalTime | null {
    const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
    if (!m) return null;
    const fraction = (m[4] ?? "").padEnd(6, "0");
    const millisecond = fraction ? Number(fraction.slice(0, 3)) : 0;
    const microsecond = fraction ? Number(fraction.slice(3, 6)) : 0;
    return new LocalTime(Number(m[1]), Number(m[2]), Number(m[3]), millisecond, microsecond);
  }
}

export class LocalDateTime {
  constructor(
    public readonly year: number,
    public readonly month: number,
    public readonly day: number,
    public readonly hour: number = 0,
    public readonly minute: number = 0,
    public readonly second: number = 0,
    public readonly millisecond: number = 0,
    public readonly microsecond: number = 0,
  ) {}

  toString(): string {
    const date = new LocalDate(this.year, this.month, this.day).toString();
    const time = new LocalTime(this.hour, this.minute, this.second, this.millisecond, this.microsecond).toString();
    return `${date}T${time}`;
  }

  toJSON(): string {
    return this.toString();
  }

  static fromString(value: string): LocalDateTime | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
    if (!m) return null;
    const fraction = (m[7] ?? "").padEnd(6, "0");
    const millisecond = fraction ? Number(fraction.slice(0, 3)) : 0;
    const microsecond = fraction ? Number(fraction.slice(3, 6)) : 0;
    return new LocalDateTime(
      Number(m[1]), Number(m[2]), Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
      millisecond, microsecond,
    );
  }
}

// Absolute duration (hours and below — the std::duration domain). The engine
// surfaces durations as strings; parsing accepts both ISO 8601 (`PT2H`) and
// the PG-style unit list the engine echoes (`2 hours 30 minutes`).
export class Duration {
  constructor(
    public readonly hours: number = 0,
    public readonly minutes: number = 0,
    public readonly seconds: number = 0,
    public readonly milliseconds: number = 0,
    public readonly microseconds: number = 0,
  ) {}

  get sign(): number {
    const total = this.hours || this.minutes || this.seconds || this.milliseconds || this.microseconds;
    return total === 0 ? 0 : total > 0 ? 1 : -1;
  }

  get blank(): boolean {
    return this.sign === 0;
  }

  toString(): string {
    if (this.blank) return "PT0S";
    const neg = this.sign < 0 ? "-" : "";
    let out = `${neg}PT`;
    if (this.hours) out += `${Math.abs(this.hours)}H`;
    if (this.minutes) out += `${Math.abs(this.minutes)}M`;
    const secs = Math.abs(this.seconds) + Math.abs(this.milliseconds) / 1e3 + Math.abs(this.microseconds) / 1e6;
    if (secs) out += `${secs}S`;
    return out;
  }

  toJSON(): string {
    return this.toString();
  }

  static fromString(value: string): Duration | null {
    const trimmed = value.trim();
    const iso = /^(-)?PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(trimmed);
    if (iso) {
      const sign = iso[1] ? -1 : 1;
      const rawSeconds = Number(iso[4] ?? 0);
      const seconds = Math.trunc(rawSeconds);
      const micros = Math.round((rawSeconds - seconds) * 1e6);
      return new Duration(
        sign * Number(iso[2] ?? 0),
        sign * Number(iso[3] ?? 0),
        sign * seconds,
        sign * Math.trunc(micros / 1000),
        sign * (micros % 1000),
      );
    }
    // PG-style: `2 hours`, `1 hour 30 minutes`, `90 seconds`, `00:02:03`, …
    const clock = /^(-)?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(trimmed);
    if (clock) {
      const sign = clock[1] ? -1 : 1;
      const fraction = (clock[5] ?? "").padEnd(6, "0");
      return new Duration(
        sign * Number(clock[2]),
        sign * Number(clock[3]),
        sign * Number(clock[4]),
        fraction ? sign * Number(fraction.slice(0, 3)) : 0,
        fraction ? sign * Number(fraction.slice(3, 6)) : 0,
      );
    }
    const unitPattern = /(-?\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|milliseconds?|ms|microseconds?|us)\b/gi;
    let matched = false;
    let hours = 0, minutes = 0, seconds = 0, milliseconds = 0, microseconds = 0;
    for (const m of trimmed.matchAll(unitPattern)) {
      matched = true;
      const amount = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit.startsWith("ho") || unit === "h" || unit.startsWith("hr")) hours += amount;
      else if (unit.startsWith("mi") && !unit.startsWith("mic") && unit !== "milliseconds" && unit !== "millisecond" || unit === "m") minutes += amount;
      else if (unit.startsWith("milli") || unit === "ms") milliseconds += amount;
      else if (unit.startsWith("micro") || unit === "us") microseconds += amount;
      else if (unit.startsWith("se") || unit === "s") seconds += amount;
    }
    if (!matched) return null;
    return new Duration(hours, minutes, seconds, milliseconds, microseconds);
  }
}

// Relative duration (`cal::relative_duration`) — may carry months/days that
// have no fixed absolute length.
export class RelativeDuration {
  constructor(
    public readonly years: number = 0,
    public readonly months: number = 0,
    public readonly weeks: number = 0,
    public readonly days: number = 0,
    public readonly hours: number = 0,
    public readonly minutes: number = 0,
    public readonly seconds: number = 0,
  ) {}

  toString(): string {
    let out = "P";
    if (this.years) out += `${this.years}Y`;
    if (this.months) out += `${this.months}M`;
    if (this.weeks) out += `${this.weeks}W`;
    if (this.days) out += `${this.days}D`;
    if (this.hours || this.minutes || this.seconds) {
      out += "T";
      if (this.hours) out += `${this.hours}H`;
      if (this.minutes) out += `${this.minutes}M`;
      if (this.seconds) out += `${this.seconds}S`;
    }
    return out === "P" ? "PT0S" : out;
  }

  toJSON(): string {
    return this.toString();
  }
}

export class DateDuration {
  constructor(
    public readonly years: number = 0,
    public readonly months: number = 0,
    public readonly weeks: number = 0,
    public readonly days: number = 0,
  ) {}

  toString(): string {
    let out = "P";
    if (this.years) out += `${this.years}Y`;
    if (this.months) out += `${this.months}M`;
    if (this.weeks) out += `${this.weeks}W`;
    if (this.days) out += `${this.days}D`;
    return out === "P" ? "PT0S" : out;
  }

  toJSON(): string {
    return this.toString();
  }
}
