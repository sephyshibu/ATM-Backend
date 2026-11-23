import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { APP_GUARD } from "@nestjs/core"
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler"

import { AuditModule } from "./audit/audit.module"
import { AuthModule } from "./auth/auth.module"
import { CsrfMiddleware } from "./common/csrf.middleware"
import { SessionGuard } from "./common/guards/session.guard"
import { HealthController } from "./health/health.controller"
import { MailModule } from "./mail/mail.module"
import { PrismaModule } from "./prisma/prisma.module"
import { RecordsModule } from "./records/records.module"
import { RolesModule } from "./roles/roles.module"
import { SettingsModule } from "./settings/settings.module"
import { UsersModule } from "./users/users.module"

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    PrismaModule,
    AuditModule,
    MailModule,
    AuthModule,
    UsersModule,
    RolesModule,
    SettingsModule,
    RecordsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limits first, then sign-in and permissions on every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CsrfMiddleware).forRoutes("{*splat}")
  }
}
