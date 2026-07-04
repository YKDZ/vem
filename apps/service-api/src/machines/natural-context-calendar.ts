import { Solar } from "lunar-javascript";

export type Festival =
  | "spring_festival"
  | "new_years_day"
  | "lantern_festival"
  | "valentines_day"
  | "qixi_festival"
  | "labor_day"
  | "dragon_boat_festival"
  | "mid_autumn_festival"
  | "national_day";

export type SolarTerm =
  | "minor_cold"
  | "major_cold"
  | "start_of_spring"
  | "rain_water"
  | "awakening_of_insects"
  | "spring_equinox"
  | "clear_and_bright"
  | "grain_rain"
  | "start_of_summer"
  | "grain_buds"
  | "grain_in_ear"
  | "summer_solstice"
  | "minor_heat"
  | "major_heat"
  | "start_of_autumn"
  | "end_of_heat"
  | "white_dew"
  | "autumn_equinox"
  | "cold_dew"
  | "frost_descent"
  | "start_of_winter"
  | "minor_snow"
  | "major_snow"
  | "winter_solstice";

export type CalendarContext = {
  status: "ready";
  localDate: string;
  festivals: Festival[];
  primaryFestival: Festival | null;
  solarTerm: SolarTerm | null;
};

const FIXED_DATE_FESTIVALS: Record<string, Festival[]> = {
  "01-01": ["new_years_day"],
  "02-14": ["valentines_day"],
  "05-01": ["labor_day"],
  "10-01": ["national_day"],
};

const FESTIVAL_PRIORITY: Festival[] = [
  "spring_festival",
  "national_day",
  "mid_autumn_festival",
  "new_years_day",
  "lantern_festival",
  "qixi_festival",
  "valentines_day",
  "dragon_boat_festival",
  "labor_day",
];

const LUNAR_FESTIVALS_BY_MONTH_DAY: Record<string, Festival[]> = {
  "1-1": ["spring_festival"],
  "1-15": ["lantern_festival"],
  "5-5": ["dragon_boat_festival"],
  "7-7": ["qixi_festival"],
  "8-15": ["mid_autumn_festival"],
};

const SOLAR_TERM_BY_NAME: Record<string, SolarTerm> = {
  小寒: "minor_cold",
  大寒: "major_cold",
  立春: "start_of_spring",
  雨水: "rain_water",
  惊蛰: "awakening_of_insects",
  春分: "spring_equinox",
  清明: "clear_and_bright",
  谷雨: "grain_rain",
  立夏: "start_of_summer",
  小满: "grain_buds",
  芒种: "grain_in_ear",
  夏至: "summer_solstice",
  小暑: "minor_heat",
  大暑: "major_heat",
  立秋: "start_of_autumn",
  处暑: "end_of_heat",
  白露: "white_dew",
  秋分: "autumn_equinox",
  寒露: "cold_dew",
  霜降: "frost_descent",
  立冬: "start_of_winter",
  小雪: "minor_snow",
  大雪: "major_snow",
  冬至: "winter_solstice",
};

export function calendarContextForLocalDate(
  localDate: string,
): CalendarContext {
  const [year, month, day] = localDate.split("-").map(Number);
  const lunar = Solar.fromYmd(year, month, day).getLunar();
  const monthDay = localDate.slice(5);
  const lunarMonthDay = `${lunar.getMonth()}-${lunar.getDay()}`;
  const festivals = [
    ...(FIXED_DATE_FESTIVALS[monthDay] ?? []),
    ...(LUNAR_FESTIVALS_BY_MONTH_DAY[lunarMonthDay] ?? []),
  ];
  const solarTermName = lunar.getJieQi();
  const orderedFestivals = FESTIVAL_PRIORITY.filter((festival) =>
    festivals.includes(festival),
  );
  return {
    status: "ready",
    localDate,
    festivals: orderedFestivals,
    primaryFestival: orderedFestivals[0] ?? null,
    solarTerm: solarTermName
      ? (SOLAR_TERM_BY_NAME[solarTermName] ?? null)
      : null,
  };
}
