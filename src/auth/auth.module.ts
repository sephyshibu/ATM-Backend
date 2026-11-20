import { Global, Module } from "@nestjs/common"

import { AccessService } from "./access.service"
import { AuthController } from "./auth.controller"
import { AuthService } from "./auth.service"
import { GoogleService } from "./google.service"
import { SessionService } from "./session.service"

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, GoogleService, SessionService, AccessService],
  exports: [SessionService, AccessService],
})
export class AuthModule {}
