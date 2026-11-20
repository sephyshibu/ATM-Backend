import "reflect-metadata"

import { Logger, ValidationPipe } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import type { NestExpressApplication } from "@nestjs/platform-express"
import cookieParser from "cookie-parser"
import helmet from "helmet"

import { AppModule } from "./app.module"
import { API_PREFIX, appConfig } from "./config"

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  const config = appConfig()

  // Behind a load balancer the client's address is in X-Forwarded-For.
  app.set("trust proxy", 1)
  app.use(helmet())
  app.use(cookieParser())
  app.enableCors({ origin: config.frontendUrl, credentials: true })
  app.setGlobalPrefix(API_PREFIX)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  app.enableShutdownHooks()

  await app.listen(config.port)
  const log = new Logger("ATM CRM")
  log.log(`API on http://localhost:${config.port}/${API_PREFIX} (${config.appEnv})`)
  if (!config.google.clientId || !config.google.clientSecret) log.warn("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is empty: Google sign-in won't work until both are set.")
  else log.log(`Google sign-in returns to ${config.google.callbackUrl} (add it to the OAuth client's Authorised redirect URIs).`)
}

void bootstrap()
