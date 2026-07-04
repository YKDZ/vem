import { Injectable } from "@nestjs/common";

export type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};

export type ExternalNaturalEnvironmentProviderResult = {
  localTime: {
    timezone: string;
    localDate: string;
    localClock: string;
  };
  weather: ExternalNaturalEnvironmentWeather;
  sun: ExternalNaturalEnvironmentSun;
};

export type ExternalNaturalEnvironmentWeather = {
  temperatureCelsius: number;
  conditionText: string;
  conditionCode: string;
  observedAt: string;
  windScale?: number;
  windSpeedKph?: number;
};

export type ExternalNaturalEnvironmentSun = {
  sunriseAt: string;
  sunsetAt: string;
};

export type ExternalNaturalEnvironmentProviderInput = {
  geoLocation: MachineGeoLocation;
  checkedAt: Date;
};

export interface ExternalNaturalEnvironmentProvider {
  fetchWeatherNow(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentWeather>;
  fetchSun(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentSun>;
}

export const EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER = Symbol(
  "EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER",
);

@Injectable()
export class UnconfiguredExternalNaturalEnvironmentProvider implements ExternalNaturalEnvironmentProvider {
  async fetchWeatherNow(): Promise<ExternalNaturalEnvironmentWeather> {
    throw new Error("External Natural Environment provider is not configured");
  }

  async fetchSun(): Promise<ExternalNaturalEnvironmentSun> {
    throw new Error("External Natural Environment provider is not configured");
  }
}
