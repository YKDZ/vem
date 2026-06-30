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
  weather: {
    temperatureCelsius: number;
    conditionText: string;
    observedAt: string;
  };
  sun: {
    sunriseAt: string;
    sunsetAt: string;
  };
};

export type ExternalNaturalEnvironmentProviderInput = {
  geoLocation: MachineGeoLocation;
  checkedAt: Date;
};

export interface ExternalNaturalEnvironmentProvider {
  fetch(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentProviderResult>;
}

export const EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER = Symbol(
  "EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER",
);

@Injectable()
export class UnconfiguredExternalNaturalEnvironmentProvider implements ExternalNaturalEnvironmentProvider {
  async fetch(): Promise<ExternalNaturalEnvironmentProviderResult> {
    throw new Error("External Natural Environment provider is not configured");
  }
}
