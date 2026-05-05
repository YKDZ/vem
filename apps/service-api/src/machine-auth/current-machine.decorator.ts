import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export type AuthenticatedMachine = {
  id: string;
  code: string;
  status: "online" | "offline" | "maintenance" | "disabled";
};

export const CurrentMachine = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedMachine => {
    const request = context
      .switchToHttp()
      .getRequest<{ machine?: AuthenticatedMachine }>();
    if (!request.machine) {
      throw new Error("CurrentMachine used without MachineAuthGuard");
    }
    return request.machine;
  },
);
