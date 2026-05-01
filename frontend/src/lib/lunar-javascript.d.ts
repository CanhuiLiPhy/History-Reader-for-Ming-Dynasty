// Minimal type shim for lunar-javascript. The package is plain JS; we only
// need a tiny surface (Lunar.fromYmd → object with getDayInGanZhi /
// getDayInChinese / getSolar). Negative month means leap month per the lib's
// convention.
declare module "lunar-javascript" {
  export class Solar {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
    static fromYmd(year: number, month: number, day: number): Solar;
    getLunar(): Lunar;
  }
  export class Lunar {
    static fromYmd(year: number, month: number, day: number): Lunar;
    getDayInGanZhi(): string;
    getDayInChinese(): string;
    getSolar(): Solar;
    toString(): string;
  }
  export class LunarYear {
    static fromYear(year: number): LunarYear;
    getLeapMonth(): number;
  }
}
