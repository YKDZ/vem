import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService);

  app.setGlobalPrefix("api");
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.use(helmet({ contentSecurityPolicy: false }));

  if (config.nodeEnv !== "production") {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("VEM Service API")
      .setDescription("Vending equipment management backend API")
      .setVersion("0.2.0")
      .addBearerAuth()
      .build();
    const documentFactory = () =>
      SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("api/docs", app, documentFactory, {
      jsonDocumentUrl: "api/docs-json",
    });
  }

  await app.listen(config.servicePort, config.serviceHost);
}

void bootstrap();
